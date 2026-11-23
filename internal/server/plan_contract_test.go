package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/prompt"
	"github.com/yang0/handraw-client/internal/secrets"
)

func TestPlanningWebsiteContracts(t *testing.T) {
	var batchRequest, articleRequest map[string]any
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/batch-plan":
			_ = json.NewDecoder(r.Body).Decode(&batchRequest)
			_, _ = w.Write([]byte(`{"source":"model","items":[{"subject":"咖啡馆晨光","layout":"SC-001"}]}`))
		case "/api/studio/article-plan":
			_ = json.NewDecoder(r.Body).Decode(&articleRequest)
			_, _ = w.Write([]byte(`{"source":"model","cover":{"subject":"书桌上的咖啡","purpose":"封面"},"illustrations":[{"afterBlockIdx":1,"subject":"萃取流程图","layout":"SC-001"}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()
	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_planning")
	h := srv.Handler()

	batch := doReq(t, h, srv.Token, "POST", "/api/series/plan", map[string]any{
		"topic": "咖啡", "count": 3, "layoutMode": "fixed", "fixedLayout": "SC-001",
		"layoutRequirement": "步骤图", "styleId": "FA-001",
	})
	if batch.Code != 200 {
		t.Fatalf("batch planning: %d %s", batch.Code, batch.Body.String())
	}
	if batchRequest["seed"] != "咖啡" || batchRequest["layoutMode"] != "fixed" || batchRequest["fixedLayout"] != "SC-001" || batchRequest["styleId"] != "FA-001" {
		t.Fatalf("wrong website batch request: %#v", batchRequest)
	}
	var batchResponse struct{ Cards []map[string]string }
	_ = json.Unmarshal(batch.Body.Bytes(), &batchResponse)
	if len(batchResponse.Cards) != 1 || batchResponse.Cards[0]["theme"] != "咖啡馆晨光" || batchResponse.Cards[0]["layout"] != "SC-001" {
		t.Fatalf("website subjects were not normalized: %s", batch.Body.String())
	}

	article := doReq(t, h, srv.Token, "POST", "/api/article/plan", map[string]any{
		"title": "手冲", "content": "# 手冲\n\n控制水温与萃取时间。", "styleId": "FA-002",
		"coverRatio": "5:2", "inlineRatio": "3:4", "includeCover": true,
	})
	if article.Code != 200 {
		t.Fatalf("article planning: %d %s", article.Code, article.Body.String())
	}
	if articleRequest["coverRatio"] != "5:2" || articleRequest["inlineRatio"] != "3:4" || articleRequest["styleId"] != "FA-002" || articleRequest["charCount"] == nil {
		t.Fatalf("wrong website article request: %#v", articleRequest)
	}
	blocks, _ := articleRequest["blocks"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("expected parsed article blocks, got %#v", blocks)
	}
	var articleResponse struct{ Slots []map[string]any }
	_ = json.Unmarshal(article.Body.Bytes(), &articleResponse)
	if len(articleResponse.Slots) != 2 || articleResponse.Slots[0]["ratio"] != "5:2" || articleResponse.Slots[1]["ratio"] != "3:4" || articleResponse.Slots[1]["anchor"] != "控制水温与萃取时间。" {
		t.Fatalf("website article plan lost ratio or anchor: %s", article.Body.String())
	}
}

func TestArticleLocalPlanRespectsSettings(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	_ = secrets.Delete(secrets.SiteToken)
	rr := doReq(t, srv.Handler(), srv.Token, "POST", "/api/article/plan", map[string]any{
		"title": "短文", "content": "第一段。\n\n第二段。", "includeCover": false, "inlineRatio": "1:1",
	})
	if rr.Code != 200 {
		t.Fatal(rr.Body.String())
	}
	var response struct {
		Source string
		Slots  []map[string]any
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &response)
	if response.Source != "local" || len(response.Slots) == 0 {
		t.Fatalf("expected disclosed local fallback: %s", rr.Body.String())
	}
	for _, slot := range response.Slots {
		if slot["role"] == "cover" || slot["ratio"] != "1:1" {
			t.Fatalf("local plan ignored article settings: %#v", slot)
		}
	}
}

func TestSeriesCardResponseShapes(t *testing.T) {
	for _, raw := range []string{
		`[{"theme":"主题","text":"文案","layout":"SC-001"}]`,
		`{"cards":[{"theme":"主题","text":"文案","layout":"SC-001"}]}`,
		`{"items":[{"subject":"主题","text":"文案","layout":"SC-001"}]}`,
	} {
		cards := seriesCards(json.RawMessage(raw))
		if len(cards) != 1 || cards[0]["theme"] != "主题" || cards[0]["text"] != "文案" {
			t.Fatalf("unsupported plan shape %s: %#v", raw, cards)
		}
	}
	if len(seriesCards(json.RawMessage(`{"items":[{"subject":""}]}`))) != 0 {
		t.Fatal("empty themes must not become generation cards")
	}
}

func TestArticlePlanFiltersCoverAndPreservesExactAnchor(t *testing.T) {
	slots, _ := articleSlots(json.RawMessage(`{"cover":{"subject":"封面"},"illustrations":[{"subject":"配图","anchorText":"中文锚点"}]}`), "中文锚点", "5:2", "4:3", false)
	if len(slots) != 1 || slots[0]["role"] != "inline" || !strings.Contains(slots[0]["anchor"].(string), "中文锚点") {
		t.Fatalf("unexpected slots: %#v", slots)
	}
}

func TestPosterUsesGraphicTextPrompt(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	result, err := prompt.Build(srv.Pack(), srv.Rules(), prompt.Input{
		Style: "FA-001", Theme: "咖啡馆海报", Mode: "poster", Ratio: "9:16",
		Extra: "海报设计，突出主标题与视觉层级。",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.GraphicText || !strings.Contains(result.Zh, "文字参与构图") || !strings.Contains(result.Zh, "突出主标题") {
		t.Fatalf("poster lost graphic-text composition: %#v", result)
	}
}

func TestPlanningTemplateProvenance(t *testing.T) {
	if planningSource(json.RawMessage(`{"source":"template"}`)) != "local" {
		t.Fatal("a template must not be presented as an AI plan")
	}
}

func TestArticlePlanFallsBackToSiteAIChatWhenEndpointReturnsTemplateOrFails(t *testing.T) {
	var aiChatHits int
	endpointStatus := http.StatusOK
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/article-plan":
			if endpointStatus != http.StatusOK {
				w.WriteHeader(endpointStatus)
				_, _ = w.Write([]byte(`{"error":"article-plan unavailable"}`))
				return
			}
			_, _ = w.Write([]byte(`{"source":"template","cover":{"subject":"模板封面"},"illustrations":[{"afterBlockIdx":0,"subject":"模板切片"}]}`))
		case "/api/ai/chat":
			aiChatHits++
			payload := map[string]any{
				"content": `{"recommendedStyles":["FA-013","FB-001"],"slots":[{"role":"cover","anchor":"","title":"温暖背影","theme":"柔和暖黄灯光下，母亲在厨房台灯旁安静切水果的手绘插画"},{"role":"inline","anchor":"妈妈不是天生就会当妈妈","title":"柔软瞬间","theme":"窗边雨滴与热茶雾气交织，温暖手掌轻覆孩子肩头的细腻画面"}]}`,
				"service": "官方智能文字服务",
			}
			_ = json.NewEncoder(w).Encode(payload)
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_ai_plan")
	h := srv.Handler()

	content := "# 母亲节\n\n> 妈妈不是天生就会当妈妈，她只是在你出生的那一刻，决定把所有柔软都留给你。\n\n我们总以为来日方长。"

	// Case 1: /api/studio/article-plan returns "template" -> must upgrade to Site AIChat.
	rr := doReq(t, h, srv.Token, "POST", "/api/article/plan", map[string]any{
		"title": "母亲节", "content": content, "includeCover": true,
	})
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Source string           `json:"source"`
		Model  string           `json:"model"`
		Slots  []map[string]any `json:"slots"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Source != "site" || aiChatHits != 1 {
		t.Fatalf("expected AI chat fallback (source=site, hits=1), got source=%q hits=%d body=%s", resp.Source, aiChatHits, rr.Body.String())
	}
	if len(resp.Slots) != 2 || !strings.Contains(resp.Slots[1]["theme"].(string), "热茶雾气") {
		t.Fatalf("expected AI-designed visual theme, got %#v", resp.Slots)
	}
	if anchor, _ := resp.Slots[1]["anchor"].(string); !strings.Contains(content, anchor) {
		t.Fatalf("anchor must exist verbatim in content, got %q", anchor)
	}

	// Case 2: /api/studio/article-plan returns 500 -> must also upgrade to Site AIChat.
	endpointStatus = http.StatusInternalServerError
	rr2 := doReq(t, h, srv.Token, "POST", "/api/article/plan", map[string]any{
		"title": "母亲节", "content": content, "includeCover": true,
	})
	if rr2.Code != 200 || aiChatHits != 2 {
		t.Fatalf("expected AI chat fallback on 500, got code=%d hits=%d body=%s", rr2.Code, aiChatHits, rr2.Body.String())
	}
}

func TestArticleGenerateMapsSiteCreationSourceAwayFromCloudArticle(t *testing.T) {
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/studio/quote":
			_, _ = w.Write([]byte(`{"quoteId":"q_test","model":"gpt-image-2.5","specId":"spec_1","resolution":"2k","quality":"auto","ratio":"4:3","priceCents":0,"freeQuotaRemaining":10,"balanceCents":100,"freeEligible":true}`))
		case "/api/studio/generate":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["creationSource"] == "article" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"文章配图必须指定已保存的文章与配图位"}`))
				return
			}
			_, _ = w.Write([]byte(`{"taskId":"task_1","status":"done","imageUrl":""}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_article_gen")
	h := srv.Handler()

	// Single article slot generation -> local run.Mode="article", siteBody.creationSource="single"
	rr1 := doReq(t, h, srv.Token, "POST", "/api/generate", map[string]any{
		"mode": "article", "title": "母亲节", "modelRef": "site:gpt-image-2.5", "confirmed": true,
		"items": []map[string]any{{"theme": "厨房暖灯", "style": "FA-001", "ratio": "4:3", "mode": "graphic-text"}},
	})
	if rr1.Code != 200 {
		t.Fatalf("single article generate failed: %d %s", rr1.Code, rr1.Body.String())
	}
	var out1 struct {
		Run    struct{ Mode string } `json:"run"`
		Images []struct {
			Meta json.RawMessage `json:"meta"`
		} `json:"images"`
	}
	if err := json.Unmarshal(rr1.Body.Bytes(), &out1); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out1.Run.Mode != "article" {
		t.Fatalf("expected local run.Mode=article, got %q", out1.Run.Mode)
	}
	var meta1 struct {
		SiteBody map[string]any `json:"siteBody"`
	}
	_ = json.Unmarshal(out1.Images[0].Meta, &meta1)
	if meta1.SiteBody["creationSource"] != "single" {
		t.Fatalf("expected siteBody.creationSource=single for 1 article slot, got %#v", meta1.SiteBody["creationSource"])
	}

	// Multi-slot article generation -> siteBody.creationSource="series"
	rr2 := doReq(t, h, srv.Token, "POST", "/api/generate", map[string]any{
		"mode": "article", "title": "母亲节", "modelRef": "site:gpt-image-2.5", "confirmed": true,
		"items": []map[string]any{
			{"theme": "封面", "style": "FA-001", "ratio": "2.35:1", "mode": "graphic-text"},
			{"theme": "正文配图", "style": "FA-001", "ratio": "4:3", "mode": "graphic-text"},
		},
	})
	if rr2.Code != 200 {
		t.Fatalf("multi article generate failed: %d %s", rr2.Code, rr2.Body.String())
	}
	var out2 struct {
		Images []struct {
			Meta json.RawMessage `json:"meta"`
		} `json:"images"`
	}
	_ = json.Unmarshal(rr2.Body.Bytes(), &out2)
	var meta2 struct {
		SiteBody map[string]any `json:"siteBody"`
	}
	_ = json.Unmarshal(out2.Images[0].Meta, &meta2)
	if meta2.SiteBody["creationSource"] != "series" {
		t.Fatalf("expected siteBody.creationSource=series for 2+ article slots, got %#v", meta2.SiteBody["creationSource"])
	}
}
