package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/skills"
)

func TestChatAgentSkillsDrawAndPlugins(t *testing.T) {
	// 1x1 valid PNG
	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	var sawSkillInSystem atomic.Bool
	var chatStep atomic.Int32

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			_, _ = w.Write([]byte(`{"data":[{"b64_json":"` + tinyPNG + `"}]}`))
		case "/v1/chat/completions":
			var req struct {
				Messages []struct {
					Role    string `json:"role"`
					Content any    `json:"content"`
				} `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			sysText := ""
			lastUser := ""
			hasToolResult := false
			for _, m := range req.Messages {
				s, _ := m.Content.(string)
				switch m.Role {
				case "system":
					sysText += s
				case "user":
					lastUser = s
				case "tool":
					hasToolResult = true
				}
			}
			if strings.Contains(sysText, "每次先给三个标题") {
				sawSkillInSystem.Store(true)
			}
			chatStep.Add(1)

			// Route tool calls based on user intent in test
			switch {
			case strings.Contains(lastUser, "画两张咖啡") && !hasToolResult:
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"generate_images","arguments":"{\"title\":\"咖啡双图\",\"mode\":\"graphic-text\",\"ratio\":\"3:4\",\"items\":[{\"theme\":\"清晨手冲咖啡\",\"style\":\"FA-001\"},{\"theme\":\"午后拿铁拉花\",\"style\":\"FA-001\"}]}"}}]}}]}`))
			case strings.Contains(lastUser, "画两张咖啡") && hasToolResult:
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"已为你提交 2 张咖啡插画生成任务！"}}]}`))
			case strings.Contains(lastUser, "帮我安装一个写诗skill") && !hasToolResult:
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"call_2","type":"function","function":{"name":"install_skill","arguments":"{\"id\":\"poetry-helper\",\"name\":\"现代诗助手\",\"description\":\"写温暖短诗\",\"content\":\"每次写四行温暖小诗。\"}"}}]}}]}`))
			case strings.Contains(lastUser, "帮我安装一个写诗skill") && hasToolResult:
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"已为你创建并安装「现代诗助手」Skill！"}}]}`))
			case strings.Contains(lastUser, "安装本地插件") && !hasToolResult:
				// Extract path after colon
				_, p, _ := strings.Cut(lastUser, "::")
				argJSON, _ := json.Marshal(map[string]any{"source": strings.TrimSpace(p), "enable": true})
				argQuoted, _ := json.Marshal(string(argJSON))
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"call_3","type":"function","function":{"name":"install_plugin","arguments":` + string(argQuoted) + `}}]}}]}`))
			case strings.Contains(lastUser, "安装本地插件") && hasToolResult:
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"插件已安装并启用！"}}]}`))
			default:
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"你好！这是纯聊天回复。"}}]}`))
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockLLM.Close()

	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	srv.Skills = skills.New(filepath.Join(t.TempDir(), "skills"))
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	h := srv.Handler()

	// Configure both a custom text provider and a custom image provider.
	doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "txt1",
		"name":    "测试文本",
		"kind":    "openai",
		"purpose": "text",
		"baseUrl": mockLLM.URL + "/v1",
		"apiKey":  "sk-txt",
		"enabled": true,
		"models":  []map[string]any{{"id": "gpt-4o", "name": "GPT-4o"}},
	})
	doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "img1",
		"name":    "测试生图",
		"kind":    "openai",
		"purpose": "image",
		"baseUrl": mockLLM.URL + "/v1",
		"apiKey":  "sk-img",
		"enabled": true,
		"models":  []map[string]any{{"id": "mock-img", "name": "Mock Img"}},
	})

	// 1. Install a user skill via HTTP API and verify list.
	rrSk := doReq(t, h, srv.Token, "POST", "/api/skills/install", map[string]any{
		"id":          "title-master",
		"name":        "标题大师",
		"description": "给出高点击标题",
		"content":     "每次先给三个标题方案。",
	})
	if rrSk.Code != 200 {
		t.Fatalf("skill install failed: %d %s", rrSk.Code, rrSk.Body.String())
	}

	// 2. Pure AI chat with enabled skill injected.
	rrChat := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages":      []map[string]string{{"role": "user", "content": "帮我聊聊手账灵感"}},
		"textModelRef":  "txt1:gpt-4o",
		"imageModelRef": "img1:mock-img",
	})
	if rrChat.Code != 200 {
		t.Fatalf("pure chat failed: %d %s", rrChat.Code, rrChat.Body.String())
	}
	var chatRes chatTurnResponse
	_ = json.Unmarshal(rrChat.Body.Bytes(), &chatRes)
	if chatRes.Reply != "你好！这是纯聊天回复。" || len(chatRes.UsedSkills) != 1 || !sawSkillInSystem.Load() {
		t.Fatalf("expected pure chat + skill injection, got res=%+v sawSkill=%v", chatRes, sawSkillInSystem.Load())
	}

	// 2b. Explicit empty skillIds: [] disables auto-injection (e.g. after user removes skill chips).
	sawSkillInSystem.Store(false)
	rrNoSkill := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages":      []map[string]string{{"role": "user", "content": "随便聊聊"}},
		"textModelRef":  "txt1:gpt-4o",
		"imageModelRef": "img1:mock-img",
		"skillIds":      []string{},
	})
	if rrNoSkill.Code != 200 {
		t.Fatalf("chat with empty skillIds failed: %d %s", rrNoSkill.Code, rrNoSkill.Body.String())
	}
	var noSkillRes chatTurnResponse
	_ = json.Unmarshal(rrNoSkill.Body.Bytes(), &noSkillRes)
	if len(noSkillRes.UsedSkills) != 0 || sawSkillInSystem.Load() {
		t.Fatalf("expected 0 used skills when skillIds:[], got %+v saw=%v", noSkillRes.UsedSkills, sawSkillInSystem.Load())
	}

	// 3. Chat-driven multi-image generation via tool calling.
	rrDraw := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages":      []map[string]string{{"role": "user", "content": "帮我画两张咖啡插画"}},
		"textModelRef":  "txt1:gpt-4o",
		"imageModelRef": "img1:mock-img",
	})
	if rrDraw.Code != 200 {
		t.Fatalf("chat draw failed: %d %s", rrDraw.Code, rrDraw.Body.String())
	}
	var drawRes chatTurnResponse
	_ = json.Unmarshal(rrDraw.Body.Bytes(), &drawRes)
	if len(drawRes.Runs) != 1 || len(drawRes.ToolCalls) != 1 || !drawRes.ToolCalls[0].OK {
		t.Fatalf("expected 1 run + 1 ok tool call, got %+v", drawRes)
	}

	// 4. Chat-driven Skill installation via tool calling.
	rrChatSk := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages":      []map[string]string{{"role": "user", "content": "帮我安装一个写诗skill"}},
		"textModelRef":  "txt1:gpt-4o",
		"imageModelRef": "img1:mock-img",
	})
	if rrChatSk.Code != 200 {
		t.Fatalf("chat install skill failed: %d %s", rrChatSk.Code, rrChatSk.Body.String())
	}
	var skRes chatTurnResponse
	_ = json.Unmarshal(rrChatSk.Body.Bytes(), &skRes)
	if !skRes.SkillsChanged {
		t.Fatalf("expected skillsChanged=true, got %+v", skRes)
	}
	if _, err := srv.Skills.Get("poetry-helper"); err != nil {
		t.Fatalf("expected poetry-helper installed on disk: %v", err)
	}

	// 5. Chat-driven Plugin installation from local plugin folder via tool calling.
	plugDir := filepath.Join(t.TempDir(), "sample-chat-plugin")
	_ = os.MkdirAll(plugDir, 0o755)
	_ = os.WriteFile(filepath.Join(plugDir, "package.json"), []byte(`{"name":"chat-demo-plug","version":"0.1.0","description":"demo","handraw":{"id":"chat-demo-plug","name":"会话演示插件"}}`), 0o644)
	rrChatPlug := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages":      []map[string]string{{"role": "user", "content": "请帮我安装本地插件::" + plugDir}},
		"textModelRef":  "txt1:gpt-4o",
		"imageModelRef": "img1:mock-img",
	})
	if rrChatPlug.Code != 200 {
		t.Fatalf("chat install plugin failed: %d %s", rrChatPlug.Code, rrChatPlug.Body.String())
	}
	var plugRes chatTurnResponse
	_ = json.Unmarshal(rrChatPlug.Body.Bytes(), &plugRes)
	if !plugRes.PluginsChanged || len(plugRes.ToolCalls) != 1 || !plugRes.ToolCalls[0].OK {
		t.Fatalf("expected plugin installed via chat, got %+v", plugRes)
	}

	// 6. Direct slash command /install-skill from local SKILL.md works cleanly.
	mdPath := filepath.Join(t.TempDir(), "quick.md")
	_ = os.WriteFile(mdPath, []byte("---\nname: quick-note\ndescription: 快速笔记\n---\n总结要点。"), 0o644)
	rrSlash := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages":      []map[string]string{{"role": "user", "content": "/install-skill " + mdPath}},
		"imageModelRef": "img1:mock-img",
	})
	if rrSlash.Code != 200 {
		t.Fatalf("slash /install-skill failed: %d %s", rrSlash.Code, rrSlash.Body.String())
	}
	if _, err := srv.Skills.Get("quick-note"); err != nil {
		t.Fatalf("expected quick-note installed via slash command: %v", err)
	}

	_ = base64.StdEncoding
}
