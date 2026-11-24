package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/skills"
	"github.com/yang0/handraw-client/internal/store"
)

func TestGenerateDirectPromptBypassesSkillAndPersistsMeta(t *testing.T) {
	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	h := srv.Handler()

	rawPrompt := "Cinematic 35mm photograph of a rainy neon street in Osaka, Kodak Portra 400, no text"
	rrGen := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":         "single",
		"title":        "Osaka Rain",
		"modelRef":     "p1:flux-pro",
		"resolution":   "2k",
		"quality":      "high",
		"directPrompt": true,
		"items": []map[string]any{
			{
				"theme":  rawPrompt,
				"prompt": rawPrompt,
				"style":  "FA-013", // must be ignored when directPrompt=true
				"layout": "SC-001",
				"ratio":  "16:9",
				"mode":   "graphic-text",
			},
		},
		"recipe": map[string]any{
			"styleIds": []string{"FA-013"},
			"layoutId": "SC-001",
		},
	})
	if rrGen.Code != http.StatusOK {
		t.Fatalf("POST /api/generate failed: %d %s", rrGen.Code, rrGen.Body.String())
	}
	var genResp struct {
		Run    store.Run     `json:"run"`
		Images []store.Image `json:"images"`
	}
	if err := json.Unmarshal(rrGen.Body.Bytes(), &genResp); err != nil {
		t.Fatalf("unmarshal generate resp: %v", err)
	}
	if len(genResp.Images) != 1 {
		t.Fatalf("expected 1 image, got %d", len(genResp.Images))
	}
	if genResp.Images[0].Prompt != rawPrompt {
		t.Fatalf("expected verbatim prompt %q, got %q", rawPrompt, genResp.Images[0].Prompt)
	}
	if strings.TrimSpace(string(genResp.Run.Recipe)) != "{}" {
		t.Fatalf("expected empty recipe {}, got %s", string(genResp.Run.Recipe))
	}
	meta := parseRunMeta(genResp.Run.Meta)
	if dp, _ := meta["directPrompt"].(bool); !dp {
		t.Fatalf("expected meta.directPrompt=true, got %s", string(genResp.Run.Meta))
	}
	if meta["ratio"] != "16:9" || meta["resolution"] != "2k" || meta["quality"] != "high" {
		t.Fatalf("unexpected meta specs: %v", meta)
	}

	// Verify GET /api/works/{id} reports isDirectPrompt=true and empty styleIds.
	rrGet := doReq(t, h, srv.Token, http.MethodGet, "/api/works/"+genResp.Run.ID, nil)
	if rrGet.Code != http.StatusOK {
		t.Fatalf("GET /api/works/{id} failed: %d %s", rrGet.Code, rrGet.Body.String())
	}
	var detail struct {
		IsDirectPrompt bool           `json:"isDirectPrompt"`
		ResolvedRecipe map[string]any `json:"resolvedRecipe"`
	}
	if err := json.Unmarshal(rrGet.Body.Bytes(), &detail); err != nil {
		t.Fatalf("unmarshal detail: %v", err)
	}
	if !detail.IsDirectPrompt {
		t.Fatalf("expected isDirectPrompt=true, got false")
	}
	if sids, _ := detail.ResolvedRecipe["styleIds"].([]any); len(sids) != 0 {
		t.Fatalf("expected empty styleIds for direct prompt run, got %v", sids)
	}
	if detail.ResolvedRecipe["ratio"] != "16:9" {
		t.Fatalf("expected ratio 16:9 from meta, got %v", detail.ResolvedRecipe["ratio"])
	}

	// Verify POST /api/works/{id}/publish rejects unpublished direct-prompt runs and guides to 灵感库.
	rrPub := doReq(t, h, srv.Token, http.MethodPost, "/api/works/"+genResp.Run.ID+"/publish", map[string]any{
		"title": "Osaka Rain",
		"price": 2,
	})
	if rrPub.Code != http.StatusBadRequest || !strings.Contains(rrPub.Body.String(), "灵感库") {
		t.Fatalf("expected 400 guiding to 灵感库, got %d %s", rrPub.Code, rrPub.Body.String())
	}
}

