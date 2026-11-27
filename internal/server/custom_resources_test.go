package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/harnesses"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

func TestCustomStyleLayoutSingleDescAndBidirectionalSync(t *testing.T) {
	pngBytes := tinyPNG(t)
	tmpImg := filepath.Join(t.TempDir(), "cover.png")
	if err := os.WriteFile(tmpImg, pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	var uploadedCovers atomic.Int32
	var galleryPutCalls atomic.Int32
	var pushedExamples []string
	webStyleID := uuid.NewString()
	webCoverPath := "/api/library/assets/" + uuid.NewString() + "/image"

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/auth/me":
			_, _ = w.Write([]byte(`{"user":{"username":"tester"}}`))
		case strings.HasPrefix(r.URL.Path, "/api/library/assets/") && r.Method == "PUT":
			galleryPutCalls.Add(1)
			w.WriteHeader(500)
		case r.URL.Path == "/api/v1/me/resources/cover" && r.Method == "POST":
			uploadedCovers.Add(1)
			aid := uuid.NewString()
			_, _ = w.Write([]byte(`{"ok":true,"uid":"` + aid + `","imageUrl":"/api/library/assets/` + aid + `/image","item":{"uid":"` + aid + `","imageUrl":"/api/library/assets/` + aid + `/image"}}`))
		case r.URL.Path == webCoverPath && r.Method == "GET":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case strings.HasPrefix(r.URL.Path, "/api/v1/me/resources/") && r.Method == "PUT":
			var body struct {
				ID       string   `json:"id"`
				Examples []string `json:"examples"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			pushedExamples = body.Examples
			_, _ = w.Write([]byte(`{"ok":true,"resource":{"id":"` + body.ID + `","revision":1}}`))
		case r.URL.Path == "/api/v1/me/resources" && r.Method == "GET":
			_, _ = w.Write([]byte(`{"ok":true,"items":[{"id":"` + webStyleID + `","kind":"style","name":"云端暖纸画风","definition":{"zh":"温润棉纸水彩晕染","en":"温润棉纸水彩晕染"},"license":"个人使用","examples":["` + webCoverPath + `"],"version":"1.0.0","revision":2}],"hasMore":false,"nextCursor":"2"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	h := srv.Handler()

	// 1. Create custom layout with single `description` + local cover image
	rr := doReq(t, h, srv.Token, "POST", "/api/mine/layouts", map[string]any{
		"name":        "双栏要点对照卡",
		"description": "左右 1:1 对称双栏，上方留白主标题区",
		"image":       tmpImg,
		"images":      []string{tmpImg},
	})
	if rr.Code != 200 {
		t.Fatalf("create custom layout failed: %d %s", rr.Code, rr.Body.String())
	}
	var layResp struct {
		Layout resources.Layout `json:"layout"`
		DocID  string           `json:"docId"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &layResp)
	if layResp.Layout.ID != "MY-L-001" || layResp.Layout.PromptZh != "左右 1:1 对称双栏，上方留白主标题区" || layResp.Layout.PromptEn != layResp.Layout.PromptZh {
		t.Fatalf("unexpected custom layout: %+v", layResp.Layout)
	}
	if layResp.Layout.Image != tmpImg {
		t.Fatalf("expected cover %q, got %q", tmpImg, layResp.Layout.Image)
	}

	// 2. Sync pushes layout + private cover image, and pulls cloud style + its remote cover image
	rrSync := doReq(t, h, srv.Token, "POST", "/api/mine/sync", nil)
	if rrSync.Code != 200 {
		t.Fatalf("sync failed: %d %s", rrSync.Code, rrSync.Body.String())
	}
	if uploadedCovers.Load() != 1 {
		t.Fatalf("expected 1 private cover upload via /api/v1/me/resources/cover, got %d", uploadedCovers.Load())
	}
	if galleryPutCalls.Load() != 0 {
		t.Fatalf("resource cover sync must NEVER write to /api/library/assets/ personal gallery, got %d PUT calls", galleryPutCalls.Load())
	}
	if len(pushedExamples) != 1 || !strings.HasPrefix(pushedExamples[0], "/api/library/assets/") {
		t.Fatalf("expected pushed cover example URL, got %v", pushedExamples)
	}

	// Verify pulled web style exists locally with downloaded cover image
	rrList := doReq(t, h, srv.Token, "GET", "/api/mine/styles", nil)
	if rrList.Code != 200 {
		t.Fatalf("list mine styles failed: %d", rrList.Code)
	}
	var listResp struct {
		Items []resources.Style `json:"items"`
	}
	_ = json.Unmarshal(rrList.Body.Bytes(), &listResp)
	if len(listResp.Items) != 1 || listResp.Items[0].NameZh != "云端暖纸画风" {
		t.Fatalf("expected pulled web style, got %+v", listResp.Items)
	}
	if listResp.Items[0].Image == "" || !fileExists(listResp.Items[0].Image) {
		t.Fatalf("expected pulled remote cover downloaded locally, got %q", listResp.Items[0].Image)
	}
	if listResp.Items[0].RemoteImageURL != webCoverPath {
		t.Fatalf("expected remoteImageUrl %q, got %q", webCoverPath, listResp.Items[0].RemoteImageURL)
	}
}

func TestMineAnalyzeLayoutAndHarnessImageArgs(t *testing.T) {
	// Verify harness CLI image flags for codex, opencode, and claude
	codexArgs, _ := harnesses.BuildArgsWithImages("codex", "gpt-5", nil, "analyze", "/tmp/out.txt", []string{"/tmp/a.png"})
	if !strings.Contains(strings.Join(codexArgs, " "), "-i /tmp/a.png") {
		t.Fatalf("codex should pass -i image flag, got %v", codexArgs)
	}
	ocArgs, _ := harnesses.BuildArgsWithImages("opencode", "sonnet", nil, "analyze", "", []string{"/tmp/a.png"})
	if !strings.Contains(strings.Join(ocArgs, " "), "-f /tmp/a.png") {
		t.Fatalf("opencode should pass -f image flag, got %v", ocArgs)
	}
	claudeArgs, _ := harnesses.BuildArgsWithImages("claude", "sonnet", nil, "analyze", "", []string{"/tmp/img/a.png"})
	joinedClaude := strings.Join(claudeArgs, " ")
	if !strings.Contains(joinedClaude, "--tools Read") || !strings.Contains(joinedClaude, "--add-dir") {
		t.Fatalf("claude with images should enable read-only Read tool + --add-dir, got %v", claudeArgs)
	}

	// Verify /api/mine/analyze with kind="layout" via 3rd-party OpenAI provider
	mockAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"name\":\"三段卡片排版\",\"description\":\"顶部通栏标题区，中部主配图，底部三列要点卡片与均衡留白\"}"}}]}`))
	}))
	defer mockAI.Close()

	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	_, _ = settings.Update(func(s *settings.Settings) error {
		s.Providers = []settings.Provider{{
			ID:      "p_vision",
			Name:    "测试视觉中转",
			BaseURL: mockAI.URL + "/v1",
			Purpose: "text",
			Enabled: true,
			Models:  []settings.Model{{ID: "gpt-4o", Label: "GPT-4o", Kind: "text", CanVision: true}},
		}}
		return nil
	})
	_ = secrets.Set(secrets.ProviderKey("p_vision"), "sk-test")

	pngPath := filepath.Join(t.TempDir(), "ref.png")
	_ = os.WriteFile(pngPath, tinyPNG(t), 0o644)

	rr := doReq(t, srv.Handler(), srv.Token, "POST", "/api/mine/analyze", map[string]any{
		"kind":     "layout",
		"images":   []string{pngPath},
		"modelRef": "p_vision:gpt-4o",
	})
	if rr.Code != 200 {
		t.Fatalf("analyze layout failed: %d %s", rr.Code, rr.Body.String())
	}
	var res struct {
		Kind        string `json:"kind"`
		Name        string `json:"name"`
		Description string `json:"description"`
		PromptZh    string `json:"promptZh"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &res)
	if res.Kind != "layout" || res.Name != "三段卡片排版" || !strings.Contains(res.Description, "顶部通栏") || res.PromptZh != res.Description {
		t.Fatalf("unexpected analyze layout response: %+v", res)
	}

	// Verify /api/mine/suggest-name recommends a concise name from description
	rrName := doReq(t, srv.Handler(), srv.Token, "POST", "/api/mine/suggest-name", map[string]any{
		"kind":        "style",
		"description": "温润棉纸底色、淡彩水彩晕染与柔和细钢笔线条",
		"modelRef":    "p_vision:gpt-4o",
	})
	if rrName.Code != 200 {
		t.Fatalf("suggest-name failed: %d %s", rrName.Code, rrName.Body.String())
	}
	var nameRes struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	}
	_ = json.Unmarshal(rrName.Body.Bytes(), &nameRes)
	if nameRes.Name != "三段卡片排版" || nameRes.Source != "provider" {
		t.Fatalf("unexpected suggest-name response: %+v", nameRes)
	}

	// Verify /api/mine/analyze with mode="prompt" & sourceText distills pure style/layout without images
	rrDistill := doReq(t, srv.Handler(), srv.Token, "POST", "/api/mine/analyze", map[string]any{
		"mode":       "prompt",
		"kind":       "layout",
		"sourceText": "画一张穿红裙的女孩在咖啡馆看书，上方留白标题，中间主图，底部三列要点卡片",
		"modelRef":   "p_vision:gpt-4o",
	})
	if rrDistill.Code != 200 {
		t.Fatalf("analyze prompt distill failed: %d %s", rrDistill.Code, rrDistill.Body.String())
	}
	var distRes struct {
		Mode        string `json:"mode"`
		Kind        string `json:"kind"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(rrDistill.Body.Bytes(), &distRes)
	if distRes.Mode != "prompt" || distRes.Kind != "layout" || !strings.Contains(distRes.Description, "顶部通栏") {
		t.Fatalf("unexpected distill response: %+v", distRes)
	}
}

