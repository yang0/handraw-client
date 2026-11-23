package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/yang0/handraw-client/internal/settings"
)

func buildTestPluginZip(t *testing.T, id, name, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	pkg := map[string]any{
		"name":        id,
		"version":     version,
		"description": "Test plugin " + version,
		"handraw": map[string]any{
			"id":          id,
			"name":        name,
			"api":         "^1",
			"permissions": []string{"resources:read"},
		},
	}
	b, _ := json.Marshal(pkg)
	w, _ := zw.Create(id + "/package.json")
	_, _ = w.Write(b)
	_ = zw.Close()
	return buf.Bytes()
}

func TestPluginUpdateCheckSingleBatchAndDowngradeGuard(t *testing.T) {
	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	var mu sync.Mutex
	curVer := "1.0.0"
	curCommit := "aaaa111111111111111111111111111111111111"

	var mock *httptest.Server
	mock = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ver, cmt := curVer, curCommit
		mu.Unlock()
		switch r.URL.Path {
		case "/index.json":
			idx := map[string]any{
				"format": 1,
				"title":  map[string]string{"zh": "测试插件市场"},
				"metadata": map[string]any{
					"categories": map[string]any{"creation": map[string]any{"title": map[string]string{"zh": "创作"}}},
					"labels":     map[string]any{"official": map[string]any{"title": map[string]string{"zh": "官方"}}},
				},
				"plugins": []any{
					map[string]any{
						"name":        "demo-updater",
						"title":       map[string]string{"zh": "更新测试插件"},
						"description": map[string]string{"zh": "用于测试检查更新与一键升级"},
						"author":      "tester",
						"metadata":    map[string]any{"categories": []string{"creation"}, "labels": []string{"official"}},
						"versions": []any{
							map[string]any{
								"version":          ver,
								"publishTimestamp": 1795000000,
								"source": map[string]any{
									"type":   "git",
									"url":    mock.URL + "/plugin.zip",
									"commit": cmt,
								},
							},
						},
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(idx)
		case "/plugin.zip":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(buildTestPluginZip(t, "demo-updater", "更新测试插件", ver))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mock.Close()

	// Point market sources exclusively at the local mock market so tests never touch the network.
	_, err := settings.Update(func(st *settings.Settings) error {
		st.PluginMarkets = []settings.PluginMarketSource{
			{ID: "mock-market", Name: "Mock Market", URL: mock.URL + "/index.json", Official: true, Enabled: true},
		}
		return nil
	})
	if err != nil {
		t.Fatalf("update settings failed: %v", err)
	}

	// 1. Install v1.0.0 from market.
	rrInst := doReq(t, h, srv.Token, "POST", "/api/plugins/market/install", map[string]any{
		"sourceId": "mock-market",
		"name":     "demo-updater",
		"version":  "1.0.0",
		"enable":   true,
	})
	if rrInst.Code != 200 {
		t.Fatalf("market install v1.0.0 failed: %d %s", rrInst.Code, rrInst.Body.String())
	}

	// 2. Check updates at v1.0.0 -> should be current (outdatedCount == 0).
	rrCheck1 := doReq(t, h, srv.Token, "POST", "/api/plugins/check", map[string]any{})
	if rrCheck1.Code != 200 {
		t.Fatalf("check 1 failed: %d %s", rrCheck1.Code, rrCheck1.Body.String())
	}
	var chk1 struct {
		OutdatedCount int               `json:"outdatedCount"`
		Plugins       []pluginCheckItem `json:"plugins"`
	}
	_ = json.Unmarshal(rrCheck1.Body.Bytes(), &chk1)
	if chk1.OutdatedCount != 0 || len(chk1.Plugins) != 1 || chk1.Plugins[0].Status != "current" {
		t.Fatalf("expected current at 1.0.0, got %+v", chk1)
	}

	// 3. Bump market to v1.1.0 -> check reports update, GET /api/plugins/updates reports count=1.
	mu.Lock()
	curVer = "1.1.0"
	curCommit = "bbbb222222222222222222222222222222222222"
	mu.Unlock()

	rrCheck2 := doReq(t, h, srv.Token, "POST", "/api/plugins/check", map[string]any{})
	var chk2 struct {
		OutdatedCount int               `json:"outdatedCount"`
		Plugins       []pluginCheckItem `json:"plugins"`
	}
	_ = json.Unmarshal(rrCheck2.Body.Bytes(), &chk2)
	if chk2.OutdatedCount != 1 || chk2.Plugins[0].Status != "update" || chk2.Plugins[0].LatestVersion != "1.1.0" {
		t.Fatalf("expected update to 1.1.0, got %+v", chk2)
	}
	rrSum := doReq(t, h, srv.Token, "GET", "/api/plugins/updates", nil)
	var sumRes struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(rrSum.Body.Bytes(), &sumRes)
	if sumRes.Count != 1 {
		t.Fatalf("expected updates summary count=1, got %+v", sumRes)
	}

	// 4. Single-plugin update -> upgrades to v1.1.0 and records UpdatedFrom/UpdatedTo.
	rrUp1 := doReq(t, h, srv.Token, "POST", "/api/plugins/demo-updater/update", map[string]any{})
	if rrUp1.Code != 200 {
		t.Fatalf("single update failed: %d %s", rrUp1.Code, rrUp1.Body.String())
	}
	cAfter1, err := srv.Plugins.Community("demo-updater")
	if err != nil || cAfter1.Version != "1.1.0" || cAfter1.Install == nil || cAfter1.Install.UpdatedFrom != "1.0.0" || cAfter1.Install.UpdatedTo != "1.1.0" {
		t.Fatalf("unexpected plugin state after single update: %+v err=%v", cAfter1, err)
	}

	// 5. Same version (1.1.0) with a newer commit -> detects new_commits and Update All upgrades it!
	mu.Lock()
	curCommit = "cccc333333333333333333333333333333333333"
	mu.Unlock()
	rrCheck3 := doReq(t, h, srv.Token, "POST", "/api/plugins/check", map[string]any{})
	var chk3 struct {
		OutdatedCount int               `json:"outdatedCount"`
		Plugins       []pluginCheckItem `json:"plugins"`
	}
	_ = json.Unmarshal(rrCheck3.Body.Bytes(), &chk3)
	if chk3.OutdatedCount != 1 || chk3.Plugins[0].Reason != "new_commits" {
		t.Fatalf("expected new_commits update, got %+v", chk3)
	}

	rrUpAll := doReq(t, h, srv.Token, "POST", "/api/plugins/update", map[string]any{})
	if rrUpAll.Code != 200 {
		t.Fatalf("update all failed: %d %s", rrUpAll.Code, rrUpAll.Body.String())
	}
	cAfter2, _ := srv.Plugins.Community("demo-updater")
	if cAfter2.Install == nil || cAfter2.Install.Commit != "cccc333333333333333333333333333333333333" {
		t.Fatalf("expected commit updated to cccc333, got %+v", cAfter2.Install)
	}

	// 6. Downgrade guard: if market reports older v0.9.0, must NOT mark updateAvailable!
	mu.Lock()
	curVer = "0.9.0"
	curCommit = "dddd444444444444444444444444444444444444"
	mu.Unlock()
	rrCheck4 := doReq(t, h, srv.Token, "POST", "/api/plugins/check", map[string]any{})
	var chk4 struct {
		OutdatedCount int               `json:"outdatedCount"`
		Plugins       []pluginCheckItem `json:"plugins"`
	}
	_ = json.Unmarshal(rrCheck4.Body.Bytes(), &chk4)
	if chk4.OutdatedCount != 0 || chk4.Plugins[0].Status != "current" {
		t.Fatalf("downgrade guard failed! expected current, got %+v", chk4)
	}
}
