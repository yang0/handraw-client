package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/obsidian"
	"github.com/yang0/handraw-client/internal/skills"
)

func TestUnifiedMarketsSkillsObsidianAndPreferredMirror(t *testing.T) {
	skills.ClearMarketCache()
	obsidian.ClearMarketCache()
	t.Cleanup(func() {
		skills.ClearMarketCache()
		obsidian.ClearMarketCache()
	})

	var skillGiteeHits, skillGithubHits int
	var obsGiteeHits, obsGithubHits int

	mockSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/skills/index.json":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"format": 1,
				"title":  map[string]string{"zh": "测试 Skills 市场"},
				"metadata": map[string]any{
					"categories": map[string]any{
						"writing": map[string]any{"title": map[string]string{"zh": "写作"}},
					},
				},
				"skills": []map[string]any{
					{
						"id":          "test-polish-skill",
						"version":     "1.0.0",
						"name":        "测试文章润色",
						"description": "测试 Skill 市场双镜像容错安装",
						"author":      "Tester",
						"license":     "MIT",
						"categories":  []string{"writing"},
						"pricing":     map[string]any{"model": "free"},
						"source": map[string]any{
							"type": "skill-md",
							"url":  "http://" + r.Host + "/skills/github/SKILL.md",
							"mirrors": map[string]string{
								"gitee":  "http://" + r.Host + "/skills/gitee/SKILL.md",
								"github": "http://" + r.Host + "/skills/github/SKILL.md",
							},
						},
					},
				},
			})
		case "/skills/gitee/SKILL.md":
			skillGiteeHits++
			w.WriteHeader(http.StatusBadGateway)
		case "/skills/github/SKILL.md":
			skillGithubHits++
			_, _ = w.Write([]byte("---\nname: 测试文章润色\ndescription: 双镜像容错成功\nversion: \"1.0.0\"\n---\n\n请帮我润色文章。\n"))

		case "/obs/index.json":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"format": 1,
				"title":  map[string]string{"zh": "测试写作插件市场"},
				"plugins": []map[string]any{
					{
						"id":          "demo-writer-plugin",
						"version":     "1.2.3",
						"name":        "Demo 写作插件",
						"author":      "Tester",
						"description": "测试 Obsidian 镜像加速安装",
						"repo":        "tester/demo-writer-plugin",
						"categories":  []string{"writing"},
						"compatLevel": "verified",
						"files":       []string{"manifest.json", "main.js", "styles.css"},
						"downloadMirrors": map[string]string{
							"gitee":  "http://" + r.Host + "/obs/gitee/demo/",
							"github": "http://" + r.Host + "/obs/github/demo/",
						},
					},
				},
			})
		case "/obs/gitee/demo/manifest.json":
			obsGiteeHits++
			w.WriteHeader(http.StatusBadGateway)
		case "/obs/github/demo/manifest.json":
			obsGithubHits++
			_, _ = w.Write([]byte(`{"id":"demo-writer-plugin","name":"Demo 写作插件","version":"1.2.3","author":"Tester","description":"Mirror install test"}`))
		case "/obs/github/demo/main.js":
			_, _ = w.Write([]byte(`module.exports = class DemoPlugin { onload() {} };`))
		case "/obs/github/demo/styles.css":
			_, _ = w.Write([]byte(`.demo-writer { color: #c4472a; }`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockSrv.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// 1. Global PreferredMarketMirror persists via PATCH /api/settings.
	if rr := doReq(t, h, srv.Token, "PATCH", "/api/settings", map[string]any{"preferredMarketMirror": "github"}); rr.Code != 200 {
		t.Fatalf("PATCH preferredMarketMirror=github failed: %d %s", rr.Code, rr.Body.String())
	}
	rrSet := doReq(t, h, srv.Token, "GET", "/api/settings", nil)
	if !strings.Contains(rrSet.Body.String(), `"preferredMarketMirror":"github"`) {
		t.Fatalf("expected preferredMarketMirror=github persisted, got %s", rrSet.Body.String())
	}
	// Reset back to gitee to test gitee -> github failover below.
	_ = doReq(t, h, srv.Token, "PATCH", "/api/settings", map[string]any{"preferredMarketMirror": "gitee"})

	// 2. Official skill & obsidian market sources cannot be deleted.
	if rr := doReq(t, h, srv.Token, "DELETE", "/api/skills/market/sources/handraw-skills-official", nil); rr.Code != 400 {
		t.Fatalf("expected 400 deleting official skill market source, got %d", rr.Code)
	}
	if rr := doReq(t, h, srv.Token, "DELETE", "/api/article/obsidian/market/sources/handraw-obsidian-official", nil); rr.Code != 400 {
		t.Fatalf("expected 400 deleting official obsidian market source, got %d", rr.Code)
	}

	// 3. Subscribe custom Skills market & install with gitee->github failover.
	rrAddSk := doReq(t, h, srv.Token, "POST", "/api/skills/market/sources", map[string]any{
		"url": mockSrv.URL + "/skills/index.json",
	})
	if rrAddSk.Code != 200 {
		t.Fatalf("POST /api/skills/market/sources failed: %d %s", rrAddSk.Code, rrAddSk.Body.String())
	}
	var addSkOut struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rrAddSk.Body.Bytes(), &addSkOut)

	rrInstSk := doReq(t, h, srv.Token, "POST", "/api/skills/market/install", map[string]any{
		"id":     "test-polish-skill",
		"mirror": "gitee",
	})
	if rrInstSk.Code != 200 {
		t.Fatalf("POST /api/skills/market/install failed: %d %s", rrInstSk.Code, rrInstSk.Body.String())
	}
	if skillGiteeHits == 0 || skillGithubHits == 0 {
		t.Fatalf("expected skill install failover gitee->github, got gitee=%d github=%d", skillGiteeHits, skillGithubHits)
	}

	// 4. Subscribe custom Obsidian market & install via downloadMirrors failover.
	rrAddObs := doReq(t, h, srv.Token, "POST", "/api/article/obsidian/market/sources", map[string]any{
		"url": mockSrv.URL + "/obs/index.json",
	})
	if rrAddObs.Code != 200 {
		t.Fatalf("POST /api/article/obsidian/market/sources failed: %d %s", rrAddObs.Code, rrAddObs.Body.String())
	}
	var addObsOut struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rrAddObs.Body.Bytes(), &addObsOut)

	rrInstObs := doReq(t, h, srv.Token, "POST", "/api/article/obsidian/install", map[string]any{
		"sourceType": "market",
		"id":         "demo-writer-plugin",
		"mirror":     "gitee",
		"enable":     true,
	})
	if rrInstObs.Code != 200 || !strings.Contains(rrInstObs.Body.String(), `"demo-writer-plugin"`) {
		t.Fatalf("POST /api/article/obsidian/install via mirrors failed: %d %s", rrInstObs.Code, rrInstObs.Body.String())
	}
	if obsGiteeHits == 0 || obsGithubHits == 0 {
		t.Fatalf("expected obsidian mirror failover gitee->github, got gitee=%d github=%d", obsGiteeHits, obsGithubHits)
	}

	// 5. Remove custom market sources cleanly.
	if rr := doReq(t, h, srv.Token, "DELETE", "/api/skills/market/sources/"+addSkOut.ID, nil); rr.Code != 200 {
		t.Fatalf("DELETE custom skill market failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "DELETE", "/api/article/obsidian/market/sources/"+addObsOut.ID, nil); rr.Code != 200 {
		t.Fatalf("DELETE custom obsidian market failed: %d %s", rr.Code, rr.Body.String())
	}
}
