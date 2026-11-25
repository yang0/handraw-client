package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/site"
)

func TestExtensionSubmissionsProxy(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	fakeSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/extensions/submissions":
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"submission": map[string]any{
					"id":      42,
					"channel": gotBody["channel"],
					"name":    gotBody["name"],
					"status":  "pending",
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/extensions/submissions/mine":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"items": []map[string]any{
					{"id": 42, "channel": "plugin", "name": "Demo 插件", "status": "pending"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer fakeSite.Close()

	srv, _ := setupTestServer(t, "")
	srv.Site = site.NewWithBase(fakeSite.URL, "test")
	h := srv.Handler()

	// Signed-out GET /mine returns loggedIn=false cleanly without upstream call.
	_ = secrets.Delete(secrets.SiteToken)
	rrOut := doReq(t, h, srv.Token, "GET", "/api/extensions/submissions/mine", nil)
	if rrOut.Code != 200 || !strings.Contains(rrOut.Body.String(), `"loggedIn":false`) {
		t.Fatalf("expected loggedIn=false when signed out, got %d %s", rrOut.Code, rrOut.Body.String())
	}

	// Signed-out POST fails with 401.
	rrNoAuth := doReq(t, h, srv.Token, "POST", "/api/extensions/submissions", map[string]any{
		"channel":     "plugin",
		"name":        "Demo 插件",
		"repoUrl":     "https://github.com/demo/plugin",
		"description": "测试提交",
	})
	if rrNoAuth.Code != 401 {
		t.Fatalf("expected 401 when signed out, got %d %s", rrNoAuth.Code, rrNoAuth.Body.String())
	}

	// Signed-in POST & GET proxy cleanly with Bearer token.
	if err := secrets.Set(secrets.SiteToken, "tok-test-submit-123"); err != nil {
		t.Fatal(err)
	}
	defer secrets.Delete(secrets.SiteToken)

	rrPost := doReq(t, h, srv.Token, "POST", "/api/extensions/submissions", map[string]any{
		"channel":     "gallery",
		"name":        "复古构图图库",
		"repoUrl":     "https://github.com/demo/gallery",
		"description": "收录复古构图参考图",
	})
	if rrPost.Code != 200 || !strings.Contains(rrPost.Body.String(), `"id":42`) {
		t.Fatalf("expected 200 proxy response, got %d %s", rrPost.Code, rrPost.Body.String())
	}
	if gotAuth != "Bearer tok-test-submit-123" || gotBody["channel"] != "gallery" || gotBody["sourceClient"] != "desktop" {
		t.Fatalf("unexpected upstream request: auth=%q body=%+v", gotAuth, gotBody)
	}

	rrMine := doReq(t, h, srv.Token, "GET", "/api/extensions/submissions/mine?channel=plugin", nil)
	if rrMine.Code != 200 || !strings.Contains(rrMine.Body.String(), `"loggedIn":true`) || !strings.Contains(rrMine.Body.String(), `"Demo 插件"`) {
		t.Fatalf("unexpected GET /mine response: %d %s", rrMine.Code, rrMine.Body.String())
	}
}
