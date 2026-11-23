package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

func TestHostChatAndDesktopChatUseUnifiedSiteAIGateway(t *testing.T) {
	var aiCalls atomic.Int32
	var sawModelField atomic.Bool
	var lastCap string

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/ai/chat":
			aiCalls.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if _, hasModel := body["model"]; hasModel {
				sawModelField.Store(true)
			}
			lastCap, _ = body["capability"].(string)
			_, _ = w.Write([]byte(`{"ok":true,"capability":"` + lastCap + `","service":"智能文字服务","content":"这是网站统一网关的回复","text":"这是网站统一网关的回复","toolCalls":[],"finishReason":"stop"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_studio")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.DefaultTextModel = "site:auto"
		st.DefaultVisionModel = "site:auto"
		return nil
	})
	h := srv.Handler()

	// 1. Plugin unified gateway (/api/host/models/chat) uses official /api/ai/chat first.
	rrHost := doReq(t, h, srv.Token, "POST", "/api/host/models/chat", map[string]any{
		"capability": "text",
		"messages":   []map[string]any{{"role": "user", "content": "你好"}},
	})
	if rrHost.Code != 200 || !strings.Contains(rrHost.Body.String(), `"source":"site"`) || !strings.Contains(rrHost.Body.String(), "网站统一网关的回复") {
		t.Fatalf("hostModelsChat failed: %d %s", rrHost.Code, rrHost.Body.String())
	}

	// 2. Desktop chat turn (/api/chat/turn) uses official /api/ai/chat first.
	rrChat := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages": []map[string]any{{"role": "user", "content": "帮我构思一张雨夜咖啡馆插画"}},
	})
	if rrChat.Code != 200 || !strings.Contains(rrChat.Body.String(), `"source":"site"`) || !strings.Contains(rrChat.Body.String(), `"textModel":"site:text"`) {
		t.Fatalf("chatTurn failed: %d %s", rrChat.Code, rrChat.Body.String())
	}

	if aiCalls.Load() < 2 {
		t.Fatalf("expected >= 2 calls to /api/ai/chat, got %d", aiCalls.Load())
	}
	if sawModelField.Load() {
		t.Fatal("client must never send concrete model name to /api/ai/chat")
	}
}
