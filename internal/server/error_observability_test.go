package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/yang0/handraw-client/internal/telemetry"
)

// #194: Verify full-pipeline error capture hooks:
// 1. /files/remote 403 host rejection emits media_proxy_err with host-only domain.
// 2. Inspiration clip download failure emits clip_image_fail; piggybacked extension
//    error emits clipper_fail.
// 3. /api/telemetry/event forwards frontend severity + domain cleanly.
func TestFullPipelineErrorObservability(t *testing.T) {
	srv, _ := setupTestServer(t, "https://handraw-style.com")
	tel := telemetry.New("0.6.12")
	tel.Enabled = func() bool { return true }
	srv.Telemetry = tel
	h := srv.Handler()

	// 1. /files/remote rejecting third-party host -> media_proxy_err with domain="pbs.twimg.com".
	rrRemote := doReq(t, h, srv.Token, http.MethodGet,
		"/files/remote?url="+url.QueryEscape("https://pbs.twimg.com/media/secret123.jpg?name=large&token=xyz"), nil)
	if rrRemote.Code != http.StatusForbidden {
		t.Fatalf("expected /files/remote third-party host to return 403, got %d", rrRemote.Code)
	}

	// 2. Inspiration clip with failing upstream image + piggybacked lastClipError.
	badImg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer badImg.Close()
	rrClip := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/clip", map[string]any{
		"title":         "X 监控测试",
		"imageUrl":      badImg.URL + "/media/foo.jpg",
		"prompt":        "watercolor fox",
		"sourceChannel": "x",
		"autoOrganize":  false,
		"lastClipError": map[string]any{
			"channel": "x",
			"reason":  "本地接口响应超时",
		},
	})
	if rrClip.Code != 200 {
		t.Fatalf("clip failed: %d %s", rrClip.Code, rrClip.Body.String())
	}

	// 3. Frontend media_broken event through /api/telemetry/event preserves severity + domain.
	rrTel := doReq(t, h, srv.Token, http.MethodPost, "/api/telemetry/event", map[string]any{
		"event": "client_error",
		"props": map[string]any{
			"category": "media_broken",
			"severity": "warn",
			"route":    "external_media",
			"location": "#inspirations",
			"domain":   "https://pbs.twimg.com/media/abc.jpg?name=large",
			"message":  "img load failed (external_media · pbs.twimg.com)",
		},
	})
	if rrTel.Code != 200 {
		t.Fatalf("/api/telemetry/event failed: %d %s", rrTel.Code, rrTel.Body.String())
	}

	// Flush telemetry into a mock analytics server to inspect exact emitted payloads.
	var received []map[string]any
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch struct {
			Events []map[string]any `json:"events"`
		}
		_ = decode(r, &batch)
		received = append(received, batch.Events...)
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer collector.Close()
	tel.SiteBase = func() string { return collector.URL }
	tel.AnonID = func() string { return "dc_test_194" }
	tel.Flush(t.Context())

	seen := map[string]map[string]any{}
	for _, ev := range received {
		if ev["event"] == "client_error" {
			props, _ := ev["props"].(map[string]any)
			cat, _ := props["category"].(string)
			seen[cat] = props
		}
	}
	for _, want := range []string{"media_proxy_err", "clip_image_fail", "clipper_fail", "media_broken"} {
		if _, ok := seen[want]; !ok {
			t.Fatalf("missing expected client_error category %q; got %+v", want, seen)
		}
	}
	if seen["media_proxy_err"]["domain"] != "pbs.twimg.com" || seen["media_proxy_err"]["severity"] != "warn" {
		t.Fatalf("unexpected media_proxy_err props: %+v", seen["media_proxy_err"])
	}
	if seen["media_broken"]["domain"] != "pbs.twimg.com" || seen["media_broken"]["severity"] != "warn" {
		t.Fatalf("unexpected media_broken props: %+v", seen["media_broken"])
	}
}
