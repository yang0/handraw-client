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

func TestRunSiteCloudflare520RecoveryAndIdempotentRetry(t *testing.T) {
	tinyPNG, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=")

	for _, tc := range []struct {
		name           string
		taskFound      bool
		wantGenCalls   int
		wantTaskLookup int
	}{
		{name: "recover_via_task", taskFound: true, wantGenCalls: 1, wantTaskLookup: 1},
		{name: "retry_when_task_404", taskFound: false, wantGenCalls: 2, wantTaskLookup: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HANDRAW_SECRETS", "memory")
			_ = secrets.Set(secrets.SiteToken, "hwt_test_520")

			var genCalls, taskCalls int
			var firstReqID, secondReqID string
			siteSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/studio/generate":
					genCalls++
					var b map[string]any
					_ = json.NewDecoder(r.Body).Decode(&b)
					rid, _ := b["requestId"].(string)
					if genCalls == 1 {
						firstReqID = rid
						w.WriteHeader(520)
						_, _ = w.Write([]byte(`{"error":"The origin web server returned an invalid or incomplete response to Cloudflare."}`))
						return
					}
					secondReqID = rid
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"taskId":"t_retry","status":"completed","images":["/img/out.png"]}`))
				case "/api/studio/tasks":
					taskCalls++
					if !tc.taskFound {
						w.WriteHeader(404)
						_, _ = w.Write([]byte(`{"error":"not found"}`))
						return
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"taskId":"t_rec","status":"completed","images":["/img/out.png"]}`))
				case "/img/out.png":
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write(tinyPNG)
				default:
					w.WriteHeader(404)
				}
			}))
			defer siteSrv.Close()
			_, _ = settings.Update(func(st *settings.Settings) error {
				st.SiteBase = siteSrv.URL
				return nil
			})

			db, err := store.Open(filepath.Join(t.TempDir(), "db.sqlite"))
			if err != nil {
				t.Fatalf("open db: %v", err)
			}
			defer db.Close()

			runDir := filepath.Join(t.TempDir(), "run520")
			_ = os.MkdirAll(runDir, 0o755)
			spec := Spec{
				ModelRef:  "site:gpt-image-2.5",
				Prompt:    "加一只猫",
				Ratio:     "3:4",
				RequestID: "req_520_" + tc.name,
				QuoteID:   "q_520",
				SiteBody:  map[string]any{"model": "gpt-image-2.5", "mode": "edit"},
			}
			meta, _ := json.Marshal(spec)
			if err := db.InsertRun(&store.Run{ID: "run_520", Mode: "edit", Title: "520", Model: "site:gpt-image-2.5", Source: "site", Status: "queued", Dir: runDir}, []store.Image{{ID: "img_520", Idx: 0, Status: "queued", Prompt: spec.Prompt, Meta: meta}}); err != nil {
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
			mgr.Enqueue("img_520")

			select {
			case ev := <-doneCh:
				if ev.Status != "done" {
					t.Fatalf("expected job done after 520 recovery/retry, got status=%s err=%s", ev.Status, ev.Error)
				}
			case <-time.After(8 * time.Second):
				t.Fatal("timed out waiting for 520 recovery test")
			}

			if genCalls != tc.wantGenCalls || taskCalls != tc.wantTaskLookup {
				t.Fatalf("unexpected call counts: gen=%d (want %d), task=%d (want %d)", genCalls, tc.wantGenCalls, taskCalls, tc.wantTaskLookup)
			}
			if !tc.taskFound && (firstReqID == "" || firstReqID != secondReqID) {
				t.Fatalf("expected idempotent requestId on retry, got first=%q second=%q", firstReqID, secondReqID)
			}
		})
	}
}
