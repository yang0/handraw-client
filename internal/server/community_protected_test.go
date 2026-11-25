package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/store"
)

func TestCommunityProtectedResourcesAndSiteModelGate(t *testing.T) {
	unlocked := false
	var capturedStyle1 string
	var capturedSitePrompt string
	var capturedPublishPrice int

	fakeSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/community/resources" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"items": []map[string]any{
					{
						"id":            "CS-001",
						"code":          "CS-001",
						"kind":          "style",
						"sourceType":    "community",
						"name":          "星河水彩",
						"description":   "安全公开简介",
						"image":         "/uploads/cs001.webp",
						"author":        "alice",
						"authorName":    "Alice",
						"unlockCost":    12,
						"unlocked":      unlocked,
						"isMine":        false,
						"promptHidden":  true,
						"siteModelOnly": true,
					},
					{
						"id":            "CL-001",
						"code":          "CL-001",
						"kind":          "layout",
						"sourceType":    "community",
						"name":          "杂志三栏",
						"description":   "安全图型简介",
						"image":         "/uploads/cl001.webp",
						"author":        "alice",
						"authorName":    "Alice",
						"unlockCost":    8,
						"unlocked":      true,
						"isMine":        false,
						"promptHidden":  true,
						"siteModelOnly": true,
					},
				},
			})
		case r.URL.Path == "/api/v1/community/resources/CS-001/unlock" && r.Method == http.MethodPost:
			unlocked = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":            true,
				"targetType":    "asset",
				"targetId":      "CS-001",
				"credits":       88,
				"promptHidden":  true,
				"siteModelOnly": true,
			})
		case r.URL.Path == "/api/economy/public-models" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"specifications": []map[string]any{
					{"id": "spec-1", "model": "seedream-4.5", "resolution": "1k", "quality": "standard", "enabled": true, "verified": true},
				},
			})
		case r.URL.Path == "/api/studio/quote" && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"quoteId": "q-1", "totalCents": 0, "freeCount": 1})
		case r.URL.Path == "/api/studio/generate" && r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			capturedStyle1, _ = body["style1"].(string)
			capturedSitePrompt, _ = body["prompt"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "taskId": "task-1"})
		case strings.HasPrefix(r.URL.Path, "/api/v1/me/resources/") && strings.HasSuffix(r.URL.Path, "/publish"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if p, ok := body["price"].(float64); ok {
				capturedPublishPrice = int(p)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"published": map[string]any{
					"code":   "CS-999",
					"status": "approved",
					"url":    "/styles/CS-999",
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
	_ = secrets.Set(secrets.SiteToken, "tok_test_community")
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	// 1. Community styles & layouts are merged into /api/resources/* with ZERO prompt traits
	rrStyles := doReq(t, h, srv.Token, http.MethodGet, "/api/resources/styles?group=USR", nil)
	if rrStyles.Code != http.StatusOK {
		t.Fatalf("GET /api/resources/styles?group=USR failed: %d %s", rrStyles.Code, rrStyles.Body.String())
	}
	var stylesResp struct {
		Items []struct {
			Number        string `json:"number"`
			Traits        string `json:"traits"`
			PromptHidden  bool   `json:"promptHidden"`
			SiteModelOnly bool   `json:"siteModelOnly"`
			UnlockCost    int    `json:"unlockCost"`
			Unlocked      bool   `json:"unlocked"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rrStyles.Body.Bytes(), &stylesResp); err != nil || len(stylesResp.Items) != 1 {
		t.Fatalf("expected 1 community style, got err=%v body=%s", err, rrStyles.Body.String())
	}
	if stylesResp.Items[0].Traits != "" || !stylesResp.Items[0].PromptHidden || !stylesResp.Items[0].SiteModelOnly || stylesResp.Items[0].UnlockCost != 12 {
		t.Fatalf("community style must hide prompt and enforce siteModelOnly: %+v", stylesResp.Items[0])
	}

	// 2. Third-party BYOK model MUST be blocked (403 site_model_required) when using a community style
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.Providers = []settings.Provider{{
			ID: "byok", Name: "BYOK", Enabled: true, Purpose: "image", BaseURL: fakeSite.URL,
			Models: []settings.Model{{ID: "custom-img", Label: "Custom Img"}},
		}}
		return nil
	})
	rrByok := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"modelRef": "byok:custom-img",
		"input":    map[string]any{"theme": "一只喝茶的小猫", "style": "CS-001", "ratio": "3:4"},
	})
	if rrByok.Code != http.StatusForbidden || !strings.Contains(rrByok.Body.String(), "site_model_required") {
		t.Fatalf("expected 403 site_model_required for BYOK with community style, got %d %s", rrByok.Code, rrByok.Body.String())
	}

	// 3. Site model with LOCKED community style MUST be blocked (403 asset_locked)
	rrLocked := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"modelRef": "site:seedream-4.5",
		"input":    map[string]any{"theme": "一只喝茶的小猫", "style": "CS-001", "ratio": "3:4"},
	})
	if rrLocked.Code != http.StatusForbidden || !strings.Contains(rrLocked.Body.String(), "asset_locked") {
		t.Fatalf("expected 403 asset_locked before unlock, got %d %s", rrLocked.Code, rrLocked.Body.String())
	}

	// 4. Unlock via /api/resources/community/CS-001/unlock, then site model succeeds without local prompt leak
	rrUnlock := doReq(t, h, srv.Token, http.MethodPost, "/api/resources/community/CS-001/unlock", map[string]any{})
	if rrUnlock.Code != http.StatusOK {
		t.Fatalf("unlock failed: %d %s", rrUnlock.Code, rrUnlock.Body.String())
	}
	rrGen := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"modelRef": "site:seedream-4.5",
		"input":    map[string]any{"theme": "一只喝茶的小猫", "style": "CS-001", "ratio": "3:4"},
	})
	if rrGen.Code != http.StatusOK {
		t.Fatalf("expected 200 after unlock with site model, got %d %s", rrGen.Code, rrGen.Body.String())
	}
	_ = capturedStyle1
	_ = capturedSitePrompt

	// 5. Publishing own style rejects free (price=0) and accepts custom integer price (7) without extra fields
	_ = srv.DB.PutDoc(&store.Doc{
		Kind:     "style",
		ID:       "doc-my-style",
		RemoteID: "11111111-2222-3333-4444-555555555555",
		Name:     "自建测试画风",
		Data:     json.RawMessage(`{"number":"MY-S-001","nameZh":"自建测试画风","traits":"测试特征"}`),
	})
	rrFree := doReq(t, h, srv.Token, http.MethodPost, "/api/mine/styles/doc-my-style/publish", map[string]any{"price": 0})
	if rrFree.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for free publish price=0, got %d %s", rrFree.Code, rrFree.Body.String())
	}
	rrPaid := doReq(t, h, srv.Token, http.MethodPost, "/api/mine/styles/doc-my-style/publish", map[string]any{"price": 7})
	if rrPaid.Code != http.StatusOK || capturedPublishPrice != 7 {
		t.Fatalf("expected 200 with custom price=7, got %d (captured=%d) %s", rrPaid.Code, capturedPublishPrice, rrPaid.Body.String())
	}
}
