package server

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/settings"
)

func TestPluginMarketSourcesAndInstall(t *testing.T) {
	// Verify default official source is pre-installed.
	defaults := settings.DefaultPluginMarkets()
	if len(defaults) == 0 || defaults[0].ID != "handraw-official" || !strings.Contains(defaults[0].URL, "yang0/handraw-plugins") {
		t.Fatalf("unexpected default plugin markets: %+v", defaults)
	}

	// Create a mock DSH Format 1 market server serving an index.json + zip archive.
	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	f1, _ := zw.Create("demo-main/package.json")
	_, _ = f1.Write([]byte(`{"name":"dsh-market-demo","version":"1.2.0","exports":{".":"./host.js","./client":"./client.js"},"dsh":{"client":{"platform":"web"}}}`))
	f2, _ := zw.Create("demo-main/host.js")
	_, _ = f2.Write([]byte(`export function apply(){}`))
	f3, _ := zw.Create("demo-main/client.js")
	_, _ = f3.Write([]byte(`window.__ModuleLoader__.load({id:'dsh-market-demo',factory:()=>({})})`))
	_ = zw.Close()

	var mockMarket *httptest.Server
	mockMarket = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"format": 1,
				"title": {"zh": "测试市场"},
				"metadata": {
					"categories": {"creation": {"title": {"zh": "创作"}}},
					"labels": {"official": {"title": {"zh": "官方"}}}
				},
				"plugins": [{
					"name": "dsh-market-demo",
					"title": {"zh": "市场示例插件"},
					"description": {"zh": "用于测试一键安装"},
					"metadata": {"categories": ["creation"], "labels": ["official"]},
					"versions": [{
						"version": "1.2.0",
						"publishTimestamp": 1794000000,
						"source": {"type": "git", "url": "` + mockMarket.URL + `/demo.zip", "commit": "abc1234"}
					}]
				}]
			}`))
		case "/demo.zip":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(zipBuf.Bytes())
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockMarket.Close()

	srv, cancel := setupTestServer(t, "")
	defer cancel()
	h := srv.Handler()

	// Disable the remote GitHub source during offline unit test; keep official flag to verify delete protection.
	_, err := settings.Update(func(st *settings.Settings) error {
		st.PluginMarkets[0].Enabled = false
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Refuses deleting official source.
	if rr := doReq(t, h, srv.Token, "DELETE", "/api/plugins/market/sources/handraw-official", nil); rr.Code != 400 {
		t.Fatalf("expected 400 when deleting official source, got %d %s", rr.Code, rr.Body.String())
	}

	// Add custom market source.
	rrAdd := doReq(t, h, srv.Token, "POST", "/api/plugins/market/sources", map[string]any{"url": mockMarket.URL + "/index.json"})
	if rrAdd.Code != 200 || !strings.Contains(rrAdd.Body.String(), "测试市场") {
		t.Fatalf("add market source failed: %d %s", rrAdd.Code, rrAdd.Body.String())
	}

	// List market plugins.
	rrList := doReq(t, h, srv.Token, "GET", "/api/plugins/market", nil)
	if rrList.Code != 200 || !strings.Contains(rrList.Body.String(), "dsh-market-demo") || !strings.Contains(rrList.Body.String(), `"installed":false`) {
		t.Fatalf("list market failed: %d %s", rrList.Code, rrList.Body.String())
	}

	// Find custom source ID.
	var customID string
	for _, src := range settings.Get().PluginMarkets {
		if !src.Official {
			customID = src.ID
		}
	}

	// One-click install from market.
	rrInst := doReq(t, h, srv.Token, "POST", "/api/plugins/market/install", map[string]any{
		"sourceId": customID,
		"name":     "dsh-market-demo",
	})
	if rrInst.Code != 200 || !strings.Contains(rrInst.Body.String(), `"id":"dsh-market-demo"`) {
		t.Fatalf("market install failed: %d %s", rrInst.Code, rrInst.Body.String())
	}

	// Re-listing shows installed=true, updateAvailable=false.
	rrList2 := doReq(t, h, srv.Token, "GET", "/api/plugins/market", nil)
	if rrList2.Code != 200 || !strings.Contains(rrList2.Body.String(), `"installed":true`) {
		t.Fatalf("expected installed=true after install: %s", rrList2.Body.String())
	}

	// Removing custom source succeeds.
	if rrDel := doReq(t, h, srv.Token, "DELETE", "/api/plugins/market/sources/"+customID, nil); rrDel.Code != 200 {
		t.Fatalf("delete custom source failed: %d %s", rrDel.Code, rrDel.Body.String())
	}
}
