package jobs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

func TestManagerConcurrentImageRuns(t *testing.T) {
	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	pngBytes, _ := base64.StdEncoding.DecodeString(tinyPNG)
	_ = pngBytes

	var inFlight atomic.Int32
	var maxInFlight atomic.Int32
	allFourArrived := make(chan struct{})
	var closedBarrier atomic.Bool

	mockImgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inFlight.Add(1)
		for {
			prev := maxInFlight.Load()
			if cur <= prev || maxInFlight.CompareAndSwap(prev, cur) {
				break
			}
		}
		if cur >= 4 && closedBarrier.CompareAndSwap(false, true) {
			close(allFourArrived)
		}
		// Wait briefly for all 4 concurrent workers to overlap before returning.
		select {
		case <-allFourArrived:
		case <-time.After(1500 * time.Millisecond):
		}
		inFlight.Add(-1)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"b64_json": tinyPNG}},
		})
	}))
	defer mockImgSrv.Close()

	t.Setenv("HANDRAW_SECRETS", "memory")
	t.Setenv("HANDRAW_HOME", t.TempDir())
	t.Cleanup(func() { _ = secrets.Delete(secrets.ProviderKey("mockimg")) })
	_ = secrets.Set(secrets.ProviderKey("mockimg"), "sk-mock")
	worksDir := filepath.Join(t.TempDir(), "works")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.WorksDir = worksDir
		st.Providers = append(st.Providers, settings.Provider{
			ID:      "mockimg",
			Name:    "MockImg",
			Kind:    "openai",
			Purpose: "image",
			BaseURL: mockImgSrv.URL + "/v1",
			Enabled: true,
			Models:  []settings.Model{{ID: "fast-img", Label: "Fast Img"}},
		})
		return nil
	})

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs_conc.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	doneRuns := make(chan string, 8)
	jm := New(db, site.New("test"), func(ev Event) {
		if ev.Type == "run" && ev.Status == "done" {
			doneRuns <- ev.RunID
		}
	})
	jm.Start(ctx, 6)

	for i := 1; i <= 4; i++ {
		runID := fmt.Sprintf("run_conc_%d", i)
		imgID := fmt.Sprintf("img_conc_%d", i)
		meta, _ := json.Marshal(Spec{
			ModelRef: "mockimg:fast-img",
			Prompt:   fmt.Sprintf("concurrent illustration %d", i),
			Ratio:    "4:3",
		})
		run := &store.Run{
			ID:     runID,
			Mode:   "article",
			Title:  "并发配图测试",
			Model:  "mockimg:fast-img",
			Source: "provider",
			Status: "queued",
			Dir:    filepath.Join(worksDir, runID),
		}
		im := store.Image{
			ID:     imgID,
			Idx:    0,
			Status: "queued",
			Theme:  fmt.Sprintf("插图 %d", i),
			Prompt: fmt.Sprintf("concurrent illustration %d", i),
			Meta:   meta,
		}
		if err := db.InsertRun(run, []store.Image{im}); err != nil {
			t.Fatalf("insert run %d: %v", i, err)
		}
		jm.Enqueue(imgID)
	}

	completed := map[string]bool{}
	timeout := time.After(6 * time.Second)
	for len(completed) < 4 {
		select {
		case rid := <-doneRuns:
			completed[rid] = true
		case <-timeout:
			t.Fatalf("timed out waiting for 4 concurrent runs (completed=%d, maxInFlight=%d)", len(completed), maxInFlight.Load())
		}
	}
	if maxInFlight.Load() < 4 {
		t.Fatalf("expected 4 runs to overlap concurrently with 6 workers, got maxInFlight=%d", maxInFlight.Load())
	}
}
