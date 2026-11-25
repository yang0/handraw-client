package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/secrets"
)

func TestCustomAssetCategoriesCRUDAndMigration(t *testing.T) {
	srv, cancel := setupTestServer(t, "")
	defer cancel()

	doJSON := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return doReq(t, srv.Handler(), srv.Token, method, path, body)
	}

	// 1. Default categories include character, prop, scene, other
	rr := doJSON("GET", "/api/mine/asset-categories", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET categories status=%d body=%s", rr.Code, rr.Body.String())
	}
	var listRes struct {
		Items []AssetCategory `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listRes); err != nil {
		t.Fatal(err)
	}
	if len(listRes.Items) < 4 {
		t.Fatalf("expected >=4 builtin categories, got %+v", listRes.Items)
	}

	// 2. Create custom category "角色IP"
	rr = doJSON("POST", "/api/mine/asset-categories", map[string]any{"label": "角色IP"})
	if rr.Code != http.StatusOK {
		t.Fatalf("POST create category failed: %d %s", rr.Code, rr.Body.String())
	}
	var createRes struct {
		Category AssetCategory `json:"category"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &createRes); err != nil {
		t.Fatal(err)
	}
	catKey := createRes.Category.Key
	if catKey == "" || createRes.Category.Label != "角色IP" || createRes.Category.Builtin {
		t.Fatalf("unexpected created category: %+v", createRes.Category)
	}

	// 3. Reject duplicate label
	rrDup := doJSON("POST", "/api/mine/asset-categories", map[string]any{"label": "角色IP"})
	if rrDup.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on duplicate label, got %d", rrDup.Code)
	}

	// 4. Rename custom category
	rrRename := doJSON("POST", "/api/mine/asset-categories", map[string]any{"key": catKey, "label": "主角设定"})
	if rrRename.Code != http.StatusOK {
		t.Fatalf("rename category failed: %d %s", rrRename.Code, rrRename.Body.String())
	}

	// 5. Reject new asset with no image
	rrNoImg := doJSON("POST", "/api/mine/assets", map[string]any{"kind": catKey, "name": "空图"})
	if rrNoImg.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when creating asset without image, got %d", rrNoImg.Code)
	}

	// 6. Create asset in custom category, then edit name/kind preserving image
	tinyPNG := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	rrAsset := doJSON("POST", "/api/mine/assets", map[string]any{
		"kind":    catKey,
		"name":    "小橘猫店员",
		"dataUrl": tinyPNG,
	})
	if rrAsset.Code != http.StatusOK {
		t.Fatalf("create custom asset failed: %d %s", rrAsset.Code, rrAsset.Body.String())
	}
	var assetRes struct {
		Asset struct {
			ID    string `json:"id"`
			Kind  string `json:"kind"`
			Name  string `json:"name"`
			Image string `json:"image"`
		} `json:"asset"`
	}
	if err := json.Unmarshal(rrAsset.Body.Bytes(), &assetRes); err != nil {
		t.Fatal(err)
	}
	if assetRes.Asset.Kind != catKey || assetRes.Asset.Image == "" {
		t.Fatalf("unexpected asset: %+v", assetRes.Asset)
	}

	rrEdit := doJSON("POST", "/api/mine/assets", map[string]any{
		"id":   assetRes.Asset.ID,
		"kind": catKey,
		"name": "小橘猫店长",
	})
	if rrEdit.Code != http.StatusOK {
		t.Fatalf("edit asset failed: %d %s", rrEdit.Code, rrEdit.Body.String())
	}
	var editRes struct {
		Asset struct {
			Name  string `json:"name"`
			Image string `json:"image"`
		} `json:"asset"`
	}
	_ = json.Unmarshal(rrEdit.Body.Bytes(), &editRes)
	if editRes.Asset.Name != "小橘猫店长" || editRes.Asset.Image != assetRes.Asset.Image {
		t.Fatalf("edit did not preserve image or update name: %+v", editRes.Asset)
	}

	// 7. Reject deleting builtin category
	rrDelBuiltin := doJSON("DELETE", "/api/mine/asset-categories/character", nil)
	if rrDelBuiltin.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 deleting builtin category, got %d", rrDelBuiltin.Code)
	}

	// 8. Delete custom category -> asset migrates to "other" instead of being deleted
	rrDel := doJSON("DELETE", "/api/mine/asset-categories/"+catKey, nil)
	if rrDel.Code != http.StatusOK {
		t.Fatalf("delete custom category failed: %d %s", rrDel.Code, rrDel.Body.String())
	}
	var delRes struct {
		Migrated int `json:"migrated"`
	}
	_ = json.Unmarshal(rrDel.Body.Bytes(), &delRes)
	if delRes.Migrated != 1 {
		t.Fatalf("expected 1 migrated asset, got %d", delRes.Migrated)
	}

	// Verify asset now has kind == "other"
	rrAssets := doJSON("GET", "/api/mine/assets", nil)
	if rrAssets.Code != http.StatusOK {
		t.Fatalf("GET assets failed: %d", rrAssets.Code)
	}
	var assetsList struct {
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(rrAssets.Body.Bytes(), &assetsList)
	found := false
	for _, it := range assetsList.Items {
		if it["id"] == assetRes.Asset.ID {
			found = true
			if it["kind"] != "other" {
				t.Fatalf("expected migrated kind 'other', got %v", it["kind"])
			}
		}
	}
	if !found {
		t.Fatalf("migrated asset missing from /api/mine/assets")
	}
}

