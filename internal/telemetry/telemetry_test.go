package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

func TestTelemetryFlushAndSanitize(t *testing.T) {
	var mu sync.Mutex
	var gotAuth string
	var gotPayload batchPayload
	calls := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/analytics/events" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		calls++
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotPayload)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"accepted":2}`))
	}))
	defer srv.Close()

	c := New("v0.6.2")
	c.SiteBase = func() string { return srv.URL }
	c.AnonID = func() string { return "dc_testdevice01" }
	c.Token = func() string { return "tok_secret_123" }
	c.Enabled = func() bool { return true }

	// Unknown event must be ignored; sensitive props must be stripped.
	c.Track("evil_unknown_event", map[string]any{"x": 1})
	c.Track("client_launch", map[string]any{
		"loggedIn":      true,
		"prompt":        "must-not-leave-machine",
		"user_prompt":   "must-also-be-blocked",
		"access_token":  "tok-must-block",
		"client_secret": "sec-must-block",
		"apiKey":        "sk-12345",
		"worksDir":      "C:\\Users\\secret",
		"note":          strings.Repeat("手绘风测试", 25), // 125 runes (> 80)
	})
	c.Track("client_generate_done", map[string]any{
		"providerMode": "byok",
		"ok":           true,
		"count":        2,
	})

	c.Flush(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("expected 1 POST call, got %d", calls)
	}
	if gotAuth != "Bearer tok_secret_123" {
		t.Fatalf("unexpected Authorization header: %q", gotAuth)
	}
	if gotPayload.AnonymousID != "dc_testdevice01" || !gotPayload.LinkAnon {
		t.Fatalf("unexpected envelope: %+v", gotPayload)
	}
	if len(gotPayload.Events) != 2 {
		t.Fatalf("expected 2 allowlisted events, got %d", len(gotPayload.Events))
	}
	ev0 := gotPayload.Events[0]
	if ev0.Event != "client_launch" || ev0.Channel != "desktop_client" || ev0.DeviceType != "desktop" {
		t.Fatalf("unexpected first event: %+v", ev0)
	}
	if ev0.Props["appVersion"] != "0.6.2" || ev0.Props["os"] != runtime.GOOS || ev0.Props["arch"] != runtime.GOARCH {
		t.Fatalf("missing runtime metadata in props: %+v", ev0.Props)
	}
	for _, bad := range []string{"prompt", "user_prompt", "access_token", "client_secret", "apiKey", "worksDir"} {
		if _, exists := ev0.Props[bad]; exists {
			t.Fatalf("sensitive prop %q leaked into payload", bad)
		}
	}
	if note, ok := ev0.Props["note"].(string); !ok || !utf8.ValidString(note) || utf8.RuneCountInString(note) != 80 {
		t.Fatalf("expected valid 80-rune UTF-8 string, got valid=%v runes=%d val=%q", utf8.ValidString(note), utf8.RuneCountInString(note), note)
	}
}

func TestTelemetryOptOutSendsZeroRequests(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(200)
	}))
	defer srv.Close()

	enabled := false
	c := New("v0.6.2")
	c.SiteBase = func() string { return srv.URL }
	c.AnonID = func() string { return "dc_optout" }
	c.Enabled = func() bool { return enabled }

	c.Track("client_launch", map[string]any{"loggedIn": false})
	c.Flush(context.Background())
	if calls != 0 {
		t.Fatalf("opt-out must send 0 requests, got %d", calls)
	}
}
