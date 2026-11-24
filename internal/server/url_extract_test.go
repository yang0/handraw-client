package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInspirationsFetchURL_XFxTwitterAndMultiPhoto(t *testing.T) {
	mockFx := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/azed_ai/status/2116121954382139842" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    200,
			"message": "OK",
			"tweet": map[string]any{
				"id":   "2116121954382139842",
				"text": "Prompt share: Pixar-Style 3D Character\n\nA premium Pixar-style 3D reinterpretation of [Samurai Jack character]",
				"author": map[string]any{
					"name":        "Azed AI",
					"screen_name": "azed_ai",
				},
				"media": map[string]any{
					"photos": []map[string]any{
						{"url": "https://pbs.twimg.com/media/HV35sddacAA6mb7.jpg"},
						{"url": "https://pbs.twimg.com/media/HV35spGaIAAP6BD.jpg?name=large"},
					},
				},
			},
		})
	}))
	defer mockFx.Close()

	prevFx := fxTwitterAPIBase
	fxTwitterAPIBase = mockFx.URL
	t.Cleanup(func() { fxTwitterAPIBase = prevFx })

	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()

	rr := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/fetch-url", map[string]any{
		"url": "https://x.com/azed_ai/status/2116121954382139842?a=JwZOYs4SA5VR1oncXNc&s=20",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("fetch-url failed: %d %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Extracted ExtractedInspiration `json:"extracted"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	ext := resp.Extracted
	if ext.Platform != "x" || ext.Adapter != "fxtwitter" {
		t.Fatalf("unexpected platform/adapter: %+v", ext)
	}
	if !strings.Contains(ext.Text, "Pixar-Style 3D Character") {
		t.Fatalf("missing real tweet text: %q", ext.Text)
	}
	if !strings.Contains(ext.Author, "@azed_ai") {
		t.Fatalf("unexpected author: %q", ext.Author)
	}
	if ext.SourceURL != "https://x.com/azed_ai/status/2116121954382139842" {
		t.Fatalf("expected canonical sourceUrl, got %q", ext.SourceURL)
	}
	if len(ext.Images) != 2 || !strings.Contains(ext.Images[0], "name=orig") || !strings.Contains(ext.Images[1], "name=orig") {
		t.Fatalf("expected 2 ?name=orig photos, got %v", ext.Images)
	}
}

func TestInspirationsFetchURL_FallbackToVxTwitter(t *testing.T) {
	mockFx := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer mockFx.Close()

	mockVx := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tweetID":          "999000111",
			"text":             "Fallback prompt from VxTwitter: warm studio clay figure",
			"user_name":        "Creator",
			"user_screen_name": "creator_x",
			"media_extended": []map[string]any{
				{"type": "image", "url": "https://pbs.twimg.com/media/abc123.jpg"},
			},
		})
	}))
	defer mockVx.Close()

	prevFx, prevVx := fxTwitterAPIBase, vxTwitterAPIBase
	fxTwitterAPIBase, vxTwitterAPIBase = mockFx.URL, mockVx.URL
	t.Cleanup(func() { fxTwitterAPIBase, vxTwitterAPIBase = prevFx, prevVx })

	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()

	rr := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/fetch-url", map[string]any{
		"url": "https://twitter.com/creator_x/status/999000111",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("vx fallback failed: %d %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Extracted ExtractedInspiration `json:"extracted"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if resp.Extracted.Adapter != "vxtwitter" || !strings.Contains(resp.Extracted.Text, "warm studio clay figure") {
		t.Fatalf("unexpected vx fallback result: %+v", resp.Extracted)
	}
}

