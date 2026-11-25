package jobs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

const testTinyPNGB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func testTinyPNGBytes() []byte {
	b, _ := base64.StdEncoding.DecodeString(testTinyPNGB64)
	return b
}

func TestDefaultWorkersIsFiveAndQueuesExcess(t *testing.T) {
	if DefaultWorkers != 5 {
		t.Fatalf("expected DefaultWorkers == 5, got %d", DefaultWorkers)
	}

	var inFlight atomic.Int32
	var maxInFlight atomic.Int32
	fiveReached := make(chan struct{})
	var closedFive atomic.Bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inFlight.Add(1)
		for {
			prev := maxInFlight.Load()
			if cur <= prev || maxInFlight.CompareAndSwap(prev, cur) {
				break
			}
		}
		if cur >= 5 && closedFive.CompareAndSwap(false, true) {
			close(fiveReached)
		}
		select {
		case <-fiveReached:
			time.Sleep(25 * time.Millisecond)
		case <-time.After(1500 * time.Millisecond):
		}
		inFlight.Add(-1)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"b64_json": testTinyPNGB64}},
		})
	}))
	defer srv.Close()

	t.Setenv("HANDRAW_SECRETS", "memory")
	t.Setenv("HANDRAW_HOME", t.TempDir())
	settings.Reset()
	t.Cleanup(func() {
		_ = secrets.Delete(secrets.ProviderKey("mock5"))
		settings.Reset()
	})
	_ = secrets.Set(secrets.ProviderKey("mock5"), "sk-mock5")
	worksDir := filepath.Join(t.TempDir(), "works")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.WorksDir = worksDir
		st.Providers = append(st.Providers, settings.Provider{
			ID:      "mock5",
			Name:    "Mock5",
			Kind:    "openai",
			Purpose: "image",
			BaseURL: srv.URL + "/v1",
			Enabled: true,
			Models:  []settings.Model{{ID: "fast-img", Label: "Fast Img"}},
		})
		return nil
	})

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs_default5.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runDone := make(chan string, 4)
	jm := New(db, site.New("test"), func(ev Event) {
		if ev.Type == "run" && ev.Status == "done" {
			runDone <- ev.RunID
		}
	})
	// Passing 0 exercises DefaultWorkers (5).
	jm.Start(ctx, 0)

	const totalImages = 7
	runID := "run_default5"
	run := &store.Run{
		ID:     runID,
		Mode:   "article",
		Title:  "五并发排队测试",
		Model:  "mock5:fast-img",
		Source: "provider",
		Status: "queued",
		Dir:    filepath.Join(worksDir, runID),
	}
	imgs := make([]store.Image, 0, totalImages)
	for i := 0; i < totalImages; i++ {
		meta, _ := json.Marshal(Spec{
			ModelRef: "mock5:fast-img",
			Prompt:   fmt.Sprintf("illustration %d", i),
			Ratio:    "4:3",
		})
		imgs = append(imgs, store.Image{
			ID:     fmt.Sprintf("img_d5_%d", i),
			RunID:  runID,
			Idx:    i,
			Prompt: fmt.Sprintf("illustration %d", i),
			Status: "queued",
			Meta:   meta,
		})
	}
	if err := db.InsertRun(run, imgs); err != nil {
		t.Fatalf("create run: %v", err)
	}
	for _, im := range imgs {
		jm.Enqueue(im.ID)
	}

	select {
	case <-runDone:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for 7 images to finish (maxInFlight=%d)", maxInFlight.Load())
	}

	if got := maxInFlight.Load(); got != 5 {
		t.Fatalf("expected peak concurrency == 5, got %d", got)
	}
	gotImgs, err := db.Images(runID)
	if err != nil {
		t.Fatalf("db images: %v", err)
	}
	for _, im := range gotImgs {
		if im.Status != "done" {
			t.Fatalf("image %s status = %q, err=%q; want done", im.ID, im.Status, im.Error)
		}
	}
}

