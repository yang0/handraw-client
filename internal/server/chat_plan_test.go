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

func TestStudioChatPlanRoutingAndFallback(t *testing.T) {
	var siteChatHits, siteBatchHits, relayHits atomic.Int32
	var siteChatFail403 atomic.Bool
	var lastSiteBody map[string]any

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/chat-plan":
			siteChatHits.Add(1)
			_ = json.NewDecoder(r.Body).Decode(&lastSiteBody)
			if siteChatFail403.Load() {
				w.WriteHeader(403)
				_, _ = w.Write([]byte(`{"error":"forbidden_scope"}`))
				return
			}
			_, _ = w.Write([]byte(`{
				"ok": true,
				"kind": "multi",
				"reply": "网站已为你规划 3 张咖啡主题插画。",
				"common": {
					"style1": "FA-001",
					"mode": "graphic-text",
					"ratio": "3:4",
					"colors": ["C-001"]
				},
				"items": [
					{"index":1,"title":"清晨手冲","subject":"清晨窗台手冲咖啡","displayCopy":"早安咖啡","layout":"SC-001","ratio":"3:4"},
					{"index":2,"title":"拿铁拉花","subject":"木桌上的天鹅拿铁拉花","displayCopy":"午后微甜","layout":"SC-001","ratio":"3:4"},
					{"index":3,"title":"雨夜书店","subject":"雨夜温暖灯光下的咖啡角","displayCopy":"晚安时刻","layout":"SC-001","ratio":"3:4"}
				]
			}`))
		case "/api/studio/batch-plan":
			siteBatchHits.Add(1)
			_, _ = w.Write([]byte(`{"ok":true,"source":"model","items":[{"title":"图1","subject":"批规划场景1","layout":"SC-001"},{"title":"图2","subject":"批规划场景2","layout":"SC-001"}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	mockRelay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/chat/completions" {
			relayHits.Add(1)
			var req struct {
				Messages []struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			last := req.Messages[len(req.Messages)-1].Content
			if strings.Contains(last, "海报") {
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"kind\":\"single\",\"reply\":\"中转站已设计单张海报方案\",\"common\":{\"style1\":\"FA-001\",\"mode\":\"poster\",\"ratio\":\"9:16\"},\"items\":[{\"index\":1,\"title\":\"春日市集\",\"subject\":\"春日手作市集暖阳插画\",\"displayCopy\":\"春日手作市集\",\"ratio\":\"9:16\"}]}"}}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"kind\":\"multi\",\"reply\":\"中转站已规划 2 张手账\",\"common\":{\"style1\":\"FA-001\",\"mode\":\"graphic-text\",\"ratio\":\"3:4\"},\"items\":[{\"index\":1,\"title\":\"晨光\",\"subject\":\"窗边手账与热茶\",\"layout\":\"SC-001\"},{\"index\":2,\"title\":\"夜读\",\"subject\":\"台灯下的水彩笔记\",\"layout\":\"SC-001\"}]}"}}]}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer mockRelay.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	_ = secrets.Delete(secrets.SiteToken)
	h := srv.Handler()

	// 1. Offline / unauthenticated local single-image plan.
	rrSingle := doReq(t, h, srv.Token, "POST", "/api/studio/chat-plan", map[string]any{
		"message": "雨夜街角温暖灯光下的猫咪书店",
		"selected": map[string]any{
			"mode":  "graphic-text",
			"ratio": "4:3",
		},
	})
	if rrSingle.Code != 200 {
		t.Fatalf("local single chat-plan status=%d body=%s", rrSingle.Code, rrSingle.Body.String())
	}
	var singleRes chatPlanResponse
	if err := json.Unmarshal(rrSingle.Body.Bytes(), &singleRes); err != nil {
		t.Fatal(err)
	}
	if singleRes.Source != "local" || singleRes.Kind != "single" || len(singleRes.Items) != 1 {
		t.Fatalf("unexpected local single response: %+v", singleRes)
	}
	if singleRes.Common.Style1 == "" || singleRes.Common.Ratio != "4:3" {
		t.Fatalf("expected default style and preserved ratio 4:3, got %+v", singleRes.Common)
	}

	// 2. Offline local multi-image intent detection ("画 4 张..." & multi-line list).
	rrMulti := doReq(t, h, srv.Token, "POST", "/api/studio/chat-plan", map[string]any{
		"message": "帮我画4张咖啡店治愈日常手账",
		"selected": map[string]any{
			"style1": "FA-001",
			"mode":   "graphic-text",
		},
	})
	if rrMulti.Code != 200 {
		t.Fatalf("local multi status=%d body=%s", rrMulti.Code, rrMulti.Body.String())
	}
	var multiRes chatPlanResponse
	_ = json.Unmarshal(rrMulti.Body.Bytes(), &multiRes)
	if multiRes.Kind != "multi" || len(multiRes.Items) != 4 || !multiRes.StyleLocked || multiRes.Common.Style1 != "FA-001" {
		t.Fatalf("unexpected local multi response: %+v", multiRes)
	}

	rrLines := doReq(t, h, srv.Token, "POST", "/api/studio/chat-plan", map[string]any{
		"message": "1. 清晨手冲咖啡\n2. 午后猫咪打盹\n3. 傍晚烘培香气",
		"selected": map[string]any{
			"mode": "pure-image",
		},
	})
	var linesRes chatPlanResponse
	_ = json.Unmarshal(rrLines.Body.Bytes(), &linesRes)
	if linesRes.Kind != "multi" || len(linesRes.Items) != 3 {
		t.Fatalf("expected 3 items from multi-line list, got %+v", linesRes)
	}
	if linesRes.Items[0].Subject != "清晨手冲咖啡" || linesRes.Items[0].Layout != "" {
		t.Fatalf("unexpected parsed line item in pure-image mode: %+v", linesRes.Items[0])
	}

	// 3. Logged-in auto mode routes to site /api/studio/chat-plan and forwards history.
	_ = secrets.Set(secrets.SiteToken, "hwt_test_chat_plan")
	rrSite := doReq(t, h, srv.Token, "POST", "/api/studio/chat-plan", map[string]any{
		"message": "再来 3 张咖啡日常，换温暖一点",
		"history": []map[string]string{
			{"role": "user", "content": "画咖啡主题"},
			{"role": "assistant", "content": "已规划咖啡方案"},
		},
		"selected": map[string]any{"ratio": "3:4"},
	})
	if rrSite.Code != 200 {
		t.Fatalf("site chat-plan failed: %d %s", rrSite.Code, rrSite.Body.String())
	}
	var siteRes chatPlanResponse
	_ = json.Unmarshal(rrSite.Body.Bytes(), &siteRes)
	if siteRes.Source != "site" || siteRes.Kind != "multi" || len(siteRes.Items) != 3 {
		t.Fatalf("unexpected site chat-plan response: %+v", siteRes)
	}
	if siteChatHits.Load() != 1 {
		t.Fatalf("expected 1 site chat-plan hit, got %d", siteChatHits.Load())
	}
	if hist, ok := lastSiteBody["history"].([]any); !ok || len(hist) != 2 {
		t.Fatalf("expected 2 history turns forwarded to site, got %#v", lastSiteBody["history"])
	}

	// 4. Site returns 403 (before website scope rollout) -> auto mode falls back cleanly to batch-plan for multi.
	siteChatFail403.Store(true)
	rrFallback := doReq(t, h, srv.Token, "POST", "/api/studio/chat-plan", map[string]any{
		"message": "出一套2张早安咖啡插画",
	})
	if rrFallback.Code != 200 {
		t.Fatalf("fallback status=%d body=%s", rrFallback.Code, rrFallback.Body.String())
	}
	var fbRes chatPlanResponse
	_ = json.Unmarshal(rrFallback.Body.Bytes(), &fbRes)
	if fbRes.Source != "site" || fbRes.Kind != "multi" || len(fbRes.Items) != 2 || siteBatchHits.Load() != 1 {
		t.Fatalf("expected fallback to site batch-plan, got %+v (batchHits=%d)", fbRes, siteBatchHits.Load())
	}

	// 5. Third-party OpenAI text provider explicit routing (single poster without locked mode).
	rrProv := doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "chatrelay",
		"name":    "测试文本中转",
		"kind":    "openai",
		"purpose": "text",
		"baseUrl": mockRelay.URL + "/v1",
		"apiKey":  "sk-test",
		"enabled": true,
		"models":  []map[string]any{{"id": "gpt-4o-mini", "name": "GPT-4o Mini"}},
	})
	if rrProv.Code != 200 {
		t.Fatalf("add provider failed: %d %s", rrProv.Code, rrProv.Body.String())
	}
	rrCustom := doReq(t, h, srv.Token, "POST", "/api/studio/chat-plan", map[string]any{
		"message":  "做一个春日手作市集海报",
		"modelRef": "chatrelay:gpt-4o-mini",
		"selected": map[string]any{},
	})
	if rrCustom.Code != 200 {
		t.Fatalf("custom provider chat-plan failed: %d %s", rrCustom.Code, rrCustom.Body.String())
	}
	var customRes chatPlanResponse
	_ = json.Unmarshal(rrCustom.Body.Bytes(), &customRes)
	if customRes.Source != "provider" || customRes.Kind != "single" || customRes.Common.Mode != "poster" || customRes.Common.Ratio != "9:16" {
		t.Fatalf("unexpected custom provider response: %+v", customRes)
	}
	if relayHits.Load() != 1 {
		t.Fatalf("expected 1 relay hit, got %d", relayHits.Load())
	}
}
