package server

import (
	"encoding/json"
	"testing"

	"github.com/yang0/handraw-client/internal/store"
)

func TestWorksHasImagesFilterExcludesFailedRuns(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// 1. Completed run with an image -> MUST be included.
	if err := srv.DB.InsertRun(
		&store.Run{ID: "run_done_1", Mode: "single", Title: "成功作品", Model: "site:gpt-image-2.5", Source: "site", Status: "done", Dir: t.TempDir()},
		[]store.Image{{ID: "img_done_1", Idx: 0, Status: "done", Path: "/tmp/a.webp"}},
	); err != nil {
		t.Fatalf("insert done run: %v", err)
	}

	// 2. Failed run with no completed images -> MUST be excluded by hasImages=1.
	if err := srv.DB.InsertRun(
		&store.Run{ID: "run_fail_1", Mode: "single", Title: "失败记录", Model: "site:gpt-image-2.5", Source: "site", Status: "failed", Dir: t.TempDir()},
		[]store.Image{{ID: "img_fail_1", Idx: 0, Status: "failed", Error: "upstream error"}},
	); err != nil {
		t.Fatalf("insert failed run: %v", err)
	}

	// 3. Running run with no completed image yet -> MUST be excluded by hasImages=1.
	if err := srv.DB.InsertRun(
		&store.Run{ID: "run_running_1", Mode: "single", Title: "进行中", Model: "site:gpt-image-2.5", Source: "site", Status: "running", Dir: t.TempDir()},
		[]store.Image{{ID: "img_running_1", Idx: 0, Status: "running"}},
	); err != nil {
		t.Fatalf("insert running run: %v", err)
	}

	// 4. Partially succeeded batch (1 done + 1 failed) -> MUST be included because it has a real image.
	if err := srv.DB.InsertRun(
		&store.Run{ID: "run_partial_1", Mode: "series", Title: "部分成功系列", Model: "site:gpt-image-2.5", Source: "site", Status: "partial", Dir: t.TempDir()},
		[]store.Image{
			{ID: "img_p_1", Idx: 0, Status: "done", Path: "/tmp/p1.webp"},
			{ID: "img_p_2", Idx: 1, Status: "failed", Error: "timeout"},
		},
	); err != nil {
		t.Fatalf("insert partial run: %v", err)
	}

	rr := doReq(t, h, srv.Token, "GET", "/api/works?hasImages=1", nil)
	if rr.Code != 200 {
		t.Fatalf("GET /api/works?hasImages=1 failed: %d %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Items []store.Run `json:"items"`
		Total int         `json:"total"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Total != 2 || len(out.Items) != 2 {
		t.Fatalf("expected exactly 2 runs with completed images, got total=%d len=%d items=%+v", out.Total, len(out.Items), out.Items)
	}
	ids := map[string]bool{}
	for _, r := range out.Items {
		ids[r.ID] = true
	}
	if !ids["run_done_1"] || !ids["run_partial_1"] || ids["run_fail_1"] || ids["run_running_1"] {
		t.Fatalf("unexpected filtered run IDs: %+v", ids)
	}
}