func TestSiteRespectsMaxInflightAndQueuesExcess(t *testing.T) {
	png := testTinyPNGBytes()
	var inFlight atomic.Int32
	var maxInFlight atomic.Int32
	var busy429Count atomic.Int32
	fourReached := make(chan struct{})
	var closedFour atomic.Bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/config":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"maxInflightPerUser": 4})
		case "/api/studio/quote":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"quoteId": "q_site_cap"})
		case "/api/studio/generate":
			cur := inFlight.Add(1)
			defer inFlight.Add(-1)
			for {
				prev := maxInFlight.Load()
				if cur <= prev || maxInFlight.CompareAndSwap(prev, cur) {
					break
				}
			}
			if cur > 4 {
				busy429Count.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"code":    "generation_in_progress",
					"message": "已有生图任务正在进行，请等待完成后再提交",
				})
				return
			}
			if cur >= 4 && closedFour.CompareAndSwap(false, true) {
				close(fourReached)
			}
			select {
			case <-fourReached:
				time.Sleep(30 * time.Millisecond)
			case <-time.After(1500 * time.Millisecond):
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"status": "completed",
				"images": []string{"/images/ok.png"},
			})
		case "/images/ok.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("HANDRAW_SECRETS", "memory")
	t.Setenv("HANDRAW_HOME", t.TempDir())
	settings.Reset()
	t.Cleanup(func() {
		_ = secrets.Delete(secrets.SiteToken)
		settings.Reset()
	})
	_ = secrets.Set(secrets.SiteToken, "tok-test")
	worksDir := filepath.Join(t.TempDir(), "works")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.WorksDir = worksDir
		return nil
	})

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs_site_cap.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runDone := make(chan string, 4)
	jm := New(db, site.NewWithBase(srv.URL, "test"), func(ev Event) {
		if ev.Type == "run" && ev.Status == "done" {
			runDone <- ev.RunID
		}
	})
	jm.Start(ctx, DefaultWorkers)

	const totalImages = 6
	runID := "run_site_cap"
	run := &store.Run{
		ID:     runID,
		Mode:   "article",
		Title:  "网站并发感知排队测试",
		Model:  "site:gpt-image-2.5",
		Source: "site",
		Status: "queued",
		Dir:    filepath.Join(worksDir, runID),
	}
	imgs := make([]store.Image, 0, totalImages)
	for i := 0; i < totalImages; i++ {
		meta, _ := json.Marshal(Spec{
			ModelRef:   "site:gpt-image-2.5",
			Prompt:     fmt.Sprintf("site illustration %d", i),
			Ratio:      "16:9",
			RequestID:  fmt.Sprintf("req_cap_%d", i),
			QuoteID:    "q_site_cap",
			QuoteIndex: i,
			SiteBody:   map[string]any{"model": "gpt-image-2.5", "prompt": fmt.Sprintf("site illustration %d", i)},
		})
		imgs = append(imgs, store.Image{
			ID:     fmt.Sprintf("img_sc_%d", i),
			RunID:  runID,
			Idx:    i,
			Prompt: fmt.Sprintf("site illustration %d", i),
			Status: "queued",
			Meta:   meta,
		})
	}
	if err := db.InsertRun(run, imgs); err != nil {
		t.Fatalf("create run: %v", err)
	}
	for _, im := range imgs {
		jm.Enqueue(im.ID)
	}

	select {
	case <-runDone:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for 6 site images (maxInFlight=%d, 429s=%d)", maxInFlight.Load(), busy429Count.Load())
	}

	if got := maxInFlight.Load(); got > 4 {
		t.Fatalf("expected site maxInFlight <= 4, got %d", got)
	}
	if got := busy429Count.Load(); got != 0 {
		t.Fatalf("expected 0 self-inflicted 429s with proactive gating, got %d", got)
	}
	gotImgs, _ := db.Images(runID)
	for _, im := range gotImgs {
		if im.Status != "done" {
			t.Fatalf("image %s status=%q err=%q; want done", im.ID, im.Status, im.Error)
		}
	}
}

