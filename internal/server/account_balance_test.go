package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
)

func TestAccountBalancePreservesLoggedInOnScopeOrNetworkError(t *testing.T) {
	var mode atomic.Int32
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/tokens" {
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
			return
		}
		if r.URL.Path != "/api/economy" {
			http.NotFound(w, r)
			return
		}
		switch mode.Load() {
		case 0: // 403 token_scope_denied (website #326 not deployed yet)
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":  "token_scope_denied",
				"error": "token_scope_denied",
			})
		case 1: // live website /api/economy payload
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"cash": map[string]any{
					"balanceCents":    1230,
					"heldCents":       100,
					"availableMicros": 12300000,
				},
				"points": 265,
				"earnings": map[string]any{
					"pending": 20,
					"settled": 80,
				},
				"freeQuota": []map[string]any{
					{"resolution": "1k", "remaining": 8, "total": 10},
					{"resolution": "2k", "remaining": 2, "total": 2},
				},
				"aiBonus": map[string]any{
					"availableMicros": 2000000,
					"balanceMicros":   2000000,
					"eligibility":     "claimed",
				},
			})
		case 2: // transient 503 should serve cached economy
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "upstream down"})
		case 3: // 401 expires token and clears cache
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": "unauthorized", "error": "expired"})
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	h := srv.Handler()

	type balResp struct {
		LoggedIn    bool           `json:"loggedIn"`
		Offline     bool           `json:"offline"`
		Unavailable bool           `json:"unavailable"`
		ScopeDenied bool           `json:"scopeDenied"`
		Expired     bool           `json:"expired"`
		Code        string         `json:"code"`
		Error       string         `json:"error"`
		Economy     map[string]any `json:"economy"`
	}
	getBalance := func() balResp {
		t.Helper()
		rr := doReq(t, h, srv.Token, "GET", "/api/account/balance", nil)
		if rr.Code != http.StatusOK {
			t.Fatalf("balance HTTP %d: %s", rr.Code, rr.Body.String())
		}
		var out balResp
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// Not logged in
	if got := getBalance(); got.LoggedIn {
		t.Fatalf("expected loggedIn=false before token set: %+v", got)
	}

	if err := secrets.Set(secrets.SiteToken, "hwt_test_user"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	// 403 token_scope_denied without cache must still report loggedIn=true
	mode.Store(0)
	got := getBalance()
	if !got.LoggedIn || !got.Unavailable || !got.ScopeDenied || got.Code != "token_scope_denied" {
		t.Fatalf("expected loggedIn=true + scopeDenied=true on 403, got: %+v", got)
	}

	// Valid /api/economy payload populates cache and returns full fields
	mode.Store(1)
	got = getBalance()
	if !got.LoggedIn || got.Unavailable || got.Offline || got.Economy == nil {
		t.Fatalf("expected live economy payload, got: %+v", got)
	}
	if pts, _ := got.Economy["points"].(float64); pts != 265 {
		t.Fatalf("expected points=265, got: %v", got.Economy["points"])
	}

	// 503 falls back to offline cache
	mode.Store(2)
	got = getBalance()
	if !got.LoggedIn || !got.Offline || got.Economy == nil {
		t.Fatalf("expected offline cached economy on 503, got: %+v", got)
	}

	// Logout clears cache; subsequent 403 must NOT return stale empty {} cache as offline
	rr := doReq(t, h, srv.Token, "POST", "/api/account/logout", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("logout HTTP %d: %s", rr.Code, rr.Body.String())
	}
	if err := secrets.Set(secrets.SiteToken, "hwt_test_user"); err != nil {
		t.Fatal(err)
	}
	mode.Store(0)
	got = getBalance()
	if !got.LoggedIn || got.Offline || !got.Unavailable {
		t.Fatalf("expected unavailable (no stale empty cache) after logout, got: %+v", got)
	}

	// 401 invalidates token and reports loggedIn=false + expired=true
	mode.Store(3)
	got = getBalance()
	if got.LoggedIn || !got.Expired {
		t.Fatalf("expected loggedIn=false + expired=true on 401, got: %+v", got)
	}
	if secrets.Has(secrets.SiteToken) {
		t.Fatal("expected expired token to be deleted")
	}
}
