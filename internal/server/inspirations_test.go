package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

func TestInspirationsCRUDClipOrganizeAndPublish(t *testing.T) {
	var mu sync.Mutex
	var capturedPublish map[string]any
	var capturedGenerate map[string]any

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/me/inspirations":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "items": []any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/ai/chat":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"content": `{
					"title": "手绘雨夜暖灯小书店",
					"prompt": "Warm editorial ink and watercolor bookstore on a rainy evening, glowing window, orange cat sleeping",
					"promptZh": "暖纸手绘水彩风格，雨夜亮着暖灯的小书店，一只橘猫在橱窗里打盹",
					"slots": [
						{"key": "subject", "label": "主角", "defaultValue": "橘猫"},
						{"key": "scene", "label": "地点", "defaultValue": "雨夜小书店"}
					],
					"tags": ["手绘", "书店", "治愈"],
					"suggestedStyle": "FA-001"
				}`,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/inspirations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			capturedPublish = body
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      true,
				"id":      "insp_pub_001",
				"url":     "/inspirations/insp_pub_001",
				"price":   body["price"],
				"reward":  map[string]any{"awarded": 5, "kind": "inspiration_share"},
				"message": "已发布到社区灵感广场",
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/inspirations/feed":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"items": []map[string]any{
					{
						"id":           "insp_pub_001",
						"title":        "手绘雨夜暖灯小书店",
						"price":        5,
						"promptLocked": true,
						"promptPreview": "Warm editorial ink...",
					},
				},
				"total": 1,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/inspirations/insp_pub_001/unlock":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":              true,
				"unlocked":        true,
				"pointsSpent":     5,
				"unlockedContent": "Warm editorial ink and watercolor bookstore",
				"inspiration": map[string]any{
					"id":           "insp_pub_001",
					"prompt":       "Warm editorial ink and watercolor bookstore",
					"promptLocked": false,
					"unlocked":     true,
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/me/creator-earnings":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":             true,
				"publishedCount": 2,
				"totalForks":     4,
				"totalUnlocks":   3,
				"totalEarned":    22,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/studio/quote":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "quoteId": "q_test", "quoteToken": "qt_test", "totalCents": 0, "freeCount": 1, "perImageCents": 0,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/studio/generate":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			capturedGenerate = body
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":        true,
				"imageData": "data:image/png;base64," + base64.StdEncoding.EncodeToString(tinyPNG(t)),
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "not found: " + r.URL.Path})
		}
	}))
	defer mockSite.Close()

	srv, cancel := setupTestServer(t, mockSite.URL)
	defer cancel()

	h := srv.Handler()

	// Unauthenticated public feed proxy should still work via GetPublic.
	recPub := doReq(t, h, srv.Token, http.MethodGet, "/api/site/inspirations", nil)
	if recPub.Code != http.StatusOK {
		t.Fatalf("unauthenticated public feed failed: status=%d body=%s", recPub.Code, recPub.Body.String())
	}

	// Authenticate client with mock site token.
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")

	// 1. Chrome clip bridge CORS + auth checks.
	clipTok := settings.EnsureClipToken()
	if clipTok == "" {
		t.Fatal("expected non-empty clip token")
	}

	// Preflight OPTIONS from chrome-extension:// should succeed with CORS headers.
	optReq := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:8787/api/inspirations/clip", nil)
	optReq.Host = "127.0.0.1:8787"
	optReq.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	optRec := httptest.NewRecorder()
	h.ServeHTTP(optRec, optReq)
	if optRec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for clip OPTIONS, got %d", optRec.Code)
	}
	if optRec.Header().Get("Access-Control-Allow-Origin") != "chrome-extension://abcdefghijklmnop" {
		t.Fatalf("missing CORS allow-origin header: %q", optRec.Header().Get("Access-Control-Allow-Origin"))
	}

	// Missing clip token should be rejected with 403.
	badClip := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/inspirations/clip", strings.NewReader(`{"rawText":"test"}`))
	badClip.Host = "127.0.0.1:8787"
	badClip.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	badClipRec := httptest.NewRecorder()
	h.ServeHTTP(badClipRec, badClip)
	if badClipRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for missing clip token, got %d", badClipRec.Code)
	}

	// Valid clip from Chrome extension succeeds!
	imgDataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(tinyPNG(t))
	clipBody, _ := json.Marshal(map[string]any{
		"title":        "X 推文灵感",
		"imageDataUrl": imgDataURL,
		"rawText":      "🔥 Amazing prompt!! Warm bookstore on rainy night #AIart #prompt",
		"sourceUrl":    "https://x.com/artist/status/123456",
		"sourceAuthor": "@artist",
		"autoOrganize": false,
	})
	clipReq := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/inspirations/clip", bytes.NewReader(clipBody))
	clipReq.Host = "127.0.0.1:8787"
	clipReq.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	clipReq.Header.Set("X-Handraw-Clip-Token", clipTok)
	clipRec := httptest.NewRecorder()
	h.ServeHTTP(clipRec, clipReq)
	if clipRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for valid clip, got %d: %s", clipRec.Code, clipRec.Body.String())
	}
	var clipResp struct {
		OK   bool            `json:"ok"`
		Item inspirationItem `json:"item"`
	}
	if err := json.Unmarshal(clipRec.Body.Bytes(), &clipResp); err != nil || clipResp.Item.ID == "" {
		t.Fatalf("invalid clip response: %s", clipRec.Body.String())
	}
	if clipResp.Item.Source != "x" {
		t.Fatalf("expected source 'x' inferred from x.com URL, got %q", clipResp.Item.Source)
	}
	inspID := clipResp.Item.ID

	// 2. AI 1-click organize
	orgRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+inspID+"/organize", map[string]any{})
	if orgRec.Code != http.StatusOK {
		t.Fatalf("organize failed: %d %s", orgRec.Code, orgRec.Body.String())
	}
	var orgResp struct {
		OK   bool            `json:"ok"`
		Item inspirationItem `json:"item"`
	}
	_ = json.Unmarshal(orgRec.Body.Bytes(), &orgResp)
	if !orgResp.Item.AIOrganized || orgResp.Item.Title != "手绘雨夜暖灯小书店" || len(orgResp.Item.Slots) != 2 {
		t.Fatalf("unexpected organized item: %+v", orgResp.Item)
	}

	// 3. Publish with price=0 must be rejected (paid-only prompt sharing #76)
	freePubRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+inspID+"/publish", map[string]any{
		"price": 0,
	})
	if freePubRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when publishing free prompt, got %d %s", freePubRec.Code, freePubRec.Body.String())
	}

	// Publish to community with price=5 (paid unlock)
	pubRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+inspID+"/publish", map[string]any{
		"price": 5,
		"notes": "适合做小红书封面",
	})
	if pubRec.Code != http.StatusOK {
		t.Fatalf("publish failed: %d %s", pubRec.Code, pubRec.Body.String())
	}
	mu.Lock()
	gotPrice := capturedPublish["price"]
	mu.Unlock()
	if gotPrice != float64(5) {
		t.Fatalf("expected published price 5, got %v", gotPrice)
	}

	// 4. Unlock proxy & creator earnings proxy
	unRec := doReq(t, h, srv.Token, http.MethodPost, "/api/site/inspirations/insp_pub_001/unlock", map[string]any{})
	if unRec.Code != http.StatusOK || !strings.Contains(unRec.Body.String(), `"unlocked":true`) {
		t.Fatalf("unlock proxy failed: %d %s", unRec.Code, unRec.Body.String())
	}

	earnRec := doReq(t, h, srv.Token, http.MethodGet, "/api/site/creator-earnings", nil)
	if earnRec.Code != http.StatusOK || !strings.Contains(earnRec.Body.String(), `"totalEarned":22`) {
		t.Fatalf("earnings proxy failed: %d %s", earnRec.Code, earnRec.Body.String())
	}

	// 5. Generate with forkOf passes forkOf to site /api/studio/generate
	genRec := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":      "single",
		"title":     "做同款测试",
		"modelRef":  "site:seedream-4.5",
		"forkOf":    "work_999",
		"confirmed": true,
		"items": []map[string]any{
			{"theme": "雨夜书店", "style": "FA-001", "ratio": "3:4", "mode": "pure-image"},
		},
	})
	if genRec.Code != http.StatusOK {
		t.Fatalf("generate failed: %d %s", genRec.Code, genRec.Body.String())
	}

	// Wait briefly for worker to invoke mockSite /api/studio/generate
	for i := 0; i < 40; i++ {
		mu.Lock()
		got := capturedGenerate
		mu.Unlock()
		if got != nil {
			if got["forkOf"] != "work_999" {
				t.Fatalf("expected forkOf='work_999' in site generate payload, got %v", got["forkOf"])
			}
			break
		}
		if i == 39 {
			t.Fatalf("timed out waiting for mock site /api/studio/generate")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestInspirationsPublishRawTextFallbackAndBatch(t *testing.T) {
	var mu sync.Mutex
	var published []map[string]any
	pubSeq := 0

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/inspirations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			pubSeq++
			seq := pubSeq
			published = append(published, body)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":    true,
				"id":    "insp_batch_" + string(rune('0'+seq)),
				"url":   "/inspirations/insp_batch_" + string(rune('0'+seq)),
				"price": body["price"],
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "not found"})
		}
	}))
	defer mockSite.Close()

	srv, cancel := setupTestServer(t, mockSite.URL)
	defer cancel()
	h := srv.Handler()
	_ = secrets.Set(secrets.SiteToken, "hwt_batch_token")

	imgDataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(tinyPNG(t))

	// Create an item directly on disk with only RawText (no Prompt/PromptZh) to verify fallback.
	rawOnlySaved, _, err := saveInspirationImageBytes("insp_rawonly", tinyPNG(t))
	if err != nil {
		t.Fatalf("saveInspirationImageBytes: %v", err)
	}
	rawOnlyItem, err := srv.saveInspiration("insp_rawonly", inspirationData{
		Title:     "仅原文灵感",
		ImagePath: rawOnlySaved,
		RawText:   "Warm hand-drawn coffee shop at dusk, ink linework",
		Source:    "x",
	})
	if err != nil {
		t.Fatalf("saveInspiration: %v", err)
	}

	// Create a second standard item via API.
	cRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations", map[string]any{
		"title":        "森林小屋插画",
		"imageDataUrl": imgDataURL,
		"prompt":       "Watercolor cabin in autumn woods, warm paper texture",
		"tags":         []string{"水彩", "治愈"},
		"source":       "local",
	})
	if cRec.Code != http.StatusOK {
		t.Fatalf("create second inspiration failed: %d %s", cRec.Code, cRec.Body.String())
	}
	var cResp struct {
		Item inspirationItem `json:"item"`
	}
	_ = json.Unmarshal(cRec.Body.Bytes(), &cResp)

	// Publish both sequentially as the batch-share flow does.
	for _, id := range []string{rawOnlyItem.ID, cResp.Item.ID} {
		rec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+id+"/publish", map[string]any{
			"price": 8,
			"notes": "批量分享测试",
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("publish %s failed: %d %s", id, rec.Code, rec.Body.String())
		}
	}

	mu.Lock()
	gotCount := len(published)
	firstPrompt := published[0]["prompt"]
	mu.Unlock()
	if gotCount != 2 {
		t.Fatalf("expected 2 published payloads, got %d", gotCount)
	}
	if firstPrompt != "Warm hand-drawn coffee shop at dusk, ink linework" {
		t.Fatalf("expected rawText fallback prompt, got %v", firstPrompt)
	}

	// Verify both local items persisted PublishedID and PublishedPrice=8.
	for _, id := range []string{rawOnlyItem.ID, cResp.Item.ID} {
		it, err := srv.readInspiration(id)
		if err != nil {
			t.Fatalf("readInspiration(%s): %v", id, err)
		}
		if it.PublishedID == "" || it.PublishedPrice != 8 {
			t.Fatalf("expected published metadata on %s, got id=%q price=%d", id, it.PublishedID, it.PublishedPrice)
		}
	}
}

