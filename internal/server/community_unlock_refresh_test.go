package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/secrets"
)

func TestCommunityUnlockStaleCacheRefreshesOnGenerateAndIsolatesTokens(t *testing.T) {
	var unlockedByToken atomic.Value
	unlockedByToken.Store("tok_buyer_b")
	var failCommunityFirst atomic.Bool
	var genCalls atomic.Int32

	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		switch {
		case r.URL.Path == "/api/v1/community/resources" && r.Method == http.MethodGet:
			if failCommunityFirst.Swap(false) {
				http.Error(w, `{"error":"temporary"}`, http.StatusBadGateway)
				return
			}
			isUnlocked := auth != "" && strings.Contains(unlockedByToken.Load().(string), auth)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"items": []map[string]any{
					{
						"id":            "USR-S003BB284EE",
						"code":          "USR-S003BB284EE",
						"kind":          "style",
						"sourceType":    "community",
						"name":          "留白柔彩线描",
						"unlockCost":    5,
						"unlocked":      isUnlocked,
						"isMine":        false,
						"promptHidden":  true,
						"siteModelOnly": true,
					},
				},
			})
		case r.URL.Path == "/api/boot" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"communityResources": []map[string]any{
					{
						"id":         "USR-S003BB284EE",
						"code":       "USR-S003BB284EE",
						"kind":       "style",
						"sourceType": "community",
						"name":       "留白柔彩线描",
						"unlockCost": 5,
						"unlocked":   false,
					},
				},
			})
		case r.URL.Path == "/api/economy/public-models" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"specifications": []map[string]any{
					{"id": "spec-1", "model": "seedream-4.5", "resolution": "1k", "quality": "standard", "enabled": true, "verified": true},
				},
			})
		case r.URL.Path == "/api/studio/quote" && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]any{"quoteId": "q-207", "totalCents": 0, "freeCount": 1})
		case r.URL.Path == "/api/studio/generate" && r.Method == http.MethodPost:
			genCalls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "taskId": "task-207"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer mock.Close()

	srv, _ := setupTestServer(t, mock.URL)
	h := srv.Handler()
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	// 1. User A logs in before purchasing -> cache records unlocked=false
	_ = secrets.Set(secrets.SiteToken, "tok_buyer_a")
	rrBefore := doReq(t, h, srv.Token, http.MethodGet, "/api/resources/styles?q=USR-S003BB284EE", nil)
	if rrBefore.Code != http.StatusOK || !strings.Contains(rrBefore.Body.String(), "USR-S003BB284EE") {
		t.Fatalf("expected community style listing, got %d %s", rrBefore.Code, rrBefore.Body.String())
	}

	// 2. User A purchases USR-S003BB284EE on the website (outside the desktop client).
	// Client cache still holds unlocked=false, but POST /api/generate must force-refresh and succeed!
	unlockedByToken.Store("tok_buyer_a,tok_buyer_b")
	rrGen := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"modelRef": "site:seedream-4.5",
		"input":    map[string]any{"theme": "ppt接单海报", "style": "USR-S003BB284EE", "ratio": "9:16"},
	})
	if rrGen.Code != http.StatusOK {
		t.Fatalf("expected 200 after web purchase via live unlock refresh, got %d %s", rrGen.Code, rrGen.Body.String())
	}
	if snapAfter := srv.communityCatalog(context.Background(), false); len(snapAfter.Styles) != 1 || !snapAfter.Styles[0].Unlocked {
		t.Fatalf("expected cache updated to unlocked=true after refresh, got %+v", snapAfter.Styles)
	}
	_ = genCalls.Load()

	// 3. Switching to another token must NOT reuse tok_buyer_a's unlocked=true cache.
	_ = secrets.Set(secrets.SiteToken, "tok_buyer_c_locked")
	rrLocked := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"modelRef": "site:seedream-4.5",
		"input":    map[string]any{"theme": "ppt接单海报", "style": "USR-S003BB284EE", "ratio": "9:16"},
	})
	if rrLocked.Code != http.StatusForbidden || !strings.Contains(rrLocked.Body.String(), "asset_locked") {
		t.Fatalf("expected 403 asset_locked for unpurchased account, got %d %s", rrLocked.Code, rrLocked.Body.String())
	}

	// 4. Transient /api/v1/community/resources error while logged in must NOT poison cache with unlocked=false.
	_ = secrets.Set(secrets.SiteToken, "tok_buyer_b")
	failCommunityFirst.Store(true)
	snapFallback := srv.communityCatalog(context.Background(), false)
	if len(snapFallback.Styles) != 1 || snapFallback.Styles[0].Unlocked {
		t.Fatalf("expected transient fallback snapshot with unlocked=false, got %+v", snapFallback.Styles)
	}
	// Next non-forced call must NOT hit a poisoned cache; it must fetch live and see unlocked=true.
	snapLive := srv.communityCatalog(context.Background(), false)
	if len(snapLive.Styles) != 1 || !snapLive.Styles[0].Unlocked {
		t.Fatalf("expected live snapshot unlocked=true (unauth fallback must not be cached), got %+v", snapLive.Styles)
	}
}

func TestFinalizeChatPlanPreservesCommunityProtectedStyle(t *testing.T) {
	p := &resources.Pack{
		Styles: []resources.Style{
			{Number: "FA-013", NameZh: "官方默认画风"},
		},
	}
	resp := &chatPlanResponse{
		Common: chatPlanCommon{
			Style1:     "USR-S003BB284EE",
			Style1Name: "留白柔彩线描",
			Mode:       "poster",
			Ratio:      "9:16",
		},
		Items: []chatPlanItem{
			{Index: 1, Title: "PPT接单海报", Subject: "PPT接单海报", Layout: "USR-L001"},
		},
	}
	sel := chatPlanSelected{
		Style1: "USR-S003BB284EE",
		Layout: "USR-L001",
		Mode:   "poster",
		Ratio:  "9:16",
	}
	finalizeChatPlan(resp, p, sel, "ppt接单海报")
	if resp.Common.Style1 != "USR-S003BB284EE" {
		t.Fatalf("expected community style USR-S003BB284EE to be preserved, got %q", resp.Common.Style1)
	}
	if resp.Common.Style1Name != "留白柔彩线描" {
		t.Fatalf("expected community style name to be preserved, got %q", resp.Common.Style1Name)
	}
	if len(resp.Items) != 1 || resp.Items[0].Layout != "USR-L001" {
		t.Fatalf("expected community layout USR-L001 to be preserved, got %+v", resp.Items)
	}
}
