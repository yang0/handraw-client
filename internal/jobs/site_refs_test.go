package jobs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

func TestRunSiteEncodesLocalRefImagesForEdit(t *testing.T) {
	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	pngBytes, _ := base64.StdEncoding.DecodeString(tinyPNG)

	var capturedBody map[string]any
	var siteSrv *httptest.Server
	siteSrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/generate":
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
			_, _ = w.Write([]byte(`{"id":"task_edit_ok","status":"succeeded","images":["` + siteSrv.URL + `/img/edited.png"]}`))
		case "/img/edited.png":
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
	_ = secrets.Set(secrets.SiteToken, "hwt_test_edit")

	worksDir := filepath.Join(t.TempDir(), "works")
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.SiteBase = siteSrv.URL
		st.WorksDir = worksDir
		return nil
	})

	origPath := filepath.Join(t.TempDir(), "orig.png")
	guidePath := filepath.Join(t.TempDir(), "guide.png")
	_ = os.WriteFile(origPath, pngBytes, 0o644)
	_ = os.WriteFile(guidePath, pngBytes, 0o644)

	db, err := store.Open(filepath.Join(t.TempDir(), "jobs_edit.sqlite"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	spec := Spec{
		ModelRef:   "site:gpt-image-2.5",
		Prompt:     "请严格基于所附参考图进行局部精准编辑修改",
		Ratio:      "3:4",
		Resolution: "1k",
		Quality:    "standard",
		Refs:       []string{origPath, guidePath},
		RequestID:  "req_edit_1",
		QuoteID:    "quote_edit_1",
		QuoteIndex: 0,
		SiteBody: map[string]any{
			"model":           "gpt-image-2.5",
			"prompt":          "请严格基于所附参考图进行局部精准编辑修改",
			"promptFromSkill": true,
			"mode":            "edit",
		},
	}
	meta, _ := json.Marshal(spec)
	run := &store.Run{
		ID:     "run_edit_1",
		Mode:   "edit",
		Title:  "批注改图",
		Model:  "site:gpt-image-2.5",
		Source: "site",
		Status: "queued",
		Dir:    filepath.Join(worksDir, "run_edit_1"),
	}
	im := store.Image{
		ID:     "img_edit_1",
		Idx:    0,
		Status: "queued",
		Theme:  "批注改图",
		Prompt: spec.Prompt,
		Meta:   meta,
	}
	if err := db.InsertRun(run, []store.Image{im}); err != nil {
		t.Fatalf("insert run: %v", err)
	}

	doneCh := make(chan Event, 4)
	mgr := New(db, site.New(siteSrv.URL), func(ev Event) {
		if ev.Type == "image" && (ev.Status == "done" || ev.Status == "failed") {
			doneCh <- ev
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mgr.Start(ctx, 1)
	mgr.Enqueue("img_edit_1")

	select {
	case ev := <-doneCh:
		if ev.Status != "done" {
			t.Fatalf("expected edit job done, got status=%s err=%s", ev.Status, ev.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for edit job")
	}

	refs, ok := capturedBody["refImages"].([]any)
	if !ok || len(refs) != 2 {
		t.Fatalf("expected 2 encoded refImages sent to site generate, got %#v", capturedBody["refImages"])
	}
	for i, r := range refs {
		s, _ := r.(string)
		if !strings.HasPrefix(s, "data:image/png;base64,") {
			t.Fatalf("refImages[%d] expected data:image/png;base64,..., got %q", i, s)
		}
	}
	if vis, _ := capturedBody["visibility"].(string); vis != "private" {
		t.Fatalf("expected visibility=private when refImages present, got %q", vis)
	}
	if pfs, _ := capturedBody["promptFromSkill"].(bool); !pfs {
		t.Fatalf("expected promptFromSkill=true preserved in body, got %#v", capturedBody["promptFromSkill"])
	}
}
