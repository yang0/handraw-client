package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
)

func TestTextAndVisionModelsDiscoveryAndCustomRelayRouting(t *testing.T) {
	var relayChatCalls, relayVisionCalls atomic.Int32
	var lastRelayModel string
	var lastRelayHadImage atomic.Bool

	mockRelay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-relay-vision" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"invalid key"}}`))
			return
		}
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"data":[{"id":"deepseek-chat","owned_by":"ds"},{"id":"gpt-4o","owned_by":"oai"},{"id":"flux-pro","owned_by":"bfl"}]}`))
		case "/v1/chat/completions":
			var req struct {
				Model    string `json:"model"`
				Messages []struct {
					Role    string `json:"role"`
					Content any    `json:"content"`
				} `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			lastRelayModel = req.Model
			hasImage := false
			for _, m := range req.Messages {
				if parts, ok := m.Content.([]any); ok {
					for _, p := range parts {
						if pm, ok := p.(map[string]any); ok && pm["type"] == "image_url" {
							hasImage = true
						}
					}
				}
			}
			if hasImage {
				relayVisionCalls.Add(1)
				lastRelayHadImage.Store(true)
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"name\":\"暖纸墨线\",\"traitsZh\":\"松散黑线、暖纸感\",\"traitsEn\":\"loose black ink on warm paper\"}"}}]}`))
				return
			}
			relayChatCalls.Add(1)
			lastUser := ""
			if len(req.Messages) > 0 {
				lastUser, _ = req.Messages[len(req.Messages)-1].Content.(string)
			}
			switch {
			case lastUser == "ping":
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"}}]}`))
			case strings.Contains(lastUser, "分镜"):
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"[{\"title\":\"第一幕\",\"theme\":\"中转站规划咖啡清晨\",\"text\":\"早安\",\"layout\":\"SC-001\"}]"}}]}`))
			case strings.Contains(lastUser, "分析下面文章"):
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"recommendedStyles\":[\"FA-001\"],\"slots\":[{\"role\":\"cover\",\"anchor\":\"\",\"title\":\"封面\",\"theme\":\"中转站封面\"},{\"role\":\"inline\",\"anchor\":\"第一段\",\"title\":\"正文\",\"theme\":\"中转站正文配图\"}]}"}}]}`))
			case strings.Contains(lastUser, "节点画布"):
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"nodes\":[{\"id\":\"n1\",\"type\":\"themes\",\"x\":80,\"y\":120,\"data\":{\"label\":\"主题\",\"items\":[\"雨夜咖啡\"]}}],\"edges\":[]}"}}]}`))
			default:
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"中转站扩写：清晨窗台暖阳下的手冲咖啡"}}]}`))
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockRelay.Close()

	var siteBatchHits, siteAnalyzeHits atomic.Int32
	var lastSiteBatchModel, lastSiteBatchSeed, lastSiteAnalyzeModel string
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/economy/public-models":
			_, _ = w.Write([]byte(`{
				"ok": true,
				"specifications": [{"model":"seedream-4.5","name":"Seedream 4.5","resolution":"1k","priceCents":10,"enabled":true}],
				"aiModels": [
					{"id":"deepseek-v3","name":"DeepSeek V3","capability":"text","isDefaultText":true,"isDefaultVision":false,"inputPriceMicrosPerM":240000,"outputPriceMicrosPerM":980000},
					{"id":"gemini-2.5-flash","name":"Gemini 2.5 Flash","capability":"both","isDefaultText":false,"isDefaultVision":true,"inputPriceMicrosPerM":300000,"outputPriceMicrosPerM":1200000}
				]
			}`))
		case "/api/studio/batch-plan":
			siteBatchHits.Add(1)
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			lastSiteBatchModel, _ = b["model"].(string)
			lastSiteBatchSeed, _ = b["seed"].(string)
			_, _ = w.Write([]byte(`{"ok":true,"source":"model","items":[{"subject":"线上扩写后的咖啡屋场景","layout":"SC-001"}]}`))
		case "/api/studio/analyze-style":
			siteAnalyzeHits.Add(1)
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			lastSiteAnalyzeModel, _ = b["model"].(string)
			_, _ = w.Write([]byte(`{"name":"线上视觉画风","traitsZh":"松散黑线、白底","traitsEn":"loose ink doodle","matches":["FA-001"]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	h := srv.Handler()

	// 1. Add third-party text+vision relay provider and check /models detection.
	rrProv := doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "relay1",
		"name":    "我的中转站",
		"kind":    "openai",
		"purpose": "text",
		"baseUrl": mockRelay.URL + "/v1",
		"apiKey":  "sk-relay-vision",
		"enabled": true,
		"models": []map[string]any{
			{"id": "deepseek-chat", "label": "deepseek-chat", "canVision": false},
			{"id": "gpt-4o", "label": "gpt-4o", "canVision": true},
		},
	})
	if rrProv.Code != 200 || strings.Contains(rrProv.Body.String(), "sk-relay-vision") {
		t.Fatalf("providerPut failed or leaked key: %d %s", rrProv.Code, rrProv.Body.String())
	}

	rrFetch := doReq(t, h, srv.Token, "POST", "/api/providers/relay1/models", nil)
	if rrFetch.Code != 200 {
		t.Fatalf("fetch models failed: %d %s", rrFetch.Code, rrFetch.Body.String())
	}
	var fetchOut struct {
		Models []struct {
			ID       string `json:"id"`
			IsImage  bool   `json:"isImage"`
			IsVision bool   `json:"isVision"`
		} `json:"models"`
	}
	_ = json.Unmarshal(rrFetch.Body.Bytes(), &fetchOut)
	visionFound := false
	for _, m := range fetchOut.Models {
		if m.ID == "gpt-4o" && m.IsVision && !m.IsImage {
			visionFound = true
		}
	}
	if !visionFound {
		t.Fatalf("expected gpt-4o to be detected as vision=true, image=false: %+v", fetchOut.Models)
	}

	// Test both text and vision connectivity on relay1.
	if rrTest := doReq(t, h, srv.Token, "POST", "/api/providers/relay1/test", map[string]any{"model": "deepseek-chat"}); rrTest.Code != 200 || !strings.Contains(rrTest.Body.String(), `"ok":true`) {
		t.Fatalf("text test failed: %d %s", rrTest.Code, rrTest.Body.String())
	}
	if rrVisTest := doReq(t, h, srv.Token, "POST", "/api/providers/relay1/test", map[string]any{"model": "gpt-4o", "vision": true}); rrVisTest.Code != 200 || !strings.Contains(rrVisTest.Body.String(), `"ok":true`) {
		t.Fatalf("vision test failed: %d %s", rrVisTest.Code, rrVisTest.Body.String())
	}

	// 2. Verify /api/models exposes siteAI alongside textProviders and defaults.
	rrMods := doReq(t, h, srv.Token, "GET", "/api/models", nil)
	if rrMods.Code != 200 {
		t.Fatalf("/api/models failed: %d %s", rrMods.Code, rrMods.Body.String())
	}
	var modsOut struct {
		SiteAI        []map[string]any `json:"siteAI"`
		TextProviders []map[string]any `json:"textProviders"`
	}
	_ = json.Unmarshal(rrMods.Body.Bytes(), &modsOut)
	if len(modsOut.SiteAI) != 2 || len(modsOut.TextProviders) != 1 {
		t.Fatalf("unexpected /api/models output: siteAI=%d textProvs=%d body=%s", len(modsOut.SiteAI), len(modsOut.TextProviders), rrMods.Body.String())
	}

	// 3. Default (site:auto) uses online site APIs directly when logged in.
	rrExpandSite := doReq(t, h, srv.Token, "POST", "/api/prompt/expand", map[string]any{"theme": "咖啡屋", "style": "FA-001"})
	if rrExpandSite.Code != 200 || !strings.Contains(rrExpandSite.Body.String(), `"source":"site"`) || lastSiteBatchSeed != "咖啡屋" {
		t.Fatalf("expected online site expand, got %d %s (seed=%q)", rrExpandSite.Code, rrExpandSite.Body.String(), lastSiteBatchSeed)
	}
	rrAnalyzeSite := doReq(t, h, srv.Token, "POST", "/api/mine/analyze", map[string]any{
		"images":   []string{"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="},
		"purpose":  "find",
		"modelRef": "site:gemini-2.5-flash",
	})
	if rrAnalyzeSite.Code != 200 || !strings.Contains(rrAnalyzeSite.Body.String(), `"source":"site"`) || lastSiteAnalyzeModel != "gemini-2.5-flash" {
		t.Fatalf("expected explicit online site analyze with model=gemini-2.5-flash, got %d %s (model=%q)", rrAnalyzeSite.Code, rrAnalyzeSite.Body.String(), lastSiteAnalyzeModel)
	}

	// 4. Configure settings to use custom relay models directly (even while logged into website!).
	rrPatch := doReq(t, h, srv.Token, "PATCH", "/api/settings", map[string]any{
		"defaultTextModel":   "relay1:deepseek-chat",
		"defaultVisionModel": "relay1:gpt-4o",
	})
	if rrPatch.Code != 200 {
		t.Fatalf("patchSettings failed: %d %s", rrPatch.Code, rrPatch.Body.String())
	}

	siteBatchBefore := siteBatchHits.Load()
	siteAnalyzeBefore := siteAnalyzeHits.Load()

	rrExpandRelay := doReq(t, h, srv.Token, "POST", "/api/prompt/expand", map[string]any{"theme": "手冲咖啡"})
	if rrExpandRelay.Code != 200 || !strings.Contains(rrExpandRelay.Body.String(), `"source":"provider"`) || lastRelayModel != "deepseek-chat" {
		t.Fatalf("expected relay expand, got %d %s (model=%q)", rrExpandRelay.Code, rrExpandRelay.Body.String(), lastRelayModel)
	}

	rrSeriesRelay := doReq(t, h, srv.Token, "POST", "/api/series/plan", map[string]any{"topic": "咖啡日记", "count": 1, "layoutMode": "ai"})
	if rrSeriesRelay.Code != 200 || !strings.Contains(rrSeriesRelay.Body.String(), `"source":"provider"`) || !strings.Contains(rrSeriesRelay.Body.String(), "中转站规划咖啡清晨") {
		t.Fatalf("expected relay series plan, got %d %s", rrSeriesRelay.Code, rrSeriesRelay.Body.String())
	}

	rrArticleRelay := doReq(t, h, srv.Token, "POST", "/api/article/plan", map[string]any{"title": "咖啡", "content": "第一段内容。"})
	if rrArticleRelay.Code != 200 || !strings.Contains(rrArticleRelay.Body.String(), `"source":"provider"`) || !strings.Contains(rrArticleRelay.Body.String(), "中转站正文配图") {
		t.Fatalf("expected relay article plan, got %d %s", rrArticleRelay.Code, rrArticleRelay.Body.String())
	}

	rrCanvasRelay := doReq(t, h, srv.Token, "POST", "/api/canvas/assistant", map[string]any{"prompt": "搭建咖啡工作流"})
	if rrCanvasRelay.Code != 200 || !strings.Contains(rrCanvasRelay.Body.String(), `"source":"provider"`) || !strings.Contains(rrCanvasRelay.Body.String(), "雨夜咖啡") {
		t.Fatalf("expected relay canvas assistant, got %d %s", rrCanvasRelay.Code, rrCanvasRelay.Body.String())
	}

	rrAnalyzeRelay := doReq(t, h, srv.Token, "POST", "/api/mine/analyze", map[string]any{
		"images":  []string{"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="},
		"purpose": "create",
	})
	if rrAnalyzeRelay.Code != 200 || !strings.Contains(rrAnalyzeRelay.Body.String(), `"source":"provider"`) || lastRelayModel != "gpt-4o" || !lastRelayHadImage.Load() {
		t.Fatalf("expected relay vision analyze with gpt-4o, got %d %s (model=%q, hadImg=%v)", rrAnalyzeRelay.Code, rrAnalyzeRelay.Body.String(), lastRelayModel, lastRelayHadImage.Load())
	}

	if siteBatchHits.Load() != siteBatchBefore || siteAnalyzeHits.Load() != siteAnalyzeBefore {
		t.Fatalf("custom relay selection should not call website endpoints: batch=%d->%d analyze=%d->%d",
			siteBatchBefore, siteBatchHits.Load(), siteAnalyzeBefore, siteAnalyzeHits.Load())
	}

	// 5. Explicit site:<modelId> while logged out must return 401.
	_ = secrets.Delete(secrets.SiteToken)
	rrOut := doReq(t, h, srv.Token, "POST", "/api/mine/analyze", map[string]any{
		"images":   []string{"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="},
		"modelRef": "site:gemini-2.5-flash",
	})
	if rrOut.Code != 401 {
		t.Fatalf("expected 401 for explicit site vision model when logged out, got %d %s", rrOut.Code, rrOut.Body.String())
	}
	_ = lastSiteBatchModel
}

func TestAnalyzeSiteUnavailableGuidance(t *testing.T) {
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"Not found"}`))
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	h := srv.Handler()

	rr := doReq(t, h, srv.Token, "POST", "/api/mine/analyze", map[string]any{
		"images":  []string{"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="},
		"purpose": "find",
	})
	if rr.Code != 503 || !strings.Contains(rr.Body.String(), "第三方中转站") {
		t.Fatalf("expected 503 guidance when site analyze-style returns 404 and no relay configured, got %d %s", rr.Code, rr.Body.String())
	}
}