func TestInspirationsFetchURL_GenericWebAndSSRFProtection(t *testing.T) {
	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()

	// 1. SSRF guard blocks localhost/private IPs by default.
	rrBlock := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/fetch-url", map[string]any{
		"url": "http://127.0.0.1:8080/internal",
	})
	if rrBlock.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 SSRF block, got %d %s", rrBlock.Code, rrBlock.Body.String())
	}

	// 2. Generic web HTML extraction with test loopback opt-in.
	webSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html><head>
			<title>Clay Prompt Guide</title>
			<meta property="og:title" content="Isometric Clay Prompt" />
			<meta property="og:image" content="/cover.png" />
			<meta name="author" content="Studio Lab" />
		</head><body>
			<script>var ignored = 1;</script>
			<p>A warm isometric clay diorama of a sunlit botanical workshop with delicate potted ferns.</p>
		</body></html>`))
	}))
	defer webSrv.Close()

	prevAllow := allowPrivateURLFetchForTest
	allowPrivateURLFetchForTest = true
	t.Cleanup(func() { allowPrivateURLFetchForTest = prevAllow })

	rrWeb := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/fetch-url", map[string]any{
		"url": webSrv.URL + "/post/1",
	})
	if rrWeb.Code != http.StatusOK {
		t.Fatalf("generic web fetch failed: %d %s", rrWeb.Code, rrWeb.Body.String())
	}
	var resp struct {
		Extracted ExtractedInspiration `json:"extracted"`
	}
	_ = json.Unmarshal(rrWeb.Body.Bytes(), &resp)
	if resp.Extracted.Title != "Isometric Clay Prompt" || !strings.Contains(resp.Extracted.Text, "botanical workshop") {
		t.Fatalf("unexpected generic web extraction: %+v", resp.Extracted)
	}
	if len(resp.Extracted.Images) != 1 || resp.Extracted.Images[0] != webSrv.URL+"/cover.png" {
		t.Fatalf("expected resolved absolute og:image, got %v", resp.Extracted.Images)
	}
}

func TestInspirationsAntiHallucinationAndHTMLImageReject(t *testing.T) {
	// Mock both FxTwitter and VxTwitter failing so bare X URL cannot be resolved.
	deadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer deadSrv.Close()
	prevFx, prevVx := fxTwitterAPIBase, vxTwitterAPIBase
	fxTwitterAPIBase, vxTwitterAPIBase = deadSrv.URL, deadSrv.URL
	t.Cleanup(func() { fxTwitterAPIBase, vxTwitterAPIBase = prevFx, prevVx })

	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()

	// 1. Creating an inspiration with ONLY an unfetchable bare X URL must fail cleanly (not save & hallucinate).
	rrCreate := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations", map[string]any{
		"rawText":      "https://x.com/azed_ai/status/2116121954382139842",
		"prompt":       "https://x.com/azed_ai/status/2116121954382139842",
		"autoOrganize": true,
	})
	if rrCreate.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when bare URL cannot be extracted, got %d %s", rrCreate.Code, rrCreate.Body.String())
	}

	// 2. isValidImageBytes rejects HTML pages masquerading as image URLs.
	if isValidImageBytes("text/html; charset=utf-8", []byte("<!DOCTYPE html><html><body>Login</body></html>")) {
		t.Fatalf("expected HTML bytes to be rejected as image")
	}
	if !isValidImageBytes("image/png", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 'I', 'H', 'D', 'R'}) {
		t.Fatalf("expected PNG header bytes to be accepted as image")
	}
}

func TestExtractFirstNetworkURLAndPreserveOnCreate(t *testing.T) {
	got := extractFirstNetworkURL("小红书好图分享 https://xhslink.com/abc123，快来抄作业！")
	if got != "https://xhslink.com/abc123" {
		t.Fatalf("unexpected extracted URL: %q", got)
	}
	if got2 := extractFirstNetworkURL("https://example.com/a.png https://x.com/foo/status/42"); got2 != "https://x.com/foo/status/42" {
		t.Fatalf("expected non-image URL to win, got %q", got2)
	}

	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()
	rr := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations", map[string]any{
		"title":   "测试保留链接",
		"rawText": "超好看的宋制汉服工笔人物 https://x.com/creator/status/12345 推荐收藏",
		"prompt":  "超好看的宋制汉服工笔人物 https://x.com/creator/status/12345 推荐收藏",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Item inspirationItem `json:"item"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if resp.Item.SourceURL != "https://x.com/creator/status/12345" {
		t.Fatalf("expected sourceUrl preserved, got %q", resp.Item.SourceURL)
	}
}

