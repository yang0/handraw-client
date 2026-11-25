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
	if !strings.Contains(spec0.Prompt, "【参考图使用说明") ||
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

func TestCanvasSiteCreationSourceRemapAndDefaultRoleDirective(t *testing.T) {
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/economy/public-models":
			_, _ = w.Write([]byte(`{"specifications":[{"id":"spec-gpt-25-1k","model":"gpt-image-2.5","resolution":"1k","quality":"standard","enabled":true,"verified":true}]}`))
		case "/api/studio/quote":
			_, _ = w.Write([]byte(`{"quoteId":"q_canvas_156","totalCents":0,"freeCount":2}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	_ = secrets.Set(secrets.SiteToken, "hwt_canvas_156")
	h := srv.Handler()

	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	pngBytes, _ := base64.StdEncoding.DecodeString(tinyPNG)
	refPath := filepath.Join(t.TempDir(), "hero.png")
	_ = os.WriteFile(refPath, pngBytes, 0o644)

	// 1. Multi-item desktop canvas on site:* must remap creationSource="canvas" -> "series" (#156),
	//    and role-only refSpecs (empty note) must expand into an actionable directive.
	rrMulti := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":       "canvas",
		"title":      "线上画布批量测试",
		"modelRef":   "site:gpt-image-2.5",
		"resolution": "1k",
		"confirmed":  true,
		"items": []map[string]any{
			{
				"theme": "主角在咖啡馆看书",
				"style": "FA-001",
				"ratio": "3:4",
				"refs":  []string{refPath},
				"refSpecs": []map[string]any{
					{"path": refPath, "role": "角色长相", "note": ""},
				},
			},
			{
				"theme": "主角在公园散步",
				"style": "FA-001",
				"ratio": "3:4",
				"refs":  []string{refPath},
				"refSpecs": []map[string]any{
					{"path": refPath, "role": "构图姿势", "note": ""},
				},
			},
		},
	})
	if rrMulti.Code != 200 {
		t.Fatalf("site canvas multi generate failed: %d %s", rrMulti.Code, rrMulti.Body.String())
	}
	var multiRes struct {
		Images []struct {
			Prompt string          `json:"prompt"`
			Meta   json.RawMessage `json:"meta"`
		} `json:"images"`
	}
	_ = json.Unmarshal(rrMulti.Body.Bytes(), &multiRes)
	if len(multiRes.Images) != 2 {
		t.Fatalf("expected 2 site images, got %d", len(multiRes.Images))
	}
	var sp0 jobs.Spec
	_ = json.Unmarshal(multiRes.Images[0].Meta, &sp0)
	if got := sp0.SiteBody["creationSource"]; got != "series" {
		t.Fatalf("expected multi-item site canvas creationSource='series', got %v", got)
	}
	if !strings.Contains(multiRes.Images[0].Prompt, "必须严格参考该图中的人物/角色五官") {
		t.Fatalf("expected strong default directive for role-only 角色长相, got: %s", multiRes.Images[0].Prompt)
	}
	if !strings.Contains(multiRes.Images[1].Prompt, "必须严格参考该图的画面构图、主体动作姿势") {
		t.Fatalf("expected strong default directive for role-only 构图姿势, got: %s", multiRes.Images[1].Prompt)
	}

	// 2. Single-item desktop canvas on site:* must remap creationSource="canvas" -> "single".
	rrSingle := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":       "canvas",
		"title":      "线上画布单张测试",
		"modelRef":   "site:gpt-image-2.5",
		"resolution": "1k",
		"confirmed":  true,
		"items": []map[string]any{
			{"theme": "雨夜书店", "style": "FA-001", "ratio": "3:4"},
		},
	})
	if rrSingle.Code != 200 {
		t.Fatalf("site canvas single generate failed: %d %s", rrSingle.Code, rrSingle.Body.String())
	}
	var singleRes struct {
		Images []struct {
			Meta json.RawMessage `json:"meta"`
		} `json:"images"`
	}
	_ = json.Unmarshal(rrSingle.Body.Bytes(), &singleRes)
	var spSingle jobs.Spec
	_ = json.Unmarshal(singleRes.Images[0].Meta, &spSingle)
	if got := spSingle.SiteBody["creationSource"]; got != "single" {
		t.Fatalf("expected single-item site canvas creationSource='single', got %v", got)
	}
}

func TestCanvasCopyGenerationAndXhsTemplate(t *testing.T) {
	var capturedSystem, capturedUser string
	mockText := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		for _, m := range req.Messages {
			if m.Role == "system" {
				capturedSystem = m.Content
			}
			if m.Role == "user" {
				capturedUser = m.Content
			}
		}
		reply, _ := json.Marshal(map[string]any{
			"titles":  []string{"新手手冲咖啡别再瞎买豆！5个避坑点", "喝完这杯我再也不去咖啡店了☕️", "1:15万能手冲公式，新手一次成功"},
			"content": "姐妹们！刚入坑手冲最容易踩的 5 个坑我帮你们踩完了👇\n\n1️⃣ 豆子别选出油深烘\n2️⃣ 92℃ 水温最清甜\n\n你们平时最常翻车在哪一步？评论区聊聊！",
			"tags":    []string{"#手冲咖啡", "新手避坑", "咖啡日常"},
		})
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": string(reply)}}},
		})
	}))
	defer mockText.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()
	_, err := settings.Update(func(st *settings.Settings) error {
		st.Providers = append(st.Providers, settings.Provider{
			ID:      "mockcopy",
			Name:    "MockCopy",
			Kind:    "openai",
			Purpose: "text",
			BaseURL: mockText.URL + "/v1",
			Enabled: true,
			Models:  []settings.Model{{ID: "xhs-writer", Label: "XHS Writer"}},
		})
		st.DefaultTextModel = "mockcopy:xhs-writer"
		return nil
	})
	if err != nil {
		t.Fatalf("update text provider: %v", err)
	}

	rr := doReq(t, h, srv.Token, http.MethodPost, "/api/canvas/copy", map[string]any{
		"platform":    "xiaohongshu",
		"tone":        "干货种草",
		"title":       "手冲咖啡避坑",
		"requirement": "语气像朋友分享",
		"modelRef":    "mockcopy:xhs-writer",
		"items": []map[string]any{
			{"theme": "封面：新手手冲咖啡 5 大翻车坑", "text": "手冲避坑指南"},
			{"theme": "92℃ 水温控制与三段注水"},
		},
	})
	if rr.Code != 200 {
		t.Fatalf("canvas copy failed: %d %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(capturedSystem, "小红书") || !strings.Contains(capturedUser, "手冲避坑指南") {
		t.Fatalf("expected Xiaohongshu platform prompt and slide text forwarded, sys=%q user=%q", capturedSystem, capturedUser)
	}
	var res struct {
		OK       bool     `json:"ok"`
		Platform string   `json:"platform"`
		Titles   []string `json:"titles"`
		Content  string   `json:"content"`
		Tags     []string `json:"tags"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &res)
	if !res.OK || res.Platform != "xiaohongshu" || len(res.Titles) != 3 || !strings.Contains(res.Content, "92℃") || len(res.Tags) != 3 || res.Tags[0] != "手冲咖啡" {
		t.Fatalf("unexpected canvas copy response: %+v", res)
	}

	// Verify built-in templates include tpl_xhs_full with both output and copy nodes.
	rrTpl := doReq(t, h, srv.Token, http.MethodGet, "/api/docs/template", nil)
	if rrTpl.Code != 200 || !strings.Contains(rrTpl.Body.String(), "tpl_xhs_full") || !strings.Contains(rrTpl.Body.String(), `"type":"copy"`) {
		t.Fatalf("expected tpl_xhs_full with copy node in templates, got %d %s", rrTpl.Code, rrTpl.Body.String())
	}
}