func TestResolveClipperExtensionDir(t *testing.T) {
	writeManifest := func(dir string) string {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"manifest_version":3}`), 0o644); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
		abs, _ := filepath.Abs(dir)
		return abs
	}

	// 1. Packaged layout: extensions/handraw-clipper alongside executable
	t1 := t.TempDir()
	want1 := writeManifest(filepath.Join(t1, "extensions", "handraw-clipper"))
	got1, ok1 := resolveClipperExtensionDirFrom(filepath.Join(t1, "handraw.exe"), t.TempDir(), t.TempDir())
	if !ok1 || got1 != want1 {
		t.Fatalf("packaged layout: got (%q, %v), want (%q, true)", got1, ok1, want1)
	}

	// 2. Dev dist/ layout: <repo>/dist/handraw.exe -> <repo>/extensions/handraw-clipper
	t2 := t.TempDir()
	want2 := writeManifest(filepath.Join(t2, "extensions", "handraw-clipper"))
	got2, ok2 := resolveClipperExtensionDirFrom(filepath.Join(t2, "dist", "handraw.exe"), t.TempDir(), t.TempDir())
	if !ok2 || got2 != want2 {
		t.Fatalf("dist layout: got (%q, %v), want (%q, true)", got2, ok2, want2)
	}

	// 3. macOS .app bundle layout: Contents/MacOS/handraw -> Contents/Resources/extensions/handraw-clipper
	t3 := t.TempDir()
	want3 := writeManifest(filepath.Join(t3, "Handraw.app", "Contents", "Resources", "extensions", "handraw-clipper"))
	got3, ok3 := resolveClipperExtensionDirFrom(filepath.Join(t3, "Handraw.app", "Contents", "MacOS", "handraw"), t.TempDir(), t.TempDir())
	if !ok3 || got3 != want3 {
		t.Fatalf("macOS bundle layout: got (%q, %v), want (%q, true)", got3, ok3, want3)
	}

	// 4. Fallback when missing: still returns absolute path alongside executable with exists=false
	t4 := t.TempDir()
	got4, ok4 := resolveClipperExtensionDirFrom(filepath.Join(t4, "handraw.exe"), t.TempDir(), t.TempDir())
	want4, _ := filepath.Abs(filepath.Join(t4, "extensions", "handraw-clipper"))
	if ok4 || got4 != want4 || !filepath.IsAbs(got4) {
		t.Fatalf("missing fallback: got (%q, %v), want (%q, false)", got4, ok4, want4)
	}

	// 5. Verify both API endpoints expose absolute clipExtensionDir
	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()
	for _, ep := range []string{"/api/inspirations", "/api/settings"} {
		rec := doReq(t, h, srv.Token, http.MethodGet, ep, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s failed: %d %s", ep, rec.Code, rec.Body.String())
		}
		var payload map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &payload)
		dir, _ := payload["clipExtensionDir"].(string)
		if dir == "" || !filepath.IsAbs(dir) {
			t.Fatalf("GET %s returned non-absolute clipExtensionDir: %q", ep, dir)
		}
	}
}

func TestInspirationCategoryTaxonomyAndFilter(t *testing.T) {
	cases := []struct {
		title string
		tags  []string
		want  string
	}{
		{"明制红梅祈福雪景古风摄影", []string{"古风摄影", "明制汉服"}, "人物写真"},
		{"一张自拍生成12种美姿", []string{"自拍姿势", "3x4网格", "人像摄影"}, "人物写真"},
		{"结构即版式：自然科学编辑海报", []string{"自然科学海报", "标本档案"}, "科普信息图"},
		{"负空间植物艺术海报模板", []string{"负空间", "植物海报", "极简排版"}, "海报排版"},
		{"电影级角色设定参考图", []string{"角色设定图", "角色三视图"}, "角色设定"},
		{"手绘儿童绘本插画", []string{"儿童绘本"}, "插画绘本"},
		{"创意反差视觉广告", []string{"反差创意"}, "创意脑洞"},
	}
	for _, tc := range cases {
		got := inferInspirationCategory(inspirationData{Title: tc.title, Tags: tc.tags})
		if got != tc.want {
			t.Errorf("inferInspirationCategory(%q, %v) = %q, want %q", tc.title, tc.tags, got, tc.want)
		}
	}

	norm := normalizeInspirationTags([]string{"#人物写真", "人物写真", " #古风 ", "汉服", "多维标签"})
	if len(norm) != 4 || norm[0] != "人物写真" || norm[1] != "古风" || norm[2] != "汉服" || norm[3] != "多维标签" {
		t.Fatalf("unexpected normalizeInspirationTags output: %v", norm)
	}

	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()
	if _, err := srv.saveInspiration("", inspirationData{Title: "明制汉服摄影", Tags: []string{"古风摄影", "明制汉服"}, Prompt: "p1", Source: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.saveInspiration("", inspirationData{Title: "负空间艺术海报", Tags: []string{"负空间", "植物海报"}, Prompt: "p2", Source: "x"}); err != nil {
		t.Fatal(err)
	}

	rec := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations?category="+url.QueryEscape("海报排版"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/inspirations?category failed: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		TotalCount int               `json:"totalCount"`
		Items      []inspirationItem `json:"items"`
		Categories []struct {
			Category string `json:"category"`
			Count    int    `json:"count"`
		} `json:"categories"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.TotalCount != 2 {
		t.Fatalf("expected totalCount=2, got %d", resp.TotalCount)
	}
	if len(resp.Items) != 1 || resp.Items[0].Category != "海报排版" {
		t.Fatalf("expected 1 filtered item in 海报排版, got %+v", resp.Items)
	}
	if len(resp.Categories) != 2 {
		t.Fatalf("expected 2 non-empty categories, got %+v", resp.Categories)
	}
}