func TestInspirationsClip_EnrichesTruncatedXNoteTweet(t *testing.T) {
	if looksLikeTruncatedXClip("Short prompt on X") {
		t.Fatalf("short ASCII tweet should not be flagged as truncated")
	}
	if !looksLikeTruncatedXClip("这是一段被X时间线列表页截断的提示词…") {
		t.Fatalf("ellipsis tweet should be flagged as truncated")
	}
	cjkPreview := strings.Repeat("宋制汉服工笔人物画细劲勾线", 10) // 130 CJK chars = 260 weighted chars
	if !looksLikeTruncatedXClip(cjkPreview) {
		t.Fatalf("130 CJK char timeline preview should be flagged as possibly truncated")
	}

	fullNotePrompt := cjkPreview + "\n完整后半段提示词：9:16竖版，青绿庭园，留白题字，朱文印章。"
	mockFx := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200,
			"tweet": map[string]any{
				"id":   "2116121954382139842",
				"url":  "https://x.com/azed_ai/status/2116121954382139842",
				"text": fullNotePrompt,
				"author": map[string]any{
					"name":        "Azed",
					"screen_name": "azed_ai",
				},
			},
		})
	}))
	defer mockFx.Close()

	prevFx := fxTwitterAPIBase
	fxTwitterAPIBase = mockFx.URL
	t.Cleanup(func() { fxTwitterAPIBase = prevFx })

	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()
	clipTok := srv.Token // clip route checks X-Handraw-Clip-Token; fetch token via settings or use doReq helper below
	_ = clipTok
	// Grab actual clip token from settings endpoint
	settRR := doReq(t, h, srv.Token, http.MethodGet, "/api/settings", nil)
	var settResp struct {
		ClipToken string `json:"clipToken"`
	}
	_ = json.Unmarshal(settRR.Body.Bytes(), &settResp)
	if settResp.ClipToken == "" {
		t.Fatalf("missing clipToken from /api/settings: %s", settRR.Body.String())
	}

	clipBody, _ := json.Marshal(map[string]any{
		"title":        "宋制汉服",
		"rawText":      cjkPreview,
		"prompt":       cjkPreview,
		"sourceUrl":    "https://x.com/azed_ai/status/2116121954382139842",
		"sourceAuthor": "@azed_ai",
		"truncated":    true,
		"autoOrganize": false,
	})
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/inspirations/clip", strings.NewReader(string(clipBody)))
	req.Host = "127.0.0.1:8787"
	req.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	req.Header.Set("X-Handraw-Clip-Token", settResp.ClipToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("clip failed: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		OK   bool            `json:"ok"`
		Item inspirationItem `json:"item"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if !strings.Contains(resp.Item.Prompt, "完整后半段提示词") {
		t.Fatalf("expected truncated X clip to be upgraded to full Note Tweet, got %q", resp.Item.Prompt)
	}

	// Verify replyTexts from author's comment section are merged cleanly (#100).
	replyBody, _ := json.Marshal(map[string]any{
		"title":        "提示词在评论区",
		"rawText":      "Prompt in the reply below 👇",
		"replyTexts":   []string{"Full cinematic portrait prompt, warm film grain, 85mm lens"},
		"sourceUrl":    "https://x.com/azed_ai/status/2116121954382139842",
		"sourceAuthor": "@azed_ai",
		"autoOrganize": false,
	})
	req2 := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/inspirations/clip", strings.NewReader(string(replyBody)))
	req2.Host = "127.0.0.1:8787"
	req2.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	req2.Header.Set("X-Handraw-Clip-Token", settResp.ClipToken)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("replyTexts clip failed: %d %s", rec2.Code, rec2.Body.String())
	}
	var resp2 struct {
		OK   bool            `json:"ok"`
		Item inspirationItem `json:"item"`
	}
	_ = json.Unmarshal(rec2.Body.Bytes(), &resp2)
	if !strings.Contains(resp2.Item.Prompt, "[作者评论区补充]") || !strings.Contains(resp2.Item.Prompt, "Full cinematic portrait prompt") {
		t.Fatalf("expected author reply prompt merged, got %q", resp2.Item.Prompt)
	}
}
