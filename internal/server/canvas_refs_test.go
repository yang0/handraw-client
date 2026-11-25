package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/settings"
)

func TestGeneratePerItemRefsRoleDirectivesAndV2CanvasTemplates(t *testing.T) {
	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	// Configure a mock provider so generate creates queued images without hitting remote site.
	_, err := settings.Update(func(st *settings.Settings) error {
		st.Providers = append(st.Providers, settings.Provider{
			ID:      "mockcanvas",
			Name:    "MockCanvas",
			Kind:    "openai",
			Purpose: "image",
			BaseURL: "http://127.0.0.1:1/v1",
			Enabled: true,
			Models:  []settings.Model{{ID: "img-v2", Label: "Img V2"}},
		})
		return nil
	})
	if err != nil {
		t.Fatalf("update settings: %v", err)
	}

	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	pngBytes, _ := base64.StdEncoding.DecodeString(tinyPNG)
	tmpDir := t.TempDir()
	charRef := filepath.Join(tmpDir, "char.png")
	poseRef := filepath.Join(tmpDir, "pose.png")
	_ = os.WriteFile(charRef, pngBytes, 0o644)
	_ = os.WriteFile(poseRef, pngBytes, 0o644)

	rr := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":       "canvas",
		"title":      "画布多参考图测试",
		"modelRef":   "mockcanvas:img-v2",
		"resolution": "1k",
		"items": []map[string]any{
			{
				"theme": "秋日公园骑自行车的小狗",
				"style": "FA-001",
				"ratio": "3:4",
				"refs":  []string{charRef, poseRef},
				"refSpecs": []map[string]any{
					{"path": charRef, "label": "小狗主角", "role": "角色长相", "note": "保持橘白花纹与圆眼镜"},
					{"path": poseRef, "label": "骑车姿势", "role": "构图姿势", "note": "仅参考动作与机位，不照搬背景"},
				},
			},
			{
				"theme": "书店窗边看书的小狗",
				"style": "FA-001",
				"ratio": "3:4",
				"refs":  []string{charRef},
				"refSpecs": []map[string]any{
					{"path": charRef, "label": "小狗主角", "role": "角色长相", "note": "保持橘白花纹与圆眼镜"},
				},
			},
		},
	})
	if rr.Code != 200 {
		t.Fatalf("canvas generate failed: %d %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Run struct {
			ID   string          `json:"id"`
			Meta json.RawMessage `json:"meta"`
		} `json:"run"`
		Images []struct {
			ID     string          `json:"id"`
			Prompt string          `json:"prompt"`
			Meta   json.RawMessage `json:"meta"`
		} `json:"images"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Images) != 2 {
		t.Fatalf("expected 2 images, got %d", len(resp.Images))
	}

	var spec0, spec1 jobs.Spec
	_ = json.Unmarshal(resp.Images[0].Meta, &spec0)
	_ = json.Unmarshal(resp.Images[1].Meta, &spec1)

	if len(spec0.Refs) < 2 || spec0.Refs[0] != charRef || spec0.Refs[1] != poseRef {
		t.Fatalf("expected item 0 to have [charRef, poseRef], got %+v", spec0.Refs)
	}
	if !strings.Contains(spec0.Prompt, "【参考图使用说明】") ||
		!strings.Contains(spec0.Prompt, "- 参考图 1（角色长相）：保持橘白花纹与圆眼镜") ||
		!strings.Contains(spec0.Prompt, "- 参考图 2（构图姿势）：仅参考动作与机位，不照搬背景") {
		t.Fatalf("item 0 prompt missing structured reference directives: %s", spec0.Prompt)
	}

	if len(spec1.Refs) == 0 || spec1.Refs[0] != charRef {
		t.Fatalf("expected item 1 first ref to be charRef, got %+v", spec1.Refs)
	}
	for _, r := range spec1.Refs {
		if r == poseRef {
			t.Fatalf("item 1 leaked item 0's poseRef: %+v", spec1.Refs)
		}
	}
	if !strings.Contains(spec1.Prompt, "- 参考图 1（角色长相）：保持橘白花纹与圆眼镜") || strings.Contains(spec1.Prompt, "参考图 2") {
		t.Fatalf("item 1 prompt had wrong reference directives: %s", spec1.Prompt)
	}
	if spec0.Resolution != "1k" || spec1.Resolution != "1k" {
		t.Fatalf("expected 1k resolution preserved, got %q / %q", spec0.Resolution, spec1.Resolution)
	}

	// Verify Run.Meta persists reference provenance including role and note.
	if !strings.Contains(string(resp.Run.Meta), "角色长相") || !strings.Contains(string(resp.Run.Meta), "保持橘白花纹与圆眼镜") {
		t.Fatalf("expected run meta to persist role and note, got %s", string(resp.Run.Meta))
	}

	// Verify v2 built-in templates include native reference nodes.
	rrTpl := doReq(t, h, srv.Token, http.MethodGet, "/api/docs/template", nil)
	if rrTpl.Code != 200 {
		t.Fatalf("get templates failed: %d %s", rrTpl.Code, rrTpl.Body.String())
	}
	tplBody := rrTpl.Body.String()
	if !strings.Contains(tplBody, "tpl_char_scenes") || !strings.Contains(tplBody, "tpl_multi_ref_fusion") || !strings.Contains(tplBody, `"type":"reference"`) {
		t.Fatalf("expected v2 reference templates in builtin list, got: %s", tplBody)
	}
}
