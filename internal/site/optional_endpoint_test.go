package site

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
)

// #187: Optional site endpoints (/api/studio/canvas-assistant, /api/studio/analyze-style)
// must negative-cache 403/404 within a client session so callers immediately fall back
// to /api/ai/chat without repeatedly hitting the server.
func TestOptionalEndpointsNegativeCache403And404(t *testing.T) {
	t.Setenv("HANDRAW_HOME", t.TempDir())
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token_187")
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	var assistantHits atomic.Int32
	var analyzeHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/studio/canvas-assistant":
			assistantHits.Add(1)
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"code":"token_scope_denied","error":"token_scope_denied"}`))
		case "/api/studio/analyze-style":
			analyzeHits.Add(1)
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"ok":false,"code":"not_found","error":"接口不存在"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := NewWithBase(srv.URL, "v0.6.8-test")

	for i := 0; i < 3; i++ {
		_, err := c.CanvasAssistant(context.Background(), map[string]any{"prompt": "画一张手绘咖啡馆"})
		var ae *APIError
		if !errors.As(err, &ae) || ae.Status != 403 {
			t.Fatalf("call %d CanvasAssistant: want APIError 403, got %v", i+1, err)
		}
	}
	if got := assistantHits.Load(); got != 1 {
		t.Fatalf("expected CanvasAssistant to hit server once and cache 403, got %d hits", got)
	}

	for i := 0; i < 3; i++ {
		_, err := c.AnalyzeStyle(context.Background(), []string{"data:image/png;base64,abc"}, "style")
		var ae *APIError
		if !errors.As(err, &ae) || ae.Status != 404 {
			t.Fatalf("call %d AnalyzeStyle: want APIError 404, got %v", i+1, err)
		}
	}
	if got := analyzeHits.Load(); got != 1 {
		t.Fatalf("expected AnalyzeStyle to hit server once and cache 404, got %d hits", got)
	}
}