func TestCustomStyleSiteGenerateSetsPromptFromSkillAndRawUserPrompt(t *testing.T) {
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/studio/quote":
			_, _ = w.Write([]byte(`{"quoteId":"q-custom-1","totalCents":0,"freeCount":1,"balanceCents":0,"affordable":true}`))
		case r.URL.Path == "/api/studio/models":
			_, _ = w.Write([]byte(`{"models":[]}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/community/resources"):
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	_, _ = settings.Update(func(s *settings.Settings) error {
		s.AutoSyncResources = false
		return nil
	})
	h := srv.Handler()

	rrPut := doReq(t, h, srv.Token, http.MethodPost, "/api/mine/styles", map[string]any{
		"name":        "宋韵摄影风格",
		"description": "孙郡古风摄影作品，工笔画、宋画美学、东方古典、诗意，大量留白",
	})
	if rrPut.Code != 200 {
		t.Fatalf("put custom style failed: %d %s", rrPut.Code, rrPut.Body.String())
	}
	var putOut struct {
		Style resources.Style `json:"style"`
	}
	if err := json.Unmarshal(rrPut.Body.Bytes(), &putOut); err != nil || putOut.Style.Number == "" {
		t.Fatalf("unexpected put style response: %s", rrPut.Body.String())
	}

	rrGen := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":            "single",
		"title":           "踏青的女孩",
		"originalRequest": "踏青的女孩",
		"modelRef":        "site:gpt-image-2",
		"confirmed":       true,
		"items": []map[string]any{{
			"theme":  "春日草地上撑伞漫步的女孩，远山淡雾",
			"style":  putOut.Style.Number,
			"layout": "SC-001",
			"mode":   "graphic-text",
			"ratio":  "3:4",
		}},
	})
	if rrGen.Code != 200 {
		t.Fatalf("generate failed: %d %s", rrGen.Code, rrGen.Body.String())
	}
	var genOut struct {
		Run struct {
			ID              string `json:"id"`
			OriginalRequest string `json:"originalRequest"`
		} `json:"run"`
		Images []struct {
			Meta json.RawMessage `json:"meta"`
		} `json:"images"`
	}
	if err := json.Unmarshal(rrGen.Body.Bytes(), &genOut); err != nil || len(genOut.Images) != 1 {
		t.Fatalf("unexpected generate output: %s", rrGen.Body.String())
	}
	if genOut.Run.OriginalRequest != "踏青的女孩" {
		t.Fatalf("expected run.OriginalRequest=踏青的女孩, got %q", genOut.Run.OriginalRequest)
	}
	var spec jobs.Spec
	if err := json.Unmarshal(genOut.Images[0].Meta, &spec); err != nil {
		t.Fatalf("unmarshal spec: %v", err)
	}
	if spec.SiteBody["promptFromSkill"] != true {
		t.Fatalf("expected SiteBody.promptFromSkill=true so website does not strip custom style, got %#v", spec.SiteBody["promptFromSkill"])
	}
	if gotRaw, _ := spec.SiteBody["rawUserPrompt"].(string); gotRaw != "踏青的女孩" {
		t.Fatalf("expected SiteBody.rawUserPrompt=踏青的女孩, got %q", gotRaw)
	}
	gotPrompt, _ := spec.SiteBody["prompt"].(string)
	if !strings.Contains(gotPrompt, "宋韵摄影风格") || !strings.Contains(gotPrompt, "孙郡古风摄影作品") {
		t.Fatalf("expected SiteBody.prompt to include custom style name and traits, got %q", gotPrompt)
	}
}
