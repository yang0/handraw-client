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

	"github.com/yang0/handraw-client/internal/settings"
)

func TestSkillDiscoveryImportHostAPIAndArticleEdit(t *testing.T) {
	// Mock OpenAI-compatible text model capturing the system prompt so we verify Skill injection.
	var mu sync.Mutex
	var lastSystemPrompt string
	mockText := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		lastSystemPrompt = ""
		for _, m := range body.Messages {
			if m.Role == "system" {
				lastSystemPrompt = m.Content
			}
		}
		mu.Unlock()

		replyJSON, _ := json.Marshal(map[string]string{
			"title":   "秋日手冲咖啡（去AI味版）",
			"content": "# 秋日手冲咖啡（去AI味版）\n\n早晨倒一杯刚手冲好的浅烘咖啡，比任何闹钟都管用。\n\n![手冲封面](assets/coffee/01.png)",
			"summary": "已按「less-ai-tone」规则去掉套话，保留了原有的本地配图链接。",
		})
		resp := map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"role": "assistant", "content": string(replyJSON)}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockText.Close()

	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	// Configure mock text provider.
	_, err := settings.Update(func(st *settings.Settings) error {
		st.Providers = append(st.Providers, settings.Provider{
			ID:      "mocktxt",
			Name:    "MockText",
			Kind:    "openai",
			Purpose: "text",
			BaseURL: mockText.URL + "/v1",
			Enabled: true,
			Models:  []settings.Model{{ID: "mock-writer", Label: "Mock Writer"}},
		})
		st.DefaultTextModel = "mocktxt:mock-writer"
		return nil
	})
	if err != nil {
		t.Fatalf("update text provider failed: %v", err)
	}

	// Build isolated fake home with Claude Code + Antigravity skills.
	fakeHome := t.TempDir()
	t.Setenv("HANDRAW_SKILL_DISCOVER_HOME", fakeHome)
	for _, k := range []string{
		"XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME",
		"WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "COPILOT_HOME",
		"GROK_HOME", "HERMES_HOME", "PI_CODING_AGENT_DIR", "KIMI_CODE_HOME",
	} {
		t.Setenv(k, "")
	}
	skillDir := filepath.Join(fakeHome, ".claude", "skills", "less-ai-tone")
	_ = os.MkdirAll(skillDir, 0o755)
	_ = os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: less-ai-tone\ndescription: 去掉文章中的 AI 腔调\n---\n\n规则：严禁使用“总而言之”“值得注意的是”等机器套话。\n"), 0o644)

	// 1. Discover harness skills via HTTP.
	rrDisc := doReq(t, h, srv.Token, "GET", "/api/skills/discover", nil)
	if rrDisc.Code != 200 {
		t.Fatalf("discover failed: %d %s", rrDisc.Code, rrDisc.Body.String())
	}
	if !strings.Contains(rrDisc.Body.String(), "less-ai-tone") || !strings.Contains(rrDisc.Body.String(), "Claude Code") {
		t.Fatalf("expected Claude Code skill discovered, got %s", rrDisc.Body.String())
	}

	// 2. Selective batch import into Handraw.
	rrImp := doReq(t, h, srv.Token, "POST", "/api/skills/import-local", map[string]any{
		"items": []map[string]any{
			{"dir": skillDir, "clientId": "claude", "clientName": "Claude Code"},
		},
	})
	if rrImp.Code != 200 || !strings.Contains(rrImp.Body.String(), "less-ai-tone") {
		t.Fatalf("import-local failed: %d %s", rrImp.Code, rrImp.Body.String())
	}

	// 3. Verify Host Skills API (for DSH / L1 plugins) exposes the imported skill.
	rrHostList := doReq(t, h, srv.Token, "GET", "/api/host/skills", nil)
	if rrHostList.Code != 200 || !strings.Contains(rrHostList.Body.String(), "less-ai-tone") {
		t.Fatalf("host skills list missing imported skill: %d %s", rrHostList.Code, rrHostList.Body.String())
	}
	rrHostGet := doReq(t, h, srv.Token, "GET", "/api/host/skills/less-ai-tone", nil)
	if rrHostGet.Code != 200 || !strings.Contains(rrHostGet.Body.String(), "机器套话") {
		t.Fatalf("host skill get failed: %d %s", rrHostGet.Code, rrHostGet.Body.String())
	}

	// 4. Edit article using imported Skill -> verifies Skill body injected into prompt & structured revision returned.
	rrEdit := doReq(t, h, srv.Token, "POST", "/api/article/edit", map[string]any{
		"title":        "秋日手冲咖啡",
		"content":      "# 秋日手冲咖啡\n\n值得注意的是，总而言之手冲咖啡很不错。\n\n![手冲封面](assets/coffee/01.png)",
		"instruction":  "请去掉 AI 味并保留配图链接",
		"skillIds":     []string{"less-ai-tone"},
		"textModelRef": "mocktxt:mock-writer",
	})
	if rrEdit.Code != 200 {
		t.Fatalf("article edit failed: %d %s", rrEdit.Code, rrEdit.Body.String())
	}
	mu.Lock()
	sysUsed := lastSystemPrompt
	mu.Unlock()
	if !strings.Contains(sysUsed, "严禁使用“总而言之”") {
		t.Fatalf("expected imported skill instructions injected into system prompt, got: %s", sysUsed)
	}
	var editRes struct {
		Title      string              `json:"title"`
		Content    string              `json:"content"`
		Summary    string              `json:"summary"`
		UsedSkills []map[string]string `json:"usedSkills"`
	}
	_ = json.Unmarshal(rrEdit.Body.Bytes(), &editRes)
	if editRes.Title != "秋日手冲咖啡（去AI味版）" || !strings.Contains(editRes.Content, "assets/coffee/01.png") || len(editRes.UsedSkills) != 1 {
		t.Fatalf("unexpected article edit response: %+v", editRes)
	}
}
