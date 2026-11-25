package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
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

func TestExtensionSubmissionInspectAIAndManifestFallback(t *testing.T) {
	mockGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/alice/handraw-sketch-board":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"name":"handraw-sketch-board","description":"Interactive whiteboard for Markdown notes","default_branch":"main","topics":["whiteboard","obsidian"],"owner":{"login":"alice"}}`))
		case "/alice/handraw-sketch-board/main/manifest.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"sketch-board","name":"Sketch Board","version":"1.4.2","minAppVersion":"1.4.0","author":"Alice","description":"Embed hand-drawn whiteboards in Markdown notes."}`))
		case "/alice/handraw-sketch-board/main/README.md":
			_, _ = w.Write([]byte("# Sketch Board\n\nEmbed hand-drawn whiteboards and flowcharts directly inside Markdown notes.\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockGH.Close()

	prevAPI, prevRaw := submissionGitHubAPIBase, submissionGitHubRawBase
	submissionGitHubAPIBase = mockGH.URL
	submissionGitHubRawBase = mockGH.URL
	t.Cleanup(func() {
		submissionGitHubAPIBase = prevAPI
		submissionGitHubRawBase = prevRaw
	})

	// 1. Without AI configured -> deterministic manifest extraction still works seamlessly.
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()
	rrManifest := doReq(t, h, srv.Token, "POST", "/api/extensions/submissions/inspect", map[string]any{
		"repoUrl": "alice/handraw-sketch-board",
	})
	if rrManifest.Code != 200 {
		t.Fatalf("inspect manifest fallback failed: %d %s", rrManifest.Code, rrManifest.Body.String())
	}
	var manRes struct {
		ParsedBy string                 `json:"parsedBy"`
		Info     inspectedExtensionInfo `json:"info"`
	}
	_ = json.Unmarshal(rrManifest.Body.Bytes(), &manRes)
	if manRes.ParsedBy != "manifest" || manRes.Info.Channel != "obsidian" || manRes.Info.Name != "Sketch Board" || manRes.Info.Version != "1.4.2" || manRes.Info.RepoURL != "https://github.com/alice/handraw-sketch-board" {
		t.Fatalf("unexpected manifest inspect result: %+v", manRes)
	}

	// 2. With text AI provider -> AI enriches into clean Chinese display title & summary.
	mockAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reply, _ := json.Marshal(map[string]any{
			"channel":     "obsidian",
			"name":        "Sketch Board 手绘白板",
			"description": "在 Markdown 笔记中直接嵌入可交互手绘白板与流程图，支持双向跳转。",
			"authorName":  "Alice",
			"version":     "1.4.2",
			"tags":        []string{"白板", "手绘", "流程图"},
		})
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": string(reply)}}},
		})
	}))
	defer mockAI.Close()

	_, err := settings.Update(func(st *settings.Settings) error {
		st.Providers = append(st.Providers, settings.Provider{
			ID:      "mockins",
			Name:    "MockInspectAI",
			Kind:    "openai",
			Purpose: "text",
			BaseURL: mockAI.URL + "/v1",
			Enabled: true,
			Models:  []settings.Model{{ID: "fast-parse", Label: "Fast Parse"}},
		})
		st.DefaultTextModel = "mockins:fast-parse"
		return nil
	})
	if err != nil {
		t.Fatalf("update text provider: %v", err)
	}

	rrAI := doReq(t, h, srv.Token, "POST", "/api/extensions/submissions/inspect", map[string]any{
		"repoUrl": "https://github.com/alice/handraw-sketch-board",
	})
	if rrAI.Code != 200 {
		t.Fatalf("inspect with AI failed: %d %s", rrAI.Code, rrAI.Body.String())
	}
	var aiRes struct {
		ParsedBy string                 `json:"parsedBy"`
		Info     inspectedExtensionInfo `json:"info"`
	}
	_ = json.Unmarshal(rrAI.Body.Bytes(), &aiRes)
	if aiRes.ParsedBy != "ai" || aiRes.Info.Channel != "obsidian" || aiRes.Info.Name != "Sketch Board 手绘白板" || !strings.Contains(aiRes.Info.Description, "手绘白板") || len(aiRes.Info.Tags) != 3 {
		t.Fatalf("unexpected AI inspect result: %+v", aiRes)
	}
}
