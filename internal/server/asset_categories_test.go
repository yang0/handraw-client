package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
