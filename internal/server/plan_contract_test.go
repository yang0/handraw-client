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
