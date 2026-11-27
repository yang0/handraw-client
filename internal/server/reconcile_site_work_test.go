package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/store"
)

// #192: reconcileSitePublishedWork must skip failed/unsubmitted images without
// a RemoteTaskID (e.g. synchronous 400 insufficient_cash) and negative-cache
// terminal 404 misses so repeated run views don't flood GET /api/studio/tasks.
func TestReconcileSitePublishedWorkSkipsFailedAndCaches404(t *testing.T) {
	var taskHits atomic.Int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/studio/tasks" {
			taskHits.Add(1)
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"ok":false,"error":"task not found"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer mock.Close()

	srv, _ := setupTestServer(t, mock.URL)
	if err := secrets.Set(secrets.SiteToken, "hwt_test_reconcile_192"); err != nil {
		t.Fatalf("set test site token: %v", err)
	}
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	// 1. Failed site run with no RemoteTaskID and no RemoteRunID -> 0 upstream calls.
	failedRun := &store.Run{
		ID:     "run_failed_400",
		Source: "site",
		Status: "failed",
		Images: []store.Image{
			{
				ID:     "img_1",
				Status: "failed",
				Meta:   json.RawMessage(`{"requestId":"req-failed-400"}`),
			},
		},
	}
	srv.reconcileSitePublishedWork(context.Background(), failedRun)
	if got := taskHits.Load(); got != 0 {
		t.Fatalf("expected 0 /api/studio/tasks calls for failed unsubmitted run, got %d", got)
	}

	// 2. Completed site run that returns 404 -> probes once, then negative-cached.
	doneRun := &store.Run{
		ID:     "run_done_unpub",
		Source: "site",
		Status: "done",
		Images: []store.Image{
			{
				ID:           "img_2",
				Status:       "done",
				RemoteTaskID: "task_123",
				Meta:         json.RawMessage(`{"requestId":"req-done-123"}`),
			},
		},
	}
	srv.reconcileSitePublishedWork(context.Background(), doneRun)
	srv.reconcileSitePublishedWork(context.Background(), doneRun)
	srv.reconcileSitePublishedWork(context.Background(), doneRun)
	if got := taskHits.Load(); got != 1 {
		t.Fatalf("expected 1 /api/studio/tasks call with 404 negative cache, got %d", got)
	}
}