func TestGalleryCategoriesAndAssetsBidirectionalSync(t *testing.T) {
	pngBytes := tinyPNG(t)
	tmpImg := filepath.Join(t.TempDir(), "gallery_item.png")
	if err := os.WriteFile(tmpImg, pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	webCats := map[string]string{
		"cat_web999": "网页端分组",
	}
	pushedAssetCats := map[string]string{} // localId -> web cat
	deletedCats := []string{}
	webAssetUID := uuid.NewString()
	webSceneUID := uuid.NewString()
	webAssetImgPath := "/api/library/assets/" + webAssetUID + "/image"
	webSceneImgPath := "/api/library/assets/" + webSceneUID + "/image"

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/api/auth/me":
			_, _ = w.Write([]byte(`{"user":{"username":"tester"}}`))
		case r.URL.Path == "/api/v1/me/resources" && r.Method == "GET":
			_, _ = w.Write([]byte(`{"ok":true,"items":[],"hasMore":false,"nextCursor":"0"}`))
		case r.URL.Path == "/api/v1/me/recipes" && r.Method == "GET":
			_, _ = w.Write([]byte(`{"ok":true,"items":[],"hasMore":false,"nextCursor":"0"}`))
		case r.URL.Path == "/api/studio/asset-categories" && r.Method == "GET":
			custom := make([]map[string]any, 0, len(webCats))
			for k, lbl := range webCats {
				custom = append(custom, map[string]any{"key": k, "label": lbl, "builtin": false})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "custom": custom, "items": custom})
		case r.URL.Path == "/api/studio/asset-categories" && r.Method == "POST":
			var body struct {
				Key   string `json:"key"`
				Label string `json:"label"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			webCats[body.Key] = body.Label
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":       true,
				"category": map[string]any{"key": body.Key, "label": body.Label, "builtin": false},
			})
		case strings.HasPrefix(r.URL.Path, "/api/studio/asset-categories/") && r.Method == "DELETE":
			k := strings.TrimPrefix(r.URL.Path, "/api/studio/asset-categories/")
			delete(webCats, k)
			deletedCats = append(deletedCats, k)
			_, _ = w.Write([]byte(`{"ok":true,"migrated":0}`))
		case strings.HasPrefix(r.URL.Path, "/api/library/assets/") && strings.HasSuffix(r.URL.Path, "/image") && r.Method == "GET":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case strings.HasPrefix(r.URL.Path, "/api/library/assets/") && r.Method == "PUT":
			uid := strings.TrimPrefix(r.URL.Path, "/api/library/assets/")
			var body struct {
				Cat     string `json:"cat"`
				LocalID string `json:"localId"`
				Name    string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			pushedAssetCats[body.LocalID] = body.Cat
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":       true,
				"uid":      uid,
				"revision": 1,
				"item":     map[string]any{"uid": uid, "revision": 1, "cat": body.Cat, "name": body.Name},
			})
		case r.URL.Path == "/api/library/assets" && r.Method == "GET":
			items := []map[string]any{
				{"uid": webAssetUID, "cat": "cat_web999", "name": "网页自定义素材", "revision": 1, "imageUrl": webAssetImgPath},
				{"uid": webSceneUID, "cat": "scenes", "name": "网页场景素材", "revision": 1, "imageUrl": webSceneImgPath},
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "items": items, "hasMore": false, "nextCursor": "5"})
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, cancel := setupTestServer(t, mockSite.URL)
	defer cancel()
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	h := srv.Handler()

	// 1. Create custom category locally
	rrCat := doReq(t, h, srv.Token, "POST", "/api/mine/asset-categories", map[string]any{"label": "客户端角色组"})
	if rrCat.Code != 200 {
		t.Fatalf("create local category failed: %d %s", rrCat.Code, rrCat.Body.String())
	}
	var catResp struct {
		Category AssetCategory `json:"category"`
	}
	_ = json.Unmarshal(rrCat.Body.Bytes(), &catResp)
	localCatKey := catResp.Category.Key

	// 2. Create 2 local gallery assets: one under custom category, one under builtin "character"
	rrA1 := doReq(t, h, srv.Token, "POST", "/api/mine/assets", map[string]any{
		"kind":  localCatKey,
		"name":  "自定义分组图",
		"image": tmpImg,
	})
	rrA2 := doReq(t, h, srv.Token, "POST", "/api/mine/assets", map[string]any{
		"kind":  "character",
		"name":  "内置角色图",
		"image": tmpImg,
	})
	if rrA1.Code != 200 || rrA2.Code != 200 {
		t.Fatalf("create local assets failed: %d / %d", rrA1.Code, rrA2.Code)
	}
	var a1Resp, a2Resp struct {
		Asset struct {
			ID string `json:"id"`
		} `json:"asset"`
	}
	_ = json.Unmarshal(rrA1.Body.Bytes(), &a1Resp)
	_ = json.Unmarshal(rrA2.Body.Bytes(), &a2Resp)

	// 3. Run full bidirectional sync via POST /api/mine/sync
	rrSync := doReq(t, h, srv.Token, "POST", "/api/mine/sync", map[string]any{})
	if rrSync.Code != 200 {
		t.Fatalf("sync failed: %d %s", rrSync.Code, rrSync.Body.String())
	}

	// Verify local custom category & mapped builtin category were pushed to Web
	mu.Lock()
	if webCats[localCatKey] != "客户端角色组" {
		t.Fatalf("expected local category %s pushed to Web, got %+v", localCatKey, webCats)
	}
	if pushedAssetCats[a1Resp.Asset.ID] != localCatKey {
		t.Fatalf("expected custom-cat asset pushed with %s, got %q", localCatKey, pushedAssetCats[a1Resp.Asset.ID])
	}
	if pushedAssetCats[a2Resp.Asset.ID] != "characters" {
		t.Fatalf("expected builtin 'character' mapped to 'characters' on Web, got %q", pushedAssetCats[a2Resp.Asset.ID])
	}
	mu.Unlock()

	// Verify Web custom category ("cat_web999") was pulled locally
	rrCats := doReq(t, h, srv.Token, "GET", "/api/mine/asset-categories", nil)
	if !strings.Contains(rrCats.Body.String(), "cat_web999") || !strings.Contains(rrCats.Body.String(), "网页端分组") {
		t.Fatalf("expected pulled Web custom category cat_web999, got %s", rrCats.Body.String())
	}

	// Verify Web gallery assets were pulled with proper category mapping ("scenes" -> "scene", "cat_web999" preserved)
	rrAssets := doReq(t, h, srv.Token, "GET", "/api/mine/assets", nil)
	var listAssets struct {
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(rrAssets.Body.Bytes(), &listAssets)
	foundWebCustom, foundWebScene := false, false
	for _, it := range listAssets.Items {
		if it["name"] == "网页自定义素材" && it["kind"] == "cat_web999" {
			foundWebCustom = true
		}
		if it["name"] == "网页场景素材" && it["kind"] == "scene" {
			foundWebScene = true
		}
	}
	if !foundWebCustom || !foundWebScene {
		t.Fatalf("expected pulled Web assets (custom=%v scene=%v), got %+v", foundWebCustom, foundWebScene, listAssets.Items)
	}

	// 4. Delete synced custom category locally -> sync pushes DELETE to Web
	rrDel := doReq(t, h, srv.Token, "DELETE", "/api/mine/asset-categories/"+localCatKey, nil)
	if rrDel.Code != 200 {
		t.Fatalf("delete local category failed: %d %s", rrDel.Code, rrDel.Body.String())
	}
	rrSync2 := doReq(t, h, srv.Token, "POST", "/api/mine/sync", map[string]any{})
	if rrSync2.Code != 200 {
		t.Fatalf("second sync failed: %d %s", rrSync2.Code, rrSync2.Body.String())
	}
	mu.Lock()
	foundDel := false
	for _, dk := range deletedCats {
		if dk == localCatKey {
			foundDel = true
		}
	}
	mu.Unlock()
	if !foundDel {
		t.Fatalf("expected DELETE /api/studio/asset-categories/%s sent to Web, got %v", localCatKey, deletedCats)
	}
}
