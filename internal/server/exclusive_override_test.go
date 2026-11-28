package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

func TestExclusiveStyleOverridesStaticPackCodes(t *testing.T) {
	fakeSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/community/resources" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"items": []map[string]any{
					{
						"id":            "FA-001",
						"code":          "FA-001",
						"kind":          "style",
						"sourceType":    "exclusive",
						"group":         "FA 国际社论幽默 / Editorial & Humor Doodle",
						"name":          "松散黑线冷幽默涂鸦",
						"description":   "官网限定原创画风《松散黑线冷幽默涂鸦》，2 积分解锁。",
						"image":         "/uploads/EXCL-FA-001-ec800c3e.webp",
						"author":        "",
						"authorName":    "手绘风官方",
						"unlockCost":    2,
						"unlocked":      false,
						"isMine":        false,
						"promptHidden":  true,
						"siteModelOnly": true,
					},
				},
			})
		case r.URL.Path == "/api/economy/public-models" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"specifications": []map[string]any{
					{"id": "spec-1", "model": "seedream-4.5", "resolution": "1k", "quality": "standard", "enabled": true, "verified": true},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer fakeSite.Close()

	srv, cancel := setupTestServer(t, fakeSite.URL)
	defer cancel()
	h := srv.Handler()
	_ = secrets.Set(secrets.SiteToken, "tok_test_exclusive")
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	// 1. Summary deduplicates overridden FA-001 and exposes EXCLUSIVE group without double-counting.
	rrSum := doReq(t, h, srv.Token, http.MethodGet, "/api/resources/summary", nil)
	if rrSum.Code != http.StatusOK {
		t.Fatalf("GET /api/resources/summary failed: %d %s", rrSum.Code, rrSum.Body.String())
	}
	var sumResp struct {
		Counts map[string]int `json:"counts"`
		Groups []struct {
			Code  string `json:"code"`
			Zh    string `json:"zh"`
			Count int    `json:"count"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(rrSum.Body.Bytes(), &sumResp); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if sumResp.Counts["styles"] != 2 {
		t.Fatalf("expected deduplicated style count 2 (FA-001 override + FA-002), got %d", sumResp.Counts["styles"])
	}
	foundExclGroup := false
	for _, g := range sumResp.Groups {
		if g.Code == "EXCLUSIVE" {
			foundExclGroup = true
			if g.Count != 1 {
				t.Fatalf("expected EXCLUSIVE group count 1, got %d", g.Count)
			}
		}
		if g.Code == "FA" && g.Count != 2 {
			t.Fatalf("expected FA group count 2 (no double count), got %d", g.Count)
		}
	}
	if !foundExclGroup {
		t.Fatalf("expected EXCLUSIVE group in summary, got %+v", sumResp.Groups)
	}

	// 2. Styles list (unfiltered, exact search q=FA-001, group=FA, group=EXCLUSIVE) never leaks old static FA-001.
	for _, tc := range []struct {
		url       string
		wantCount int
	}{
		{"/api/resources/styles", 2},
		{"/api/resources/styles?q=FA-001", 1},
		{"/api/resources/styles?group=FA", 2},
		{"/api/resources/styles?group=EXCLUSIVE", 1},
	} {
		rr := doReq(t, h, srv.Token, http.MethodGet, tc.url, nil)
		if rr.Code != http.StatusOK {
			t.Fatalf("GET %s failed: %d %s", tc.url, rr.Code, rr.Body.String())
		}
		if strings.Contains(rr.Body.String(), "Gemma Correll") {
			t.Fatalf("GET %s leaked old static artist name: %s", tc.url, rr.Body.String())
		}
		var listResp struct {
			Items []struct {
				Number        string `json:"number"`
				NameZh        string `json:"nameZh"`
				Source        string `json:"source"`
				GroupCode     string `json:"groupCode"`
				Traits        string `json:"traits"`
				UnlockCost    int    `json:"unlockCost"`
				PromptHidden  bool   `json:"promptHidden"`
				SiteModelOnly bool   `json:"siteModelOnly"`
			} `json:"items"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &listResp); err != nil {
			t.Fatalf("decode %s: %v", tc.url, err)
		}
		if len(listResp.Items) != tc.wantCount {
			t.Fatalf("GET %s: want %d items, got %d: %+v", tc.url, tc.wantCount, len(listResp.Items), listResp.Items)
		}
		fa001Count := 0
		for _, it := range listResp.Items {
			if it.Number == "FA-001" {
				fa001Count++
				if it.Source != "exclusive" || it.UnlockCost != 2 || !it.PromptHidden || !it.SiteModelOnly || it.Traits != "" || it.NameZh != "松散黑线冷幽默涂鸦" || it.GroupCode != "FA" {
					t.Fatalf("GET %s returned malformed FA-001 override: %+v", tc.url, it)
				}
			}
		}
		if fa001Count != 1 {
			t.Fatalf("GET %s: want exactly 1 FA-001, got %d", tc.url, fa001Count)
		}
	}

	// 3. Style detail endpoint returns the online exclusive override, NOT the old bundled static style.
	rrDetail := doReq(t, h, srv.Token, http.MethodGet, "/api/resources/styles/FA-001", nil)
	if rrDetail.Code != http.StatusOK {
		t.Fatalf("GET /api/resources/styles/FA-001 failed: %d %s", rrDetail.Code, rrDetail.Body.String())
	}
	if strings.Contains(rrDetail.Body.String(), "Gemma Correll") {
		t.Fatalf("style detail leaked old static artist name: %s", rrDetail.Body.String())
	}
	var detailResp struct {
		Style struct {
			Number        string `json:"number"`
			NameZh        string `json:"nameZh"`
			Source        string `json:"source"`
			Traits        string `json:"traits"`
			UnlockCost    int    `json:"unlockCost"`
			PromptHidden  bool   `json:"promptHidden"`
			SiteModelOnly bool   `json:"siteModelOnly"`
		} `json:"style"`
		Decision map[string]any `json:"decision"`
	}
	if err := json.Unmarshal(rrDetail.Body.Bytes(), &detailResp); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detailResp.Style.Source != "exclusive" || detailResp.Style.NameZh != "松散黑线冷幽默涂鸦" || detailResp.Style.Traits != "" || detailResp.Style.UnlockCost != 2 || !detailResp.Style.PromptHidden {
		t.Fatalf("unexpected exclusive detail payload: %+v", detailResp)
	}

	// 4. Style dice skips paid exclusive FA-001 and returns free FA-002.
	for i := 0; i < 6; i++ {
		rrRand := doReq(t, h, srv.Token, http.MethodGet, "/api/resources/random", nil)
		if rrRand.Code != http.StatusOK {
			t.Fatalf("GET /api/resources/random failed: %d %s", rrRand.Code, rrRand.Body.String())
		}
		var randResp struct {
			Style struct {
				Number string `json:"number"`
			} `json:"style"`
		}
		_ = json.Unmarshal(rrRand.Body.Bytes(), &randResp)
		if randResp.Style.Number != "FA-002" {
			t.Fatalf("expected random dice to pick free FA-002 instead of exclusive FA-001, got %q", randResp.Style.Number)
		}
	}

	// 5. Chat plan defaults to free FA-002 when unlocked, and resolves new exclusive name when user explicitly selects FA-001.
	rrPlanDefault := doReq(t, h, srv.Token, http.MethodPost, "/api/studio/chat-plan", map[string]any{
		"message": "一只小猫在窗边晒太阳",
	})
	if rrPlanDefault.Code != http.StatusOK {
		t.Fatalf("POST /api/studio/chat-plan default failed: %d %s", rrPlanDefault.Code, rrPlanDefault.Body.String())
	}
	var planDefault struct {
		Common struct {
			Style1     string `json:"style1"`
			Style1Name string `json:"style1Name"`
		} `json:"common"`
	}
	_ = json.Unmarshal(rrPlanDefault.Body.Bytes(), &planDefault)
	if planDefault.Common.Style1 != "FA-002" {
		t.Fatalf("expected default chat-plan style1=FA-002, got %+v", planDefault.Common)
	}

	rrPlanLocked := doReq(t, h, srv.Token, http.MethodPost, "/api/studio/chat-plan", map[string]any{
		"message":  "一只小猫在窗边晒太阳",
		"selected": map[string]any{"style1": "FA-001"},
	})
	if rrPlanLocked.Code != http.StatusOK {
		t.Fatalf("POST /api/studio/chat-plan selected FA-001 failed: %d %s", rrPlanLocked.Code, rrPlanLocked.Body.String())
	}
	var planLocked struct {
		Common struct {
			Style1     string `json:"style1"`
			Style1Name string `json:"style1Name"`
		} `json:"common"`
	}
	_ = json.Unmarshal(rrPlanLocked.Body.Bytes(), &planLocked)
	if planLocked.Common.Style1 != "FA-001" || planLocked.Common.Style1Name != "松散黑线冷幽默涂鸦" {
		t.Fatalf("expected exclusive style1Name '松散黑线冷幽默涂鸦', got %+v", planLocked.Common)
	}

	// 6. Generation gate rejects BYOK with site_model_required and locked website model with asset_locked using exclusive wording.
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.Providers = []settings.Provider{{
			ID: "byok", Name: "BYOK", Enabled: true, Purpose: "image", BaseURL: fakeSite.URL,
			Models: []settings.Model{{ID: "custom-img", Label: "Custom Img"}},
		}}
		return nil
	})
	rrByok := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":     "single",
		"modelRef": "byok:custom-img",
		"input":    map[string]any{"style": "FA-001", "theme": "窗台小猫"},
	})
	if rrByok.Code != http.StatusForbidden || !strings.Contains(rrByok.Body.String(), "site_model_required") || !strings.Contains(rrByok.Body.String(), "官网独占") {
		t.Fatalf("expected 403 site_model_required with 官网独占 wording for BYOK, got %d %s", rrByok.Code, rrByok.Body.String())
	}

	rrLocked := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":     "single",
		"modelRef": "site:seedream-4.5",
		"input":    map[string]any{"style": "FA-001", "theme": "窗台小猫"},
	})
	if rrLocked.Code != http.StatusForbidden || !strings.Contains(rrLocked.Body.String(), "asset_locked") || !strings.Contains(rrLocked.Body.String(), "官网独占") {
		t.Fatalf("expected 403 asset_locked with 官网独占 wording for locked site model, got %d %s", rrLocked.Code, rrLocked.Body.String())
	}
}