func TestSite429BusyAutoRequeuesAndCompletes(t *testing.T) {
	png := testTinyPNGBytes()
	var mu sync.Mutex
	inFlight := 0
	var got429 atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/config":
			// Simulate site reporting unlimited or another tab consuming slots,
			// so the 5th concurrent request hits 429 generation_in_progress.
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"maxInflightPerUser": 0})
		case "/api/studio/quote":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"quoteId": "q_429"})
		case "/api/studio/generate":
			mu.Lock()
			if inFlight >= 4 {
				mu.Unlock()
				got429.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"code":    "generation_in_progress",
					"message": "已有生图任务正在进行，请等待完成后再提交",
				})
				return
			}
			inFlight++
			mu.Unlock()

			time.Sleep(45 * time.Millisecond)

			mu.Lock()
			inFlight--
			mu.Unlock()

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"status": "completed",
				"images": []string{"/images/ok.png"},
			})
		case "/images/ok.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("HANDRAW_SECRETS", "memory")
	t.Setenv("HANDRAW_HOME", t.TempDir())
	settings.Reset()
	t.Cleanup(func() {
		_ = secrets.Delete(secrets.SiteToken)
		settings.Reset()
	})
	_ = secrets.Set(secrets.SiteToken, "tok-test")
	worksDir := filepath.Join(t.TempDir(), "works")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.WorksDir = worksDir
		return nil
	})

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs_429_requeue.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var failedEv atomic.Int32
	var requeuedEv atomic.Int32
	runDone := make(chan string, 4)
	jm := New(db, site.NewWithBase(srv.URL, "test"), func(ev Event) {
		if ev.Type == "image" && ev.Status == "failed" {
			failedEv.Add(1)
		}
		if ev.Type == "image" && ev.Status == "queued" {
			requeuedEv.Add(1)
		}
		if ev.Type == "run" && ev.Status == "done" {
			runDone <- ev.RunID
		}
	})
	jm.BusyRetryBase = 30 * time.Millisecond
	jm.BusyRetryMax = 100 * time.Millisecond
	jm.Start(ctx, DefaultWorkers)

	runID := "run_site_429"
	run := &store.Run{
		ID:     runID,
		Mode:   "article",
		Title:  "五图 429 自动排队测试",
		Model:  "site:gpt-image-2.5",
		Source: "site",
		Status: "queued",
		Dir:    filepath.Join(worksDir, runID),
	}
	imgs := make([]store.Image, 0, 5)
	for i := 0; i < 5; i++ {
		meta, _ := json.Marshal(Spec{
			ModelRef:   "site:gpt-image-2.5",
			Prompt:     fmt.Sprintf("article slot %d", i),
			Ratio:      "16:9",
			RequestID:  fmt.Sprintf("req_429_%d", i),
			QuoteID:    "q_429",
			QuoteIndex: i,
			SiteBody:   map[string]any{"model": "gpt-image-2.5", "prompt": fmt.Sprintf("article slot %d", i)},
		})
		imgs = append(imgs, store.Image{
			ID:     fmt.Sprintf("img_429_%d", i),
			RunID:  runID,
			Idx:    i,
			Prompt: fmt.Sprintf("article slot %d", i),
			Status: "queued",
			Meta:   meta,
		})
	}
	if err := db.InsertRun(run, imgs); err != nil {
		t.Fatalf("create run: %v", err)
	}
	for _, im := range imgs {
		jm.Enqueue(im.ID)
	}

	select {
	case <-runDone:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for 5 images after 429 requeue (got429=%d, requeuedEv=%d, failedEv=%d)",
			got429.Load(), requeuedEv.Load(), failedEv.Load())
	}

	if got429.Load() == 0 {
		t.Fatalf("expected at least one 429 generation_in_progress response to exercise requeue path")
	}
	if failedEv.Load() != 0 {
		t.Fatalf("expected 0 failed image events during 429 requeue, got %d", failedEv.Load())
	}
	if requeuedEv.Load() == 0 {
		t.Fatalf("expected queued event to be emitted on 429 requeue")
	}
	gotImgs, _ := db.Images(runID)
	for _, im := range gotImgs {
		if im.Status != "done" {
			t.Fatalf("image %s status=%q err=%q; want done", im.ID, im.Status, im.Error)
		}
	}
}

