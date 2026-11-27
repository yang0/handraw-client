package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
)

// #187: When /api/v1/community/resources fails while logged in, the fallback to
// /api/boot?surface=catalog must NOT send Authorization: Bearer hwt_... because
// /api/boot is web-session-only and rejects hwt_ tokens with 403 token_scope_denied.
func TestCommunityCatalogBootFallbackOmitsBearerToken(t *testing.T) {
	var bootHits atomic.Int32
	var bootGotAuth string

	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/community/resources":
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"ok":false,"error":"temporarily unavailable"}`))
		case "/api/boot":
			bootHits.Add(1)
			bootGotAuth = r.Header.Get("Authorization")
			if bootGotAuth != "" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"ok":false,"code":"token_scope_denied","error":"token_scope_denied"}`))
				return
			}
			fmt.Fprint(w, `{"communityResources":[{"code":"CMM-187","kind":"style","name":"水彩测试风","author":"tester","unlockCost":2,"image":"/images/test.webp"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer mock.Close()

	srv, _ := setupTestServer(t, mock.URL)
	if err := secrets.Set(secrets.SiteToken, "hwt_logged_in_187"); err != nil {
		t.Fatalf("set test site token: %v", err)
	}
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	if !srv.Site.LoggedIn() {
		t.Fatalf("expected test server to be logged in before fallback check")
	}

	snap := srv.communityCatalog(context.Background(), true)
	if bootHits.Load() != 1 {
		t.Fatalf("expected 1 fallback call to /api/boot, got %d", bootHits.Load())
	}
	if bootGotAuth != "" {
		t.Fatalf("fallback to /api/boot leaked Authorization header: %q", bootGotAuth)
	}
	if len(snap.Styles) != 1 || snap.Styles[0].Number != "CMM-187" {
		t.Fatalf("expected 1 style CMM-187 from public boot fallback, got %+v", snap.Styles)
	}
}
