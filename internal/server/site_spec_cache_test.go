package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/skills"
)

func TestSiteSpecIDResolutionAndChatPromptCaching(t *testing.T) {
	var lastQuoteSpecID, lastQuoteRes string
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/economy/public-models":
			_, _ = w.Write([]byte(`{
				"ok": true,
				"specifications": [
					{"id": "image-gpt-image-2-5-deadbeef-1k", "name": "gpt-image-2.5 1K", "model": "gpt-image-2.5", "resolution": "1k", "quality": "standard", "priceCents": 0, "enabled": true, "verified": true}
				],
				"policies": [{"resolution": "1k", "freeUnits": 100}]
			}`))
		case "/api/studio/quote":
			var body struct {
				Items []struct {
					SpecID     string `json:"specId"`
					Resolution string `json:"resolution"`
				} `json:"items"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Items) == 0 || body.Items[0].SpecID != "image-gpt-image-2-5-deadbeef-1k" {
				w.WriteHeader(409)
				_, _ = w.Write([]byte(`{"error":{"code":"spec_unavailable","message":"此生图规格尚未验证开放，请联系管理员配置"}}`))
				return
			}
			lastQuoteSpecID = body.Items[0].SpecID
			lastQuoteRes = body.Items[0].Resolution
			_, _ = w.Write([]byte(`{"quoteId":"q_verified_1","totalCents":0,"freeCount":1}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	var capturedSystems []string
	var capturedCacheKey string
	mockRelay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/chat/completions" {
			var req struct {
				PromptCacheKey string `json:"prompt_cache_key"`
				Messages       []struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			capturedCacheKey = req.PromptCacheKey
			for _, m := range req.Messages {
				if m.Role == "system" {
					capturedSystems = append(capturedSystems, m.Content)
					break
				}
			}
			_, _ = w.Write([]byte(`{
				"choices":[{"finish_reason":"stop","message":{"content":"缓存测试回复"}}],
				"usage":{
					"prompt_tokens": 1800,
					"completion_tokens": 40,
					"total_tokens": 1840,
					"prompt_tokens_details": {"cached_tokens": 1500}
				}
			}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer mockRelay.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	srv.Skills = skills.New(filepath.Join(t.TempDir(), "skills"))
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	_ = secrets.Set(secrets.SiteToken, "hwt_test_spec")
	h := srv.Handler()

	// 1. Quote for site:gpt-image-2.5 with requested 2k -> resolves verified 1k specId automatically!
	rrQ := doReq(t, h, srv.Token, "POST", "/api/quote", map[string]any{
		"modelRef":   "site:gpt-image-2.5",
		"resolution": "2k",
		"count":      1,
	})
	if rrQ.Code != 200 {
		t.Fatalf("quote failed: %d %s", rrQ.Code, rrQ.Body.String())
	}
	if lastQuoteSpecID != "image-gpt-image-2-5-deadbeef-1k" || lastQuoteRes != "1k" {
		t.Fatalf("expected resolved specId & 1k, got specId=%q res=%q", lastQuoteSpecID, lastQuoteRes)
	}

	// 2. Generate with site:gpt-image-2.5 (empty resolution as sent by chat) -> passes verified specId!
	rrGen := doReq(t, h, srv.Token, "POST", "/api/generate", map[string]any{
		"mode":     "single",
		"title":    "秋天咖啡馆",
		"modelRef": "site:gpt-image-2.5",
		"items":    []map[string]any{{"theme": "秋天咖啡馆手绘海报", "style": "FA-001", "ratio": "3:4"}},
	})
	if rrGen.Code != 200 {
		t.Fatalf("generate with site:gpt-image-2.5 failed: %d %s", rrGen.Code, rrGen.Body.String())
	}

	// 3. Prompt cache stability: changing ratio & imageModelRef between turns keeps system prompt byte-identical!
	doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "cacherelay",
		"name":    "缓存中转",
		"kind":    "openai",
		"purpose": "text",
		"baseUrl": mockRelay.URL + "/v1",
		"apiKey":  "sk-cache",
		"enabled": true,
		"models":  []map[string]any{{"id": "gpt-4o", "name": "GPT-4o"}},
	})

	rrT1 := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"sessionId":     "sess_cache_1",
		"messages":      []map[string]string{{"role": "user", "content": "第一轮聊聊咖啡"}},
		"textModelRef":  "cacherelay:gpt-4o",
		"imageModelRef": "site:gpt-image-2.5",
		"ratio":         "3:4",
		"skillIds":      []string{},
	})
	if rrT1.Code != 200 {
		t.Fatalf("turn 1 failed: %d %s", rrT1.Code, rrT1.Body.String())
	}
	var res1 chatTurnResponse
	_ = json.Unmarshal(rrT1.Body.Bytes(), &res1)
	if res1.Usage == nil || res1.Usage.CacheReadTokens != 1500 {
		t.Fatalf("expected cache_read_tokens=1500 in usage, got %+v", res1.Usage)
	}
	if capturedCacheKey != "handraw-chat:sess_cache_1" {
		t.Fatalf("expected prompt_cache_key handraw-chat:sess_cache_1, got %q", capturedCacheKey)
	}

	rrT2 := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"sessionId":     "sess_cache_1",
		"messages":      []map[string]string{{"role": "user", "content": "第一轮聊聊咖啡"}, {"role": "assistant", "content": "缓存测试回复"}, {"role": "user", "content": "换个横屏比例"}},
		"textModelRef":  "cacherelay:gpt-4o",
		"imageModelRef": "site:seedream-4.5",
		"ratio":         "16:9",
		"skillIds":      []string{},
	})
	if rrT2.Code != 200 {
		t.Fatalf("turn 2 failed: %d %s", rrT2.Code, rrT2.Body.String())
	}
	if len(capturedSystems) != 2 {
		t.Fatalf("expected 2 captured system prompts, got %d", len(capturedSystems))
	}
	if capturedSystems[0] != capturedSystems[1] {
		t.Fatalf("system prompt must remain byte-identical across ratio/imageModel changes for prompt caching!")
	}
	if !strings.Contains(capturedSystems[0], "FA-001:") {
		t.Fatalf("expected compact static catalog inside cached system prompt prefix")
	}
}
