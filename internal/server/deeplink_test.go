package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type spyHost struct {
	nopHost
	shown int
}

func (h *spyHost) ShowMain() { h.shown++ }

func TestHandleDeepLinkStudioAndPendingPickup(t *testing.T) {
	srv := New("test")
	host := &spyHost{}
	srv.Host = host

	srv.HandleDeepLink("handraw://studio?style=fa-013&layout=SC-001&color=c-01&theme=%E7%8C%AB%E5%92%AA%E5%96%9D%E5%92%96%E5%95%A1")
	if host.shown != 1 {
		t.Fatalf("expected ShowMain called once, got %d", host.shown)
	}

	h := srv.Handler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/deeplink/pending", nil)
	req.Header.Set("X-Handraw-Token", srv.Token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Pending *DeepLinkIntent `json:"pending"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Pending == nil {
		t.Fatalf("expected pending intent, got nil")
	}
	if resp.Pending.Action != "studio" || resp.Pending.Style != "FA-013" || resp.Pending.Layout != "SC-001" || resp.Pending.Color != "C-01" || resp.Pending.Theme != "猫咪喝咖啡" {
		t.Fatalf("unexpected pending intent: %+v", resp.Pending)
	}

	// Second read must return nil (consumed once).
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req)
	var resp2 struct {
		Pending *DeepLinkIntent `json:"pending"`
	}
	if err := json.Unmarshal(rr2.Body.Bytes(), &resp2); err != nil {
		t.Fatalf("unmarshal 2: %v", err)
	}
	if resp2.Pending != nil {
		t.Fatalf("expected nil after consume, got %+v", resp2.Pending)
	}
}

func TestHandleDeepLinkAssetAndSanitization(t *testing.T) {
	tests := []struct {
		raw      string
		wantKind string
		wantCode string
	}{
		{"handraw://asset?code=fa-013", "asset", "FA-013"},
		{"handraw://style/FA-001", "asset", "FA-001"},
		{"handraw://layout/sc-005", "asset", "SC-005"},
		{"handraw://asset?code=%3Cscript%3Ealert(1)%3C/script%3E", "", ""},
		{"https://evil.example/studio?style=FA-001", "", ""},
		{"handraw://auth?ok=1", "auth", ""},
	}
	for _, tc := range tests {
		kind, intent := parseDeepLink(tc.raw)
		if kind != tc.wantKind {
			t.Errorf("parseDeepLink(%q) kind = %q, want %q", tc.raw, kind, tc.wantKind)
			continue
		}
		if tc.wantCode != "" {
			if intent == nil || intent.Code != tc.wantCode {
				t.Errorf("parseDeepLink(%q) code = %+v, want %q", tc.raw, intent, tc.wantCode)
			}
		}
	}

	// Theme length cap & percent-encoded control-character stripping
	longTheme := "hi%00%07" + strings.Repeat("画", 600)
	kind, intent := parseDeepLink("handraw://studio?theme=" + longTheme)
	if kind != "studio" || intent == nil {
		t.Fatalf("expected studio intent")
	}
	if len([]rune(intent.Theme)) > 500 || strings.ContainsAny(intent.Theme, "\x00\x07") {
		t.Fatalf("theme not sanitized/truncated properly: len=%d", len([]rune(intent.Theme)))
	}
	// Raw control chars in URL are safely rejected by url.Parse
	if badKind, badIntent := parseDeepLink("handraw://studio?theme=hi\x00bad"); badKind != "" || badIntent != nil {
		t.Fatalf("expected raw control char URL rejected, got %q %+v", badKind, badIntent)
	}
}
