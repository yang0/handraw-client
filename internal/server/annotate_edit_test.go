package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/store"
)

func TestAnnotateEditBuildsLocatedPromptAndSavesGuideRef(t *testing.T) {
	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	pngBytes, _ := base64.StdEncoding.DecodeString(tinyPNG)

	webSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/economy/public-models"):
			_, _ = w.Write([]byte(`{"specifications":[{"id":"spec-gpt-25-1k","model":"gpt-image-2.5","resolution":"1k","quality":"standard","enabled":true,"verified":true}]}`))
		case strings.HasPrefix(r.URL.Path, "/api/studio/quote"):
			_, _ = w.Write([]byte(`{"quoteId":"q-edit-1","totalCents":0,"freeCount":1}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer webSrv.Close()

	srv, _ := setupTestServer(t, webSrv.URL)
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	_ = secrets.Set(secrets.SiteToken, "hwt_test_annotate")

	origPath := filepath.Join(t.TempDir(), "orig.png")
	if err := os.WriteFile(origPath, pngBytes, 0o644); err != nil {
		t.Fatalf("write orig: %v", err)
	}

	rec := doReq(t, srv.Handler(), srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":                  "edit",
		"title":                 "阿拉斯加的冬天 (修订)",
		"modelRef":              "site:gpt-image-2.5",
		"resolution":            "1k",
		"confirmed":             true,
		"refs":                  []string{origPath},
		"annotatedGuideDataUrl": "data:image/png;base64," + tinyPNG,
		"annotations": []map[string]any{
			{"x": 0.48, "y": 0.25, "text": "把极光改成金色的"},
			{"x": 0.20, "y": 0.78, "text": "添加一只麋鹿"},
		},
		"input": map[string]any{
			"theme": "阿拉斯加极夜雪原",
			"ratio": "3:4",
			"mode":  "edit",
		},
	})
	if rec.Code != 200 {
		t.Fatalf("POST /api/generate edit failed status=%d body=%s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Images []store.Image `json:"images"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Images) != 1 {
		t.Fatalf("decode resp: err=%v body=%s", err, rec.Body.String())
	}

	var spec jobs.Spec
	if err := json.Unmarshal(resp.Images[0].Meta, &spec); err != nil {
		t.Fatalf("decode spec: %v", err)
	}
	if len(spec.Refs) != 2 {
		t.Fatalf("expected 2 refs [orig, guide], got %#v", spec.Refs)
	}
	if spec.Refs[0] != origPath {
		t.Fatalf("expected ref[0] to be clean orig %q, got %q", origPath, spec.Refs[0])
	}
	if _, err := os.Stat(spec.Refs[1]); err != nil {
		t.Fatalf("expected saved annotated_guide file at %q: %v", spec.Refs[1], err)
	}
	if pfs, _ := spec.SiteBody["promptFromSkill"].(bool); !pfs {
		t.Fatalf("expected promptFromSkill=true for edit mode, got %#v", spec.SiteBody["promptFromSkill"])
	}
	if sm, _ := spec.SiteBody["mode"].(string); sm != "edit" {
		t.Fatalf("expected SiteBody.mode=edit, got %q", sm)
	}
	for _, want := range []string{"画面中上方", "x=48%, y=25%", "把极光改成金色的", "画面左下方", "添加一只麋鹿", "严禁保留或出现任何红色圆点"} {
		if !strings.Contains(spec.Prompt, want) {
			t.Fatalf("expected edit prompt to contain %q, got:\n%s", want, spec.Prompt)
		}
	}

	// Also verify global extra instruction merges with annotations and works standalone (#75).
	rrGlobal := doReq(t, srv.Handler(), srv.Token, "POST", "/api/generate", map[string]any{
		"mode":      "edit",
		"title":     "整体暖光调整",
		"modelRef":  "site:gpt-image-2.5",
		"confirmed": true,
		"refs":      []string{origPath},
		"input":     map[string]any{"theme": "极光海报", "ratio": "3:4", "mode": "edit", "extra": "整体色调改成温暖黄昏金色光感"},
	})
	if rrGlobal.Code != 200 {
		t.Fatalf("global edit generate failed: %d %s", rrGlobal.Code, rrGlobal.Body.String())
	}
	var respG struct {
		Images []struct {
			Meta json.RawMessage `json:"meta"`
		} `json:"images"`
	}
	if err := json.Unmarshal(rrGlobal.Body.Bytes(), &respG); err != nil || len(respG.Images) != 1 {
		t.Fatalf("decode global edit response: %v %s", err, rrGlobal.Body.String())
	}
	var specG jobs.Spec
	_ = json.Unmarshal(respG.Images[0].Meta, &specG)
	if !strings.Contains(specG.Prompt, "温暖黄昏金色光感") || len(specG.Refs) != 1 {
		t.Fatalf("expected standalone global edit prompt with 1 ref, got refs=%v prompt=%q", specG.Refs, specG.Prompt)
	}
}