func TestDefaultBridgePortAndCleanClipEndpoint(t *testing.T) {
	if DefaultPort != 18520 {
		t.Fatalf("expected DefaultPort 18520 matching Chrome clipper default, got %d", DefaultPort)
	}
	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()

	// Pick a free preferred port via Listen(ctx, 0), close it, then verify Listen binds it and falls back when occupied.
	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()
	addr, err := srv.Listen(ctx1, 0)
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	h := srv.Handler()
	rec := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/inspirations failed: %d", rec.Code)
	}
	var resp struct {
		ClipEndpoint string `json:"clipEndpoint"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.ClipEndpoint != addr {
		t.Fatalf("expected clipEndpoint to be clean base URL %q, got %q", addr, resp.ClipEndpoint)
	}
	if strings.Contains(resp.ClipEndpoint, "/api/inspirations/clip") {
		t.Fatalf("clipEndpoint must not include /api/inspirations/clip suffix: %q", resp.ClipEndpoint)
	}

	settRec := doReq(t, h, srv.Token, http.MethodGet, "/api/settings", nil)
	var settResp struct {
		ClipEndpoint string `json:"clipEndpoint"`
	}
	_ = json.Unmarshal(settRec.Body.Bytes(), &settResp)
	if settResp.ClipEndpoint != addr {
		t.Fatalf("expected /api/settings clipEndpoint %q, got %q", addr, settResp.ClipEndpoint)
	}
}

func TestInspirationCustomFoldersBatchMoveAndMultiTagFilter(t *testing.T) {
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/api/ai/chat" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"content": `{
					"title": "秋日茶饮海报",
					"prompt": "Warm hand-drawn tea shop poster",
					"promptZh": "暖纸手绘茶饮海报",
					"folder": "茶饮客户",
					"tags": ["水彩", "封面", "茶饮"],
					"slots": []
				}`,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "items": []any{}})
	}))
	defer mockSite.Close()

	srv, cancel := setupTestServer(t, mockSite.URL)
	defer cancel()
	h := srv.Handler()
	_ = secrets.Set(secrets.SiteToken, "hwt_folders_test")

	// 0. Fresh DB auto-seeds the 7 default editable folders and lets users edit/delete them freely.
	initRec := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations", nil)
	var initResp struct {
		Folders []string `json:"folders"`
	}
	_ = json.Unmarshal(initRec.Body.Bytes(), &initResp)
	if len(initResp.Folders) != len(inspirationCategoryRules) {
		t.Fatalf("expected %d default editable folders on fresh DB, got %v", len(inspirationCategoryRules), initResp.Folders)
	}
	// Delete one default folder ("创意脑洞") and verify it stays deleted (never re-seeded).
	delDef := doReq(t, h, srv.Token, http.MethodDelete, "/api/inspirations/folders?name="+url.QueryEscape("创意脑洞"), nil)
	if delDef.Code != http.StatusOK {
		t.Fatalf("delete default folder failed: %d %s", delDef.Code, delDef.Body.String())
	}

	// 1. Create custom folders + verify reserved/duplicate names are rejected
	rec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/folders", map[string]any{"name": "茶饮客户"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create folder failed: %d %s", rec.Code, rec.Body.String())
	}
	rec2 := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/folders", map[string]any{"name": "空分组测试"})
	if rec2.Code != http.StatusOK {
		t.Fatalf("create second folder failed: %d %s", rec2.Code, rec2.Body.String())
	}
	dupRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/folders", map[string]any{"name": "茶饮客户"})
	if dupRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on duplicate folder, got %d", dupRec.Code)
	}
	resvRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/folders", map[string]any{"name": "未分组"})
	if resvRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on reserved folder name, got %d", resvRec.Code)
	}

	// 2. Seed 3 items: 1 in 茶饮客户 (tags 水彩, 封面), 1 in 茶饮客户 (tags 水彩), 1 ungrouped (tags 封面)
	it1, err := srv.saveInspiration("", inspirationData{Title: "A-水彩封面", Folder: "茶饮客户", Tags: []string{"水彩", "封面"}, Prompt: "p1", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}
	it2, err := srv.saveInspiration("", inspirationData{Title: "B-仅水彩", Folder: "茶饮客户", Tags: []string{"水彩"}, Prompt: "p2", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}
	it3, err := srv.saveInspiration("", inspirationData{Title: "C-未分组", Folder: "", Tags: []string{"封面"}, Prompt: "p3", Source: "import"})
	if err != nil {
		t.Fatal(err)
	}

	// 3. List all: verify 6 remaining default folders + 2 custom folders (including 0-count 空分组测试) & deleted default stays gone
	listRec := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations", nil)
	var listResp struct {
		TotalCount     int `json:"totalCount"`
		UngroupedCount int `json:"ungroupedCount"`
		FolderItems    []struct {
			Name  string `json:"name"`
			Count int    `json:"count"`
		} `json:"folderItems"`
		Items []inspirationItem `json:"items"`
	}
	_ = json.Unmarshal(listRec.Body.Bytes(), &listResp)
	if listResp.TotalCount != 3 || listResp.UngroupedCount != 1 {
		t.Fatalf("unexpected counts: total=%d ungrouped=%d", listResp.TotalCount, listResp.UngroupedCount)
	}
	wantFolderTotal := len(inspirationCategoryRules) - 1 + 2
	if len(listResp.FolderItems) != wantFolderTotal {
		t.Fatalf("expected %d folderItems, got %+v", wantFolderTotal, listResp.FolderItems)
	}
	byName := map[string]int{}
	for _, fi := range listResp.FolderItems {
		byName[fi.Name] = fi.Count
	}
	if _, stillExists := byName["创意脑洞"]; stillExists {
		t.Fatalf("deleted default folder 创意脑洞 must not be re-seeded: %+v", listResp.FolderItems)
	}
	if byName["茶饮客户"] != 2 {
		t.Fatalf("expected 茶饮客户 count=2, got %+v", listResp.FolderItems)
	}
	if c, ok := byName["空分组测试"]; !ok || c != 0 {
		t.Fatalf("expected 空分组测试 present with count=0, got %+v", listResp.FolderItems)
	}

	// 4. Filter by folder + multi-tag intersection (tags=水彩,封面 -> only it1)
	multiRec := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations?folder="+url.QueryEscape("茶饮客户")+"&tags="+url.QueryEscape("水彩,封面"), nil)
	var multiResp struct {
		Items []inspirationItem `json:"items"`
	}
	_ = json.Unmarshal(multiRec.Body.Bytes(), &multiResp)
	if len(multiResp.Items) != 1 || multiResp.Items[0].ID != it1.ID {
		t.Fatalf("expected only it1 for folder+multi-tag intersection, got %+v", multiResp.Items)
	}

	// 5. Filter by __ungrouped__ -> only it3
	ungRec := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations?folder=__ungrouped__", nil)
	var ungResp struct {
		Items []inspirationItem `json:"items"`
	}
	_ = json.Unmarshal(ungRec.Body.Bytes(), &ungResp)
	if len(ungResp.Items) != 1 || ungResp.Items[0].ID != it3.ID {
		t.Fatalf("expected only it3 for __ungrouped__, got %+v", ungResp.Items)
	}

	// 6. AI organize on ungrouped item recommends existing folder 茶饮客户 without inventing new ones
	orgRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+it3.ID+"/organize", map[string]any{})
	if orgRec.Code != http.StatusOK {
		t.Fatalf("organize failed: %d %s", orgRec.Code, orgRec.Body.String())
	}
	got3, _ := srv.readInspiration(it3.ID)
	if got3.Folder != "茶饮客户" {
		t.Fatalf("expected AI organize to assign existing folder 茶饮客户, got %q", got3.Folder)
	}

	// 7. Batch move it2 + it3 into a new folder 新提案分组
	bmRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/batch-folder", map[string]any{
		"ids":    []string{it2.ID, it3.ID},
		"folder": "新提案分组",
	})
	if bmRec.Code != http.StatusOK {
		t.Fatalf("batch-folder failed: %d %s", bmRec.Code, bmRec.Body.String())
	}
	got2, _ := srv.readInspiration(it2.ID)
	got3, _ = srv.readInspiration(it3.ID)
	if got2.Folder != "新提案分组" || got3.Folder != "新提案分组" {
		t.Fatalf("expected batch moved items in 新提案分组, got %q / %q", got2.Folder, got3.Folder)
	}

	// 8. Rename folder 新提案分组 -> 正式提案 and verify items updated
	renRec := doReq(t, h, srv.Token, http.MethodPatch, "/api/inspirations/folders", map[string]any{
		"oldName": "新提案分组",
		"newName": "正式提案",
	})
	if renRec.Code != http.StatusOK {
		t.Fatalf("rename folder failed: %d %s", renRec.Code, renRec.Body.String())
	}
	got2, _ = srv.readInspiration(it2.ID)
	if got2.Folder != "正式提案" {
		t.Fatalf("expected renamed folder 正式提案 on it2, got %q", got2.Folder)
	}

	// 9. Delete folder 正式提案 -> items safely move back to ungrouped (Folder=="") and are NOT deleted
	delRec := doReq(t, h, srv.Token, http.MethodDelete, "/api/inspirations/folders?name="+url.QueryEscape("正式提案"), nil)
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete folder failed: %d %s", delRec.Code, delRec.Body.String())
	}
	got2, err = srv.readInspiration(it2.ID)
	if err != nil || got2.Folder != "" {
		t.Fatalf("expected it2 preserved and moved to ungrouped, err=%v folder=%q", err, got2.Folder)
	}

	// 10. Deleting ALL remaining folders persists [] (must NOT re-seed defaults on next list).
	for _, f := range srv.loadSavedInspirationFolders() {
		dRec := doReq(t, h, srv.Token, http.MethodDelete, "/api/inspirations/folders?name="+url.QueryEscape(f), nil)
		if dRec.Code != http.StatusOK {
			t.Fatalf("delete folder %q failed: %d", f, dRec.Code)
		}
	}
	emptyListRec := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations", nil)
	var emptyListResp struct {
		Folders []string `json:"folders"`
	}
	_ = json.Unmarshal(emptyListRec.Body.Bytes(), &emptyListResp)
	if len(emptyListResp.Folders) != 0 {
		t.Fatalf("expected 0 folders after deleting all, got %v", emptyListResp.Folders)
	}

	// 11. Fresh server with pre-existing ungrouped item backfills matching default folder ONCE on first init.
	srv2, cancel2 := setupTestServer(t, mockSite.URL)
	defer cancel2()
	legacyItem, err := srv2.saveInspiration("", inspirationData{
		Title:  "手绘水彩猫咪绘本",
		Tags:   []string{"水彩", "绘本"},
		Prompt: "Watercolor cat storybook",
		Source: "local",
	})
	if err != nil {
		t.Fatal(err)
	}
	bfRec := doReq(t, srv2.Handler(), srv2.Token, http.MethodGet, "/api/inspirations", nil)
	if bfRec.Code != http.StatusOK {
		t.Fatalf("backfill list failed: %d", bfRec.Code)
	}
	gotLegacy, err := srv2.readInspiration(legacyItem.ID)
	if err != nil || gotLegacy.Folder != "插画绘本" {
		t.Fatalf("expected legacy ungrouped item backfilled to 插画绘本, got folder=%q err=%v", gotLegacy.Folder, err)
	}
}