func TestWorkDetailSkillRunIsNotDirectPrompt(t *testing.T) {
	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	h := srv.Handler()

	run := &store.Run{
		ID:              "run_skill_87",
		Mode:            "single",
		Title:           "水彩咖啡馆",
		OriginalRequest: "阳光手冲咖啡",
		PromptZh:        "【画风：FA-013】阳光手冲咖啡",
		Recipe:          json.RawMessage(`{"styleIds":["FA-013"],"layoutId":"SC-001","ratio":"3:4"}`),
		Model:           "p1:flux",
		Source:          "provider",
		Status:          "done",
	}
	if err := srv.DB.InsertRun(run, []store.Image{{ID: "img_skill_87", Idx: 0, Status: "done", Prompt: run.PromptZh}}); err != nil {
		t.Fatalf("InsertRun: %v", err)
	}
	rrGet := doReq(t, h, srv.Token, http.MethodGet, "/api/works/"+run.ID, nil)
	if rrGet.Code != http.StatusOK {
		t.Fatalf("GET /api/works/{id} failed: %d %s", rrGet.Code, rrGet.Body.String())
	}
	var detail struct {
		IsDirectPrompt bool `json:"isDirectPrompt"`
	}
	_ = json.Unmarshal(rrGet.Body.Bytes(), &detail)
	if detail.IsDirectPrompt {
		t.Fatalf("expected Skill run to have isDirectPrompt=false")
	}
}

func TestChatTurnDirectPromptExcludesHandrawSkillAndBypassesPlan(t *testing.T) {
	srv, cancel := setupTestServer(t, "http://127.0.0.1:1")
	defer cancel()
	_ = secrets.Delete(secrets.SiteToken)
	h := srv.Handler()

	rawPrompt := "Isometric 3D clay bakery miniature, soft warm daylight, octane render"
	rrChat := doReq(t, h, srv.Token, http.MethodPost, "/api/chat/turn", map[string]any{
		"sessionId":     "sess_dp_87",
		"messages":      []map[string]string{{"role": "user", "content": rawPrompt}},
		"imageModelRef": "p1:flux-pro",
		"skillIds":      []string{skills.BuiltinHandrawSkillID},
		"directPrompt":  true,
		"ratio":         "1:1",
	})
	if rrChat.Code != http.StatusOK {
		t.Fatalf("POST /api/chat/turn failed: %d %s", rrChat.Code, rrChat.Body.String())
	}
	var resp struct {
		Reply      string              `json:"reply"`
		UsedSkills []map[string]string `json:"usedSkills"`
		Runs       []store.Run         `json:"runs"`
	}
	if err := json.Unmarshal(rrChat.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal chat resp: %v", err)
	}
	for _, sk := range resp.UsedSkills {
		if sk["id"] == skills.BuiltinHandrawSkillID {
			t.Fatalf("expected builtin handraw-skill excluded in directPrompt mode, got %v", resp.UsedSkills)
		}
	}
	if len(resp.Runs) != 1 {
		t.Fatalf("expected 1 direct-prompt run submitted, got %d (reply=%q)", len(resp.Runs), resp.Reply)
	}
	if !runHasExplicitDirectMeta(resp.Runs[0]) {
		t.Fatalf("expected chat directPrompt run to carry meta.directPrompt=true, got %s", string(resp.Runs[0].Meta))
	}
	if len(resp.Runs[0].Images) == 0 || resp.Runs[0].Images[0].Prompt != rawPrompt {
		t.Fatalf("expected verbatim prompt %q in chat run image, got %+v", rawPrompt, resp.Runs[0].Images)
	}
}
