package server

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/store"
)

func TestWorksDirInspectAndMigrate(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	oldDir := settings.Get().WorksDir
	runDir := filepath.Join(oldDir, "2026-11-24", "run_mig_1")
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	imgPath := filepath.Join(runDir, "img_1.png")
	thumbPath := filepath.Join(runDir, "thumb_1.png")
	png := tinyPNG(t)
	if err := os.WriteFile(imgPath, png, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(thumbPath, png, 0o644); err != nil {
		t.Fatal(err)
	}

	// Seed a run, image, and canvas doc referencing paths inside oldDir.
	if err := srv.DB.InsertRun(&store.Run{
		ID:     "run_mig_1",
		Mode:   "single",
		Title:  "迁移测试作品",
		Status: "done",
		Dir:    runDir,
	}, []store.Image{{
		ID:     "img_mig_1",
		RunID:  "run_mig_1",
		Idx:    0,
		Status: "done",
		Path:   imgPath,
		Thumb:  thumbPath,
	}}); err != nil {
		t.Fatal(err)
	}
	docPayload, _ := json.Marshal(map[string]any{"nodes": []map[string]any{{"image": imgPath}}})
	if err := srv.DB.PutDoc(&store.Doc{
		Kind: "canvas",
		ID:   "cv_mig_1",
		Name: "测试画布",
		Data: docPayload,
	}); err != nil {
		t.Fatal(err)
	}
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.ArticleVaultDir = filepath.Join(oldDir, "articles")
		st.ArticleVaultDirs = []string{filepath.Join(oldDir, "articles")}
		return nil
	})

	// 1. Inspect detects nested subdirectory conflict.
	nestedTarget := filepath.Join(oldDir, "sub_inside")
	rrNested := doReq(t, h, srv.Token, "POST", "/api/settings/works-dir/inspect", map[string]any{
		"targetDir": nestedTarget,
	})
	if rrNested.Code != 200 || !strings.Contains(rrNested.Body.String(), `"nested":true`) {
		t.Fatalf("expected nested=true, got %d %s", rrNested.Code, rrNested.Body.String())
	}
	// Attempting to migrate into nested subdir must be rejected.
	rrBadMig := doReq(t, h, srv.Token, "POST", "/api/settings/works-dir/switch", map[string]any{
		"targetDir": nestedTarget,
		"migrate":   true,
	})
	if rrBadMig.Code != 400 {
		t.Fatalf("expected 400 rejecting nested migrate, got %d %s", rrBadMig.Code, rrBadMig.Body.String())
	}

	// 2. Inspect a valid separate target directory reports fileCount=2, hasContent=true.
	newDir := filepath.Join(t.TempDir(), "new-works")
	rrInsp := doReq(t, h, srv.Token, "POST", "/api/settings/works-dir/inspect", map[string]any{
		"targetDir": newDir,
	})
	if rrInsp.Code != 200 {
		t.Fatalf("inspect failed: %d %s", rrInsp.Code, rrInsp.Body.String())
	}
	var insp struct {
		HasContent bool  `json:"hasContent"`
		FileCount  int   `json:"fileCount"`
		TotalBytes int64 `json:"totalBytes"`
		Nested     bool  `json:"nested"`
	}
	if err := json.Unmarshal(rrInsp.Body.Bytes(), &insp); err != nil {
		t.Fatal(err)
	}
	if !insp.HasContent || insp.FileCount != 2 || insp.TotalBytes <= 0 || insp.Nested {
		t.Fatalf("unexpected inspect output: %+v", insp)
	}

	// 3. Switch WITH migrate=true moves files and rewrites SQLite & ArticleVaultDir paths.
	rrMig := doReq(t, h, srv.Token, "POST", "/api/settings/works-dir/switch", map[string]any{
		"targetDir": newDir,
		"migrate":   true,
	})
	if rrMig.Code != 200 {
		t.Fatalf("switch with migrate failed: %d %s", rrMig.Code, rrMig.Body.String())
	}
	var migOut struct {
		OK         bool `json:"ok"`
		Migrated   bool `json:"migrated"`
		MovedFiles int  `json:"movedFiles"`
	}
	_ = json.Unmarshal(rrMig.Body.Bytes(), &migOut)
	if !migOut.OK || !migOut.Migrated || migOut.MovedFiles != 2 {
		t.Fatalf("unexpected migrate output: %+v (%s)", migOut, rrMig.Body.String())
	}

	expectedNewImg := filepath.Join(newDir, "2026-11-24", "run_mig_1", "img_1.png")
	if _, err := os.Stat(expectedNewImg); err != nil {
		t.Fatalf("expected migrated image at %s: %v", expectedNewImg, err)
	}
	if _, err := os.Stat(imgPath); !os.IsNotExist(err) {
		t.Fatalf("expected old image to have been moved away from %s", imgPath)
	}

	// Verify DB run + image + doc paths were rewritten.
	gotRun, err := srv.DB.GetRun("run_mig_1")
	if err != nil {
		t.Fatal(err)
	}
	if !sameCleanPath(gotRun.Dir, filepath.Join(newDir, "2026-11-24", "run_mig_1")) {
		t.Fatalf("run.Dir not rewritten: %s", gotRun.Dir)
	}
	if len(gotRun.Images) != 1 || !sameCleanPath(gotRun.Images[0].Path, expectedNewImg) {
		t.Fatalf("image.Path not rewritten: %+v", gotRun.Images)
	}
	gotDoc, err := srv.DB.GetDoc("canvas", "cv_mig_1")
	if err != nil {
		t.Fatal(err)
	}
	var docMap map[string]any
	_ = json.Unmarshal(gotDoc.Data, &docMap)
	nodes, _ := docMap["nodes"].([]any)
	node0, _ := nodes[0].(map[string]any)
	if gotPath, _ := node0["image"].(string); !sameCleanPath(gotPath, expectedNewImg) {
		t.Fatalf("canvas doc image path not rewritten: got %q want %q", gotPath, expectedNewImg)
	}
	if !sameCleanPath(settings.Get().ArticleVaultDir, filepath.Join(newDir, "articles")) {
		t.Fatalf("ArticleVaultDir not rewritten: %s", settings.Get().ArticleVaultDir)
	}

	// Migrated image must be servable via /files/local.
	rrFile := doReq(t, h, srv.Token, "GET", "/files/local?p="+url.QueryEscape(expectedNewImg), nil)
	if rrFile.Code != 200 || rrFile.Body.Len() != len(png) {
		t.Fatalf("GET /files/local for migrated image failed: %d len=%d", rrFile.Code, rrFile.Body.Len())
	}

	// 4. Switch WITHOUT migrating keeps files in newDir and preserves read access via LegacyWorksDirs.
	thirdDir := filepath.Join(t.TempDir(), "third-works")
	rrSwitchOnly := doReq(t, h, srv.Token, "POST", "/api/settings/works-dir/switch", map[string]any{
		"targetDir": thirdDir,
		"migrate":   false,
	})
	if rrSwitchOnly.Code != 200 {
		t.Fatalf("switch without migrate failed: %d %s", rrSwitchOnly.Code, rrSwitchOnly.Body.String())
	}
	if !sameCleanPath(settings.Get().WorksDir, thirdDir) {
		t.Fatalf("expected active WorksDir=%s, got %s", thirdDir, settings.Get().WorksDir)
	}
	// Old file stays in newDir AND remains readable via /files/local (no 403!).
	if _, err := os.Stat(expectedNewImg); err != nil {
		t.Fatalf("expected old file to stay untouched at %s: %v", expectedNewImg, err)
	}
	rrLegacyFile := doReq(t, h, srv.Token, "GET", "/files/local?p="+url.QueryEscape(expectedNewImg), nil)
	if rrLegacyFile.Code != 200 || rrLegacyFile.Body.Len() != len(png) {
		t.Fatalf("expected old works image to remain readable after switch-only, got %d", rrLegacyFile.Code)
	}
}
