package jobs

import (
	"context"
	"encoding/base64"
	"encoding/json"
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

func TestSiteRetryAutoRequotesBeforeGenerate(t *testing.T) {
	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	pngBytes, _ := base64.StdEncoding.DecodeString(tinyPNG)

	var quoteCalls atomic.Int32
	var genCalls atomic.Int32
	var lastQuoteID string
	var lastQuoteIdx float64

	var siteSrv *httptest.Server
	siteSrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/quote":
			n := quoteCalls.Add(1)
			_, _ = w.Write([]byte(`{"quoteId":"quote_retry_fresh_` + string(rune('0'+n)) + `","totalCents":0,"freeCount":1}`))
		case "/api/studio/generate":
			genCalls.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			qid, _ := body["quoteId"].(string)
			qidx, _ := body["quoteIndex"].(float64)
			lastQuoteID = qid
			lastQuoteIdx = qidx
			if qid == "" {
				w.WriteHeader(409)
				_, _ = w.Write([]byte(`{"error":{"code":"quote_required","message":"请先预览并确认本次生图费用"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"id":"task_retry_ok","status":"succeeded","images":["` + siteSrv.URL + `/img/out.png"]}`))
		case "/img/out.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		default:
			w.WriteHeader(404)
		}
	}))
	defer siteSrv.Close()

	t.Setenv("HANDRAW_SECRETS", "memory")
	t.Setenv("HANDRAW_HOME", t.TempDir())
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	_ = secrets.Set(secrets.SiteToken, "hwt_test_retry")

	worksDir := filepath.Join(t.TempDir(), "works")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.SiteBase = siteSrv.URL
		st.WorksDir = worksDir
		return nil
	})

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	runDir := filepath.Join(worksDir, "run_retry_1")
	spec := Spec{
		ModelRef:   "site:gpt-image-2.5",
		Prompt:     "母亲节海报",
		Ratio:      "3:4",
		Resolution: "1k",
		Quality:    "standard",
		RequestID:  "req_old_failed",
		QuoteID:    "quote_old_used",
		QuoteIndex: 1,
		SiteBody: map[string]any{
			"model":      "gpt-image-2.5",
			"resolution": "1k",
			"quality":    "standard",
			"ratio":      "3:4",
			"specId":     "spec-gpt-25-1k",
			"prompt":     "母亲节海报",
		},
	}
	meta, _ := json.Marshal(spec)
	run := &store.Run{
		ID:     "run_retry_1",
		Mode:   "series",
		Title:  "母亲节海报",
		Model:  "site:gpt-image-2.5",
		Source: "site",
		Status: "failed",
		Dir:    runDir,
	}
	im := store.Image{
		ID:     "img_retry_1",
		Idx:    0,
		Status: "failed",
		Error:  "内容触发了上游安全过滤",
		Theme:  "母亲节海报",
		Prompt: "母亲节海报",
		Meta:   meta,
	}
	if err := db.InsertRun(run, []store.Image{im}); err != nil {
		t.Fatalf("insert run: %v", err)
	}

	sc := site.New(siteSrv.URL)
	doneCh := make(chan Event, 8)
	mgr := New(db, sc, func(ev Event) {
		if ev.Type == "image" && (ev.Status == "done" || ev.Status == "failed") {
			doneCh <- ev
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mgr.Start(ctx, 1)

	if err := mgr.Retry("img_retry_1"); err != nil {
		t.Fatalf("Retry failed: %v", err)
	}

	select {
	case ev := <-doneCh:
		if ev.Status != "done" {
			t.Fatalf("expected retried image to succeed, got status=%s err=%s", ev.Status, ev.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for retried image")
	}

	if quoteCalls.Load() != 1 {
		t.Fatalf("expected 1 fresh quote call on retry, got %d", quoteCalls.Load())
	}
	if genCalls.Load() != 1 || lastQuoteID != "quote_retry_fresh_1" || lastQuoteIdx != 0 {
		t.Fatalf("expected generate with fresh quoteId & quoteIndex=0, got calls=%d qid=%q idx=%v", genCalls.Load(), lastQuoteID, lastQuoteIdx)
	}
}
