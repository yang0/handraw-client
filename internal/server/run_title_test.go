package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/yang0/handraw-client/internal/store"
)

func TestResolveRunTitle(t *testing.T) {
	cases := []struct {
		name       string
		rawTitle   string
		items      []generateItem
		itemThemes []string
		fallback   string
		want       string
	}{
		{
			name:     "unnamed canvas combo falls back to cleaned cover theme",
			rawTitle: "未命名画布 · 组合",
			items: []generateItem{
				{Theme: "封面：手冲咖啡新手 5大避坑指南（视觉冲击主图）"},
				{Theme: "1. 水温太高容易苦涩"},
			},
			itemThemes: []string{"封面：手冲咖啡新手 5大避坑指南（视觉冲击主图）", "1. 水温太高容易苦涩"},
			fallback:   "手绘风创作",
			want:       "手冲咖啡新手 5大避坑指南",
		},
		{
			name:     "param canvas combo falls back to item text when theme is generic",
			rawTitle: "参数组合画布 · 组合",
			items: []generateItem{
				{Theme: "手绘视觉主题展示", Text: "把闹钟关掉，让周末自己走一会儿"},
			},
			itemThemes: []string{"手绘视觉主题展示"},
			fallback:   "手绘风创作",
			want:       "把闹钟关掉，让周末自己走一会儿",
		},
		{
			name:       "explicit user canvas title strips redundant combo suffix",
			rawTitle:   "春季咖啡手账 · 组合",
			items:      []generateItem{{Theme: "其他主题"}},
			itemThemes: []string{"其他主题"},
			fallback:   "手绘风创作",
			want:       "春季咖啡手账",
		},
		{
			name:       "series placeholder preserves sample suffix with real card theme",
			rawTitle:   "系列图 · 样张",
			items:      []generateItem{{Theme: "P1：极简桌面改造清单"}},
			itemThemes: []string{"P1：极简桌面改造清单"},
			fallback:   "手绘风创作",
			want:       "极简桌面改造清单 · 样张",
		},
		{
			name:       "cover keyword inside real title is preserved",
			rawTitle:   "",
			items:      []generateItem{{Theme: "封面设计新手必看 5 个构图技巧"}},
			itemThemes: []string{"封面设计新手必看 5 个构图技巧"},
			fallback:   "手绘风创作",
			want:       "封面设计新手必看 5 个构图技巧",
		},
		{
			name:       "fallback used when everything is placeholder",
			rawTitle:   "未命名画布 · 组合",
			items:      []generateItem{{Theme: "手绘视觉主题展示"}},
			itemThemes: []string{"手绘视觉主题展示"},
			fallback:   "手绘风创作",
			want:       "手绘风创作",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveRunTitle(tc.rawTitle, tc.items, tc.itemThemes, tc.fallback)
			if got != tc.want {
				t.Fatalf("resolveRunTitle(%q) = %q, want %q", tc.rawTitle, got, tc.want)
			}
		})
	}
}

func TestWorksAPIReplacesLegacyPlaceholderTitles(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// Seed two legacy runs matching the bug report ("未命名画布 · 组合" & "参数组合画布 · 组合").
	run1 := &store.Run{
		ID:              "run_legacy_canvas_1",
		Mode:            "canvas",
		Title:           "未命名画布 · 组合",
		OriginalRequest: "封面：手冲咖啡新手 5大避坑指南（视觉冲击主图）",
		Status:          "done",
	}
	if err := srv.DB.InsertRun(run1, []store.Image{{
		ID:     "img_legacy_1",
		RunID:  run1.ID,
		Idx:    0,
		Theme:  "封面：手冲咖啡新手 5大避坑指南（视觉冲击主图）",
		Status: "done",
		Path:   "img1.png",
	}}); err != nil {
		t.Fatalf("InsertRun run1: %v", err)
	}

	run2 := &store.Run{
		ID:              "run_legacy_canvas_2",
		Mode:            "canvas",
		Title:           "参数组合画布 · 组合",
		OriginalRequest: "手绘视觉主题展示",
		PromptZh:        "温暖手绘插画，画面文字：「把闹钟关掉，让周末自己走一会儿」，一只橘猫在草地上打盹",
		Status:          "done",
	}
	if err := srv.DB.InsertRun(run2, []store.Image{{
		ID:     "img_legacy_2",
		RunID:  run2.ID,
		Idx:    0,
		Theme:  "手绘视觉主题展示",
		Prompt: run2.PromptZh,
		Status: "done",
		Path:   "img2.png",
	}}); err != nil {
		t.Fatalf("InsertRun run2: %v", err)
	}

	rrList := doReq(t, h, srv.Token, http.MethodGet, "/api/works?limit=10", nil)
	if rrList.Code != http.StatusOK {
		t.Fatalf("GET /api/works status=%d body=%s", rrList.Code, rrList.Body.String())
	}
	var listResp struct {
		Items []store.Run `json:"items"`
	}
	if err := json.Unmarshal(rrList.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("unmarshal /api/works: %v", err)
	}
	gotByID := map[string]string{}
	for _, it := range listResp.Items {
		gotByID[it.ID] = it.Title
	}
	if gotByID[run1.ID] != "手冲咖啡新手 5大避坑指南" {
		t.Fatalf("run1 list title = %q, want %q", gotByID[run1.ID], "手冲咖啡新手 5大避坑指南")
	}
	if gotByID[run2.ID] != "把闹钟关掉，让周末自己走一会儿" {
		t.Fatalf("run2 list title = %q, want %q", gotByID[run2.ID], "把闹钟关掉，让周末自己走一会儿")
	}

	rrDetail := doReq(t, h, srv.Token, http.MethodGet, "/api/works/"+run1.ID, nil)
	if rrDetail.Code != http.StatusOK {
		t.Fatalf("GET /api/works/%s status=%d", run1.ID, rrDetail.Code)
	}
	var detailResp struct {
		Run store.Run `json:"run"`
	}
	if err := json.Unmarshal(rrDetail.Body.Bytes(), &detailResp); err != nil {
		t.Fatalf("unmarshal /api/works/{id}: %v", err)
	}
	if detailResp.Run.Title != "手冲咖啡新手 5大避坑指南" {
		t.Fatalf("run1 detail title = %q, want %q", detailResp.Run.Title, "手冲咖啡新手 5大避坑指南")
	}
}
