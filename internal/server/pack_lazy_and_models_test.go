package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/resources"
)

func TestFilePackLazyFetchAndDiskCache(t *testing.T) {
	var hits atomic.Int32
	// Minimal valid PNG header bytes so detectRemoteImageMIME recognizes image/png.
	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 1}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/images/individual/FA/FA-001.png" {
			hits.Add(1)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()

	srv, _ := setupTestServer(t, upstream.URL)
	packDir := filepath.Join(t.TempDir(), "embedded-pack")
	if err := resources.EnsureBuiltin(packDir); err != nil {
		t.Fatalf("EnsureBuiltin: %v", err)
	}
	p, err := resources.Load(packDir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	prev := resources.Current()
	resources.SetCurrent(p)
	t.Cleanup(func() { resources.SetCurrent(prev) })
	srv.PackDir = packDir

	h := srv.Handler()
	// 1st request: not on disk -> lazily fetches from upstream and caches to packDir/images/...
	rr1 := doReq(t, h, srv.Token, http.MethodGet, "/files/pack/images/individual/FA/FA-001.png", nil)
	if rr1.Code != 200 {
		t.Fatalf("first lazy fetch expected 200, got %d %s", rr1.Code, rr1.Body.String())
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 1 upstream hit on cold fetch, got %d", hits.Load())
	}
	cachedPath := filepath.Join(packDir, "images", "individual", "FA", "FA-001.png")
	if _, err := os.Stat(cachedPath); err != nil {
		t.Fatalf("expected cached image written to %s: %v", cachedPath, err)
	}

	// 2nd request: served directly from local disk without hitting upstream again.
	rr2 := doReq(t, h, srv.Token, http.MethodGet, "/files/pack/images/individual/FA/FA-001.png", nil)
	if rr2.Code != 200 {
		t.Fatalf("second cached fetch expected 200, got %d", rr2.Code)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 0 additional upstream hits on warm cache, got total %d", hits.Load())
	}

	// Reject non-image paths and path traversal.
	rrBad := doReq(t, h, srv.Token, http.MethodGet, "/files/pack/references/styles.json", nil)
	if rrBad.Code != 404 {
		t.Fatalf("expected 404 for non-image pack path, got %d", rrBad.Code)
	}
}

func TestModelsEndpointCachesAndTimesOutFast(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/economy/public-models" {
			hits.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":"seedream-4.5","label":"Seedream 4.5"}]`))
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()

	srv, _ := setupTestServer(t, upstream.URL)
	h := srv.Handler()

	rr1 := doReq(t, h, srv.Token, http.MethodGet, "/api/models", nil)
	if rr1.Code != 200 {
		t.Fatalf("first /api/models failed: %d %s", rr1.Code, rr1.Body.String())
	}
	rr2 := doReq(t, h, srv.Token, http.MethodGet, "/api/models", nil)
	if rr2.Code != 200 {
		t.Fatalf("second /api/models failed: %d", rr2.Code)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected /api/models to reuse in-memory cache (1 upstream call), got %d", hits.Load())
	}

	// Verify slow/hanging upstream falls back promptly instead of stalling 60s.
	origTimeout := siteModelsFetchTimeout
	siteModelsFetchTimeout = 150 * time.Millisecond
	t.Cleanup(func() { siteModelsFetchTimeout = origTimeout })

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer slow.Close()

	srvSlow, _ := setupTestServer(t, slow.URL)
	start := time.Now()
	rrSlow := doReq(t, srvSlow.Handler(), srvSlow.Token, http.MethodGet, "/api/models", nil)
	elapsed := time.Since(start)
	if rrSlow.Code != 200 {
		t.Fatalf("slow /api/models should gracefully degrade to 200, got %d", rrSlow.Code)
	}
	if elapsed > time.Second {
		t.Fatalf("slow /api/models took too long (%v); expected prompt timeout fallback", elapsed)
	}
}

func TestFilePackLazyFetchDedupsCapsConcurrencyAndRetries429(t *testing.T) {
	origDelay := packFetchRetryBaseDelay
	packFetchRetryBaseDelay = 10 * time.Millisecond
	t.Cleanup(func() { packFetchRetryBaseDelay = origDelay })

	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 1}
	var curInflight, maxInflight atomic.Int32
	var retryHits, dedupHits atomic.Int32

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := curInflight.Add(1)
		for {
			prev := maxInflight.Load()
			if n <= prev || maxInflight.CompareAndSwap(prev, n) {
				break
			}
		}
		defer curInflight.Add(-1)

		switch r.URL.Path {
		case "/images/tones/T-13.webp":
			if retryHits.Add(1) == 1 {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte("Too Many Requests"))
				return
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case "/images/tones/T-14.webp":
			dedupHits.Add(1)
			time.Sleep(40 * time.Millisecond)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		default:
			time.Sleep(30 * time.Millisecond)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		}
	}))
	defer upstream.Close()

	srv, _ := setupTestServer(t, upstream.URL)
	packDir := filepath.Join(t.TempDir(), "embedded-pack")
	if err := resources.EnsureBuiltin(packDir); err != nil {
		t.Fatalf("EnsureBuiltin: %v", err)
	}
	p, err := resources.Load(packDir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	prev := resources.Current()
	resources.SetCurrent(p)
	t.Cleanup(func() { resources.SetCurrent(prev) })
	srv.PackDir = packDir
	h := srv.Handler()

	// 1. Upstream 429 on first attempt retries and returns 200.
	rrRetry := doReq(t, h, srv.Token, http.MethodGet, "/files/pack/images/tones/T-13.webp", nil)
	if rrRetry.Code != 200 {
		t.Fatalf("expected 429 retry to succeed with 200, got %d", rrRetry.Code)
	}
	if retryHits.Load() != 2 {
		t.Fatalf("expected 2 upstream attempts (429 then 200), got %d", retryHits.Load())
	}

	// 2. Concurrent requests for the same path coalesce into 1 upstream fetch.
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rr := doReq(t, h, srv.Token, http.MethodGet, "/files/pack/images/tones/T-14.webp", nil)
			if rr.Code != 200 {
				t.Errorf("coalesced fetch failed with %d", rr.Code)
			}
		}()
	}
	wg.Wait()
	if dedupHits.Load() != 1 {
		t.Fatalf("expected 1 coalesced upstream hit for T-14.webp, got %d", dedupHits.Load())
	}

	// 3. Burst of 12 distinct images respects max concurrency cap of 4.
	maxInflight.Store(0)
	for i := 1; i <= 12; i++ {
		wg.Add(1)
		path := fmt.Sprintf("/files/pack/images/tones/burst-%02d.webp", i)
		go func(u string) {
			defer wg.Done()
			rr := doReq(t, h, srv.Token, http.MethodGet, u, nil)
			if rr.Code != 200 {
				t.Errorf("burst fetch %s failed with %d", u, rr.Code)
			}
		}(path)
	}
	wg.Wait()
	if peak := maxInflight.Load(); peak > 4 {
		t.Fatalf("expected peak upstream concurrency <= 4, got %d", peak)
	}
}
