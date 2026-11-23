package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/store"
)

func TestSplitParamListAndChineseTypographyDirective(t *testing.T) {
	got := splitParamList("C-08, C-15 + C-29")
	if len(got) != 3 || got[0] != "C-08" || got[1] != "C-15" || got[2] != "C-29" {
		t.Fatalf("unexpected splitParamList: %#v", got)
	}
	if splitParamList("   ") != nil {
		t.Fatalf("expected nil for empty input")
	}

	pZhCopy := appendChineseTypographyDirective("风格名称：Bold Retro Advertising Cartoon。", "poster", "EC-024", "海洋公园海豚剧场", "海洋公园\n与海洋一起呼吸")
	if !strings.Contains(pZhCopy, "简体中文") {
		t.Fatalf("expected Simplified Chinese directive for Chinese poster copy, got: %s", pZhCopy)
	}

	pEnCopy := appendChineseTypographyDirective("Style name: Bold Retro Advertising Cartoon.", "poster", "EC-024", "Ocean Park", "OCEAN PARK")
	if strings.Contains(pEnCopy, "简体中文") {
		t.Fatalf("did not expect Chinese directive for explicit English copy, got: %s", pEnCopy)
	}

	pPure := appendChineseTypographyDirective("风格名称：French Café Sketch。", "pure-image", "", "秋天咖啡馆", "")
	if strings.Contains(pPure, "简体中文") {
		t.Fatalf("did not expect typography directive for pure-image mode, got: %s", pPure)
	}
}

func TestGenerateSiteBodyPassesDisplayCopyAndColorArray(t *testing.T) {
	webSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/economy/public-models"):
			_, _ = w.Write([]byte(`{"specifications":[{"id":"spec-gpt-25-1k","model":"gpt-image-2.5","resolution":"1k","quality":"standard","enabled":true,"verified":true}]}`))
		case strings.HasPrefix(r.URL.Path, "/api/studio/quote"):
			_, _ = w.Write([]byte(`{"quoteId":"q-test-1","totalCents":0,"freeCount":1}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer webSrv.Close()

	srv, _ := setupTestServer(t, webSrv.URL)
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")

	p := srv.Pack()
	if p == nil || len(p.Styles) == 0 || len(p.Layouts) == 0 || len(p.Colors) == 0 {
		t.Fatalf("expected non-empty test pack, got %+v", p)
	}
	styleID := p.Styles[0].Number
	layoutID := p.Layouts[0].ID
	colorID := p.Colors[0].ID

	rec := doReq(t, srv.Handler(), srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":       "single",
		"title":      "海洋公园海报",
		"modelRef":   "site:gpt-image-2.5",
		"resolution": "1k",
		"confirmed":  true,
		"items": []map[string]any{{
			"theme":  "海洋公园海豚剧场，三只海豚跃出水面",
			"style":  styleID,
			"layout": layoutID,
			"color":  colorID,
			"ratio":  "3:4",
			"text":   "海洋公园\n与海洋一起呼吸",
			"mode":   "poster",
		}},
	})
	if rec.Code != 200 {
		t.Fatalf("POST /api/generate failed status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Images []store.Image `json:"images"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Images) != 1 {
		t.Fatalf("decode generate resp: err=%v body=%s", err, rec.Body.String())
	}

	var spec jobs.Spec
	if err := json.Unmarshal(resp.Images[0].Meta, &spec); err != nil {
		t.Fatalf("decode spec: %v", err)
	}
	if dc, _ := spec.SiteBody["displayCopy"].(string); dc != "海洋公园\n与海洋一起呼吸" {
		t.Fatalf("expected SiteBody.displayCopy preserved, got %q (body=%#v)", dc, spec.SiteBody)
	}
	cols, ok := spec.SiteBody["colors"].([]any)
	if !ok || len(cols) != 1 || cols[0] != colorID {
		t.Fatalf("expected SiteBody.colors to be [%q], got %#v", colorID, spec.SiteBody["colors"])
	}
	if !strings.Contains(spec.Prompt, "简体中文") {
		t.Fatalf("expected Simplified Chinese directive in spec.Prompt, got: %s", spec.Prompt)
	}
}
