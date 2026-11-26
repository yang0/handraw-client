package jobs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/yang0/handraw-client/internal/store"
)

// #167: a run without its own folder must not write run.json into the
// process working directory.
func TestWriteRunJSONSkipsRunsWithoutDir(t *testing.T) {
	tmp := t.TempDir()
	db, err := store.Open(filepath.Join(tmp, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cwd, _ := os.Getwd()
	work := filepath.Join(tmp, "cwd")
	_ = os.MkdirAll(work, 0o755)
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })

	noDir := &store.Run{ID: "run_nodir", Mode: "single", Status: "done", Recipe: json.RawMessage(`{}`), Meta: json.RawMessage(`{}`)}
	if err := db.InsertRun(noDir, nil); err != nil {
		t.Fatal(err)
	}
	if err := WriteRunJSON(db, noDir.ID); err != nil {
		t.Fatalf("WriteRunJSON: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "run.json")); !os.IsNotExist(err) {
		t.Fatalf("run.json must not be written to the working directory, stat err=%v", err)
	}

	runDir := filepath.Join(tmp, "run1")
	_ = os.MkdirAll(runDir, 0o755)
	withDir := &store.Run{ID: "run_dir", Mode: "single", Status: "done", Dir: runDir, Recipe: json.RawMessage(`{}`), Meta: json.RawMessage(`{}`)}
	if err := db.InsertRun(withDir, nil); err != nil {
		t.Fatal(err)
	}
	if err := WriteRunJSON(db, withDir.ID); err != nil {
		t.Fatalf("WriteRunJSON: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runDir, "run.json")); err != nil {
		t.Fatalf("run.json should be written beside the images: %v", err)
	}
}