func TestProvider429ConcurrencyRequeuesAndQuotaFails(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		prompt, _ := body["prompt"].(string)
		w.Header().Set("Content-Type", "application/json")
		if prompt == "permanent-quota" {
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"code":    "insufficient_quota",
					"message": "You exceeded your current quota, please check your billing details.",
				},
			})
			return
		}
		if attempts.Add(1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"code":    "rate_limit_exceeded",
					"message": "Too many concurrent requests, please retry shortly.",
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"b64_json": testTinyPNGB64}},
		})
	}))
	defer srv.Close()

	t.Setenv("HANDRAW_SECRETS", "memory")
	t.Setenv("HANDRAW_HOME", t.TempDir())
	settings.Reset()
	t.Cleanup(func() {
		_ = secrets.Delete(secrets.ProviderKey("mockp429"))
		settings.Reset()
	})
	_ = secrets.Set(secrets.ProviderKey("mockp429"), "sk-test")
	worksDir := filepath.Join(t.TempDir(), "works")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.WorksDir = worksDir
		st.Providers = append(st.Providers, settings.Provider{
			ID:      "mockp429",
			Name:    "MockP429",
			Kind:    "openai",
			Purpose: "image",
			BaseURL: srv.URL + "/v1",
			Enabled: true,
			Models:  []settings.Model{{ID: "img-1", Label: "Img 1"}},
		})
		return nil
	})

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs_prov429.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	imgDone := make(chan Event, 8)
	jm := New(db, site.New("test"), func(ev Event) {
		if ev.Type == "image" && (ev.Status == "done" || ev.Status == "failed") {
			imgDone <- ev
		}
	})
	jm.BusyRetryBase = 25 * time.Millisecond
	jm.BusyRetryMax = 50 * time.Millisecond
	jm.Start(ctx, 2)

	runID := "run_prov429"
	m1, _ := json.Marshal(Spec{ModelRef: "mockp429:img-1", Prompt: "transient-busy", Ratio: "1:1"})
	m2, _ := json.Marshal(Spec{ModelRef: "mockp429:img-1", Prompt: "permanent-quota", Ratio: "1:1"})
	err = db.InsertRun(&store.Run{
		ID: runID, Mode: "article", Title: "429分类测试", Model: "mockp429:img-1", Source: "provider", Status: "queued", Dir: filepath.Join(worksDir, runID),
	}, []store.Image{
		{ID: "img_transient", RunID: runID, Idx: 0, Prompt: "transient-busy", Status: "queued", Meta: m1},
		{ID: "img_quota", RunID: runID, Idx: 1, Prompt: "permanent-quota", Status: "queued", Meta: m2},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	jm.Enqueue("img_transient")
	jm.Enqueue("img_quota")

	results := map[string]string{}
	deadline := time.After(8 * time.Second)
	for len(results) < 2 {
		select {
		case ev := <-imgDone:
			results[ev.ImageID] = ev.Status
		case <-deadline:
			t.Fatalf("timed out waiting for provider 429 test results: %v", results)
		}
	}
	if results["img_transient"] != "done" {
		t.Fatalf("expected transient 429 to requeue and succeed, got %q", results["img_transient"])
	}
	if results["img_quota"] != "failed" {
		t.Fatalf("expected permanent quota 429 to fail immediately, got %q", results["img_quota"])
	}
}

func TestCancelQueuedBusyRetryDoesNotResurrect(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/config":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"maxInflightPerUser": 0})
		case "/api/studio/generate":
			hits.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":    "generation_in_progress",
				"message": "已有生图任务正在进行，请等待完成后再提交",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("HANDRAW_SECRETS", "memory")
	t.Setenv("HANDRAW_HOME", t.TempDir())
	settings.Reset()
	t.Cleanup(func() {
		_ = secrets.Delete(secrets.SiteToken)
		settings.Reset()
	})
	_ = secrets.Set(secrets.SiteToken, "tok-test")

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs_cancel_busy.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	requeued := make(chan struct{}, 2)
	jm := New(db, site.NewWithBase(srv.URL, "test"), func(ev Event) {
		if ev.Type == "image" && ev.ImageID == "img_cancel_busy" && ev.Status == "queued" {
			select {
			case requeued <- struct{}{}:
			default:
			}
		}
	})
	jm.BusyRetryBase = 120 * time.Millisecond
	jm.BusyRetryMax = 200 * time.Millisecond
	jm.Start(ctx, 1)

	meta, _ := json.Marshal(Spec{
		ModelRef:  "site:gpt-image-2.5",
		Prompt:    "cancel me",
		Ratio:     "1:1",
		RequestID: "req_cancel_busy",
		QuoteID:   "q_cancel",
		SiteBody:  map[string]any{"model": "gpt-image-2.5", "prompt": "cancel me"},
	})
	err = db.InsertRun(&store.Run{
		ID: "run_cancel_busy", Mode: "article", Title: "取消排队测试", Model: "site:gpt-image-2.5", Source: "site", Status: "queued", Dir: t.TempDir(),
	}, []store.Image{
		{ID: "img_cancel_busy", RunID: "run_cancel_busy", Idx: 0, Prompt: "cancel me", Status: "queued", Meta: meta},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	jm.Enqueue("img_cancel_busy")

	select {
	case <-requeued:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for image to enter busy requeue")
	}

	if err := jm.Cancel("img_cancel_busy"); err != nil {
		t.Fatalf("cancel failed: %v", err)
	}
	hitsAfterCancel := hits.Load()
	time.Sleep(250 * time.Millisecond)

	if hits.Load() != hitsAfterCancel {
		t.Fatalf("canceled busy-retry image resurrected: hits went from %d to %d", hitsAfterCancel, hits.Load())
	}
	im, _ := db.GetImage("img_cancel_busy")
	if im.Status != "canceled" {
		t.Fatalf("expected status canceled, got %q", im.Status)
	}
}
