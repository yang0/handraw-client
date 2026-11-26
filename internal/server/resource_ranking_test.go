package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// The picker order comes from the website's shared ranking (#168): proxied,
// cached, sent without credentials, and served stale when the site is down.
func TestResourceRankingProxyCacheAndStaleFallback(t *testing.T) {
	var calls atomic.Int32
	var down atomic.Bool
	var sawAuth atomic.Bool
	fakeSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/resources/ranking" {
			http.NotFound(w, r)
			return
		}
		calls.Add(1)
		if r.Header.Get("Authorization") != "" {
			sawAuth.Store(true)
		}
		if down.Load() {
			http.Error(w, `{"ok":false}`, http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		order := []string{"CS-TOP", "FA-002", "FA-001"}
		if r.URL.Query().Get("kind") == "layout" {
			order = []string{"SC-009", "SC-001"}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "kind": r.URL.Query().Get("kind"), "day": "2026-11-26", "order": order,
			"quality": map[string]any{"CS-TOP": map[string]any{"n": 9, "p": 96, "b": []string{"top_rated"}}},
		})
	}))
	defer fakeSite.Close()

	srv, cancel := setupTestServer(t, fakeSite.URL)
	defer cancel()
	h := srv.Handler()

	get := func(target string) resourceRanking {
		t.Helper()
		rr := doReq(t, h, srv.Token, http.MethodGet, target, nil)
		if rr.Code != http.StatusOK {
			t.Fatalf("GET %s: %d %s", target, rr.Code, rr.Body.String())
		}
		var out resourceRanking
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (%s)", err, rr.Body.String())
		}
		return out
	}

	styles := get("/api/resources/ranking?kind=style")
	if len(styles.Order) != 3 || styles.Order[0] != "CS-TOP" || styles.Kind != "style" {
		t.Fatalf("unexpected style ranking: %+v", styles)
	}
	if _, ok := styles.Quality["CS-TOP"]; !ok {
		t.Fatalf("quality chips missing: %+v", styles.Quality)
	}
	layouts := get("/api/resources/ranking?kind=layout")
	if layouts.Kind != "layout" || layouts.Order[0] != "SC-009" {
		t.Fatalf("unexpected layout ranking: %+v", layouts)
	}
	before := calls.Load()
	_ = get("/api/resources/ranking?kind=style")
	if calls.Load() != before {
		t.Fatalf("second read should be served from cache")
	}
	if sawAuth.Load() {
		t.Fatalf("public ranking must not send credentials")
	}

	down.Store(true)
	stale := get("/api/resources/ranking?kind=style&refresh=1")
	if !stale.Stale || stale.Order[0] != "CS-TOP" {
		t.Fatalf("site down should serve the stale order: %+v", stale)
	}
}
