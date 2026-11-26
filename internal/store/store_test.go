package store

import (
	"path/filepath"
	"testing"
)

func TestStoreBatchImagesLikeEscapeAndActiveImages(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	r1 := &Run{ID: "run_1", Mode: "single", Title: "猫和雨夜", Status: "done"}
	if err := db.InsertRun(r1, []Image{
		{ID: "img_1a", Idx: 0, Status: "done", Path: "a.png"},
		{ID: "img_1b", Idx: 1, Status: "queued", Path: ""},
	}); err != nil {
		t.Fatal(err)
	}

	r2 := &Run{ID: "run_2", Mode: "single", Title: "50% 折扣海报", Status: "running"}
	if err := db.InsertRun(r2, []Image{
		{ID: "img_2a", Idx: 0, Status: "running", Path: ""},
	}); err != nil {
		t.Fatal(err)
	}

	r3 := &Run{ID: "run_3", Mode: "single", Title: "a_b 网格", Status: "done"}
	if err := db.InsertRun(r3, nil); err != nil {
		t.Fatal(err)
	}

	// 1. Batched ListRuns loads all images cleanly without N+1.
	runs, total, err := db.ListRuns(RunQuery{Limit: 10})
	if err != nil || total != 3 || len(runs) != 3 {
		t.Fatalf("ListRuns all: total=%d len=%d err=%v", total, len(runs), err)
	}
	byID := map[string]Run{}
	for _, r := range runs {
		byID[r.ID] = r
	}
	if len(byID["run_1"].Images) != 2 || byID["run_1"].Images[0].ID != "img_1a" || byID["run_1"].Images[1].ID != "img_1b" {
		t.Fatalf("run_1 images mismatch: %+v", byID["run_1"].Images)
	}
	if len(byID["run_3"].Images) != 0 {
		t.Fatalf("run_3 should have 0 images, got %+v", byID["run_3"].Images)
	}

	// 2. Short LIKE search escapes '%' and '_' wildcards properly (#177).
	pctRuns, pctTotal, err := db.ListRuns(RunQuery{Search: "%"})
	if err != nil || pctTotal != 1 || len(pctRuns) != 1 || pctRuns[0].ID != "run_2" {
		t.Fatalf("search '%%' must match only literal '%%', got total=%d runs=%+v err=%v", pctTotal, pctRuns, err)
	}
	usRuns, usTotal, err := db.ListRuns(RunQuery{Search: "_"})
	if err != nil || usTotal != 1 || len(usRuns) != 1 || usRuns[0].ID != "run_3" {
		t.Fatalf("search '_' must match only literal '_', got total=%d runs=%+v err=%v", usTotal, usRuns, err)
	}

	// 3. ActiveImages returns queued/running images in a single query.
	active, err := db.ActiveImages()
	if err != nil || len(active) != 2 {
		t.Fatalf("ActiveImages expected 2 active images, got %d (err=%v)", len(active), err)
	}
	if active[0].ID != "img_1b" || active[1].ID != "img_2a" {
		t.Fatalf("unexpected active image order: %+v", active)
	}

	// 4. SoftDeleteRun hides deleted run from ListRuns.
	if err := db.SoftDeleteRun("run_3"); err != nil {
		t.Fatal(err)
	}
	_, totalAfter, err := db.ListRuns(RunQuery{})
	if err != nil || totalAfter != 2 {
		t.Fatalf("expected 2 runs after soft delete, got %d (err=%v)", totalAfter, err)
	}
}
