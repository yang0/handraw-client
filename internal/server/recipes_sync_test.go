package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/secrets"
)

func TestRecipesNoOfficialRequiredNameAndBidirectionalSync(t *testing.T) {
	// Stateful mock handraw-web /api/v1/me/recipes backend
	var mu sync.Mutex
	type cloudRec struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		StyleIDs   []string `json:"styleIds"`
		LayoutID   string   `json:"layoutId"`
		Colors     []string `json:"colors"`
		Tones      []string `json:"tones"`
		Moods      []string `json:"moods"`
		Whitespace string   `json:"whitespace"`
		Ratio      string   `json:"ratio"`
		Mode       string   `json:"mode"`
		Notes      string   `json:"notes"`
		Revision   int      `json:"revision"`
		DeletedAt  string   `json:"deletedAt,omitempty"`
		CreatedAt  string   `json:"createdAt"`
		UpdatedAt  string   `json:"updatedAt"`
	}
	cloud := map[string]*cloudRec{}
	webCreatedID := uuid.NewString()
	nowTS := func(offsetMs int) string {
		return time.Now().UTC().Add(time.Duration(offsetMs) * time.Millisecond).Format(time.RFC3339Nano)
	}
	cloud[webCreatedID] = &cloudRec{
		ID:        webCreatedID,
		Name:      "网页端建的配方",
		StyleIDs:  []string{"FA-001"},
		LayoutID:  "SC-001",
		Colors:    []string{"C-15"},
		Ratio:     "3:4",
		Mode:      "graphic-text",
		Revision:  1,
		CreatedAt: nowTS(-5000),
		UpdatedAt: nowTS(-5000),
	}

	mockWeb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/auth/me" {
			_, _ = w.Write([]byte(`{"user":{"id":1,"username":"tester"}}`))
			return
		}
		if r.URL.Path == "/api/v1/me/recipes" && r.Method == "GET" {
			since := r.URL.Query().Get("since")
			mu.Lock()
			var items []*cloudRec
			for _, rec := range cloud {
				if since != "" && since != "0" {
					ts := strings.Split(since, "|")[0]
					if rec.UpdatedAt <= ts {
						continue
					}
				}
				items = append(items, rec)
			}
			mu.Unlock()
			nextCur := since
			if len(items) > 0 {
				last := items[len(items)-1]
				nextCur = last.UpdatedAt + "|" + last.ID
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "items": items, "nextCursor": nextCur, "hasMore": false})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/me/recipes/") {
			rid := strings.TrimPrefix(r.URL.Path, "/api/v1/me/recipes/")
			mu.Lock()
			defer mu.Unlock()
			if r.Method == "PUT" {
				var body struct {
					Name         string   `json:"name"`
					StyleIDs     []string `json:"styleIds"`
					LayoutID     string   `json:"layoutId"`
					Colors       []string `json:"colors"`
					Tones        []string `json:"tones"`
					Moods        []string `json:"moods"`
					Whitespace   string   `json:"whitespace"`
					Ratio        string   `json:"ratio"`
					Mode         string   `json:"mode"`
					Notes        string   `json:"notes"`
					BaseRevision *int     `json:"baseRevision"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				existing := cloud[rid]
				if existing != nil {
					if body.BaseRevision == nil || *body.BaseRevision != existing.Revision {
						w.WriteHeader(409)
						_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "code": "conflict", "current": existing})
						return
					}
					existing.Name = body.Name
					existing.StyleIDs = body.StyleIDs
					existing.LayoutID = body.LayoutID
					existing.Colors = body.Colors
					existing.Tones = body.Tones
					existing.Moods = body.Moods
					existing.Whitespace = body.Whitespace
					existing.Ratio = body.Ratio
					existing.Mode = body.Mode
					existing.Notes = body.Notes
					existing.Revision++
					existing.UpdatedAt = nowTS(10)
					_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "recipe": existing})
					return
				}
				rec := &cloudRec{
					ID:         rid,
					Name:       body.Name,
					StyleIDs:   body.StyleIDs,
					LayoutID:   body.LayoutID,
					Colors:     body.Colors,
					Tones:      body.Tones,
					Moods:      body.Moods,
					Whitespace: body.Whitespace,
					Ratio:      body.Ratio,
					Mode:       body.Mode,
					Notes:      body.Notes,
					Revision:   1,
					CreatedAt:  nowTS(0),
					UpdatedAt:  nowTS(0),
				}
				cloud[rid] = rec
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "recipe": rec})
				return
			}
			if r.Method == "DELETE" {
				existing := cloud[rid]
				if existing == nil {
					http.NotFound(w, r)
					return
				}
				existing.DeletedAt = nowTS(20)
				existing.UpdatedAt = existing.DeletedAt
				existing.Revision++
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "recipe": existing})
				return
			}
		}
		http.NotFound(w, r)
	}))
	defer mockWeb.Close()

	srv, _ := setupTestServer(t, mockWeb.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_sync_token")
	h := srv.Handler()

	// 1. No official/builtin recipes returned initially!
	rrEmpty := doReq(t, h, srv.Token, "GET", "/api/mine/recipes", nil)
	if rrEmpty.Code != 200 {
		t.Fatalf("GET /api/mine/recipes failed: %d %s", rrEmpty.Code, rrEmpty.Body.String())
	}
	if !strings.Contains(rrEmpty.Body.String(), `"total":0`) || strings.Contains(rrEmpty.Body.String(), "rcp_builtin_") {
		t.Fatalf("expected 0 recipes (no builtin official recipes), got %s", rrEmpty.Body.String())
	}

	// 2. Empty name rejected with 400.
	rrBlank := doReq(t, h, srv.Token, "POST", "/api/mine/recipes", map[string]any{
		"name":     "   ",
		"styleIds": []string{"FA-001"},
	})
	if rrBlank.Code != 400 {
		t.Fatalf("expected 400 for empty recipe name, got %d %s", rrBlank.Code, rrBlank.Body.String())
	}

	// 3. Create local recipe (local references stripped) and sync both ways.
	rrCreate := doReq(t, h, srv.Token, "POST", "/api/mine/recipes", map[string]any{
		"name":       "客户端水彩风",
		"styleIds":   []string{"FA-001", "FA-002"},
		"layoutId":   "SC-001",
		"colors":     []string{"C-15"},
		"tones":      []string{"T-01"},
		"ratio":      "3:4",
		"mode":       "graphic-text",
		"references": []string{"C:/local/secret.png"},
	})
	if rrCreate.Code != 200 {
		t.Fatalf("POST /api/mine/recipes failed: %d %s", rrCreate.Code, rrCreate.Body.String())
	}
	var createdOut struct {
		Recipe struct {
			ID         string   `json:"id"`
			References []string `json:"references"`
		} `json:"recipe"`
	}
	_ = json.Unmarshal(rrCreate.Body.Bytes(), &createdOut)
	if _, err := uuid.Parse(createdOut.Recipe.ID); err != nil {
		t.Fatalf("expected UUID recipe ID, got %q", createdOut.Recipe.ID)
	}
	if len(createdOut.Recipe.References) != 0 {
		t.Fatalf("expected local references stripped from synced recipe, got %v", createdOut.Recipe.References)
	}

	// Sync: pushes 客户端水彩风 to cloud AND pulls 网页端建的配方 from cloud!
	rrSync := doReq(t, h, srv.Token, "POST", "/api/mine/recipes/sync", nil)
	if rrSync.Code != 200 {
		t.Fatalf("POST /api/mine/recipes/sync failed: %d %s", rrSync.Code, rrSync.Body.String())
	}
	rrAfter := doReq(t, h, srv.Token, "GET", "/api/mine/recipes", nil)
	bodyAfter := rrAfter.Body.String()
	if !strings.Contains(bodyAfter, "客户端水彩风") || !strings.Contains(bodyAfter, "网页端建的配方") {
		t.Fatalf("expected both local and web recipes after sync: %s", bodyAfter)
	}

	// 4. Simulate 409 conflict: cloud bumps rev=2 while client edits rev=1 locally.
	mu.Lock()
	cloud[createdOut.Recipe.ID].Name = "网页端改的新名字"
	cloud[createdOut.Recipe.ID].Revision = 2
	cloud[createdOut.Recipe.ID].UpdatedAt = nowTS(500)
	mu.Unlock()

	rrEdit := doReq(t, h, srv.Token, "POST", "/api/mine/recipes", map[string]any{
		"id":       createdOut.Recipe.ID,
		"name":     "客户端离线改名",
		"styleIds": []string{"FA-001"},
		"ratio":    "4:3",
		"mode":     "pure-image",
	})
	if rrEdit.Code != 200 {
		t.Fatalf("local edit failed: %d %s", rrEdit.Code, rrEdit.Body.String())
	}
	rrSyncConf := doReq(t, h, srv.Token, "POST", "/api/mine/recipes/sync", nil)
	if rrSyncConf.Code != 200 || !strings.Contains(rrSyncConf.Body.String(), `"conflictForks":1`) {
		t.Fatalf("expected 1 conflict fork, got %d %s", rrSyncConf.Code, rrSyncConf.Body.String())
	}
	rrListConf := doReq(t, h, srv.Token, "GET", "/api/mine/recipes", nil)
	if !strings.Contains(rrListConf.Body.String(), "网页端改的新名字") || !strings.Contains(rrListConf.Body.String(), "客户端离线改名 (本地冲突副本)") {
		t.Fatalf("expected both cloud version and local conflict fork preserved: %s", rrListConf.Body.String())
	}

	// 5. Delete synced recipe on client -> sync propagates DELETE tombstone to cloud.
	rrDel := doReq(t, h, srv.Token, "DELETE", "/api/mine/recipes/"+webCreatedID, nil)
	if rrDel.Code != 200 {
		t.Fatalf("delete recipe failed: %d %s", rrDel.Code, rrDel.Body.String())
	}
	rrSyncDel := doReq(t, h, srv.Token, "POST", "/api/mine/recipes/sync", nil)
	if rrSyncDel.Code != 200 {
		t.Fatalf("sync after delete failed: %d %s", rrSyncDel.Code, rrSyncDel.Body.String())
	}
	mu.Lock()
	deletedOnCloud := cloud[webCreatedID].DeletedAt != ""
	mu.Unlock()
	if !deletedOnCloud {
		t.Fatalf("expected web recipe %s to be soft-deleted on cloud after sync", webCreatedID)
	}
}
