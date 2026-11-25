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

func TestArticleEditAdviseSelectionAndHistory(t *testing.T) {
	var lastMsgCount int
	var lastJSONMode bool
	mockText := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages       []map[string]any `json:"messages"`
			ResponseFormat map[string]any   `json:"response_format"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		lastMsgCount = len(req.Messages)
		lastJSONMode = req.ResponseFormat != nil
		lastUser := ""
		if len(req.Messages) > 0 {
			lastUser, _ = req.Messages[len(req.Messages)-1]["content"].(string)
		}
		var reply string
		switch {
		case strings.Contains(lastUser, "【选中待改片段】"):
			reply = `{"replacement":"秋天的早晨，烧一壶 92℃ 的水慢冲一杯浅烘咖啡。","summary":"压缩口语冗余并加入具体温度画面"}`
		case !lastJSONMode:
			reply = "### 诊断建议\n1. 开头略显平淡，建议删去“总而言之”。\n2. 备选标题：《秋日手冲：92℃ 的慢早晨》"
		default:
			reply = `{"title":"秋日手冲","content":"# 秋日手冲\n\n改写后的正文。","summary":"优化结构"}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": reply}}},
		})
	}))
	defer mockText.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()
	rrProv := doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id": "mocktxt2", "name": "MockText2", "kind": "openai", "purpose": "text",
		"baseUrl": mockText.URL + "/v1", "apiKey": "sk-mock2", "enabled": true,
		"models": []map[string]any{{"id": "writer-pro", "label": "Writer Pro"}},
	})
	if rrProv.Code != 200 {
		t.Fatalf("add provider: %d %s", rrProv.Code, rrProv.Body.String())
	}

	// 1. Advise mode with multi-turn history -> returns Markdown reply, JSONMode=false, history forwarded.
	rrAdvise := doReq(t, h, srv.Token, "POST", "/api/article/edit", map[string]any{
		"mode":         "advise",
		"title":        "秋日手冲",
		"content":      "总而言之，秋天喝手冲很好。",
		"instruction":  "帮我诊断一下开头并给 1 个标题建议",
		"history":      []map[string]any{{"role": "user", "content": "风格偏向温暖克制"}, {"role": "assistant", "content": "明白，保持克制与画面感。"}},
		"textModelRef": "mocktxt2:writer-pro",
	})
	if rrAdvise.Code != 200 {
		t.Fatalf("advise mode failed: %d %s", rrAdvise.Code, rrAdvise.Body.String())
	}
	if lastJSONMode || lastMsgCount != 4 { // system + 2 history + user
		t.Fatalf("expected jsonMode=false and 4 messages, got jsonMode=%v count=%d", lastJSONMode, lastMsgCount)
	}
	var advRes struct {
		Mode  string `json:"mode"`
		Reply string `json:"reply"`
	}
	_ = json.Unmarshal(rrAdvise.Body.Bytes(), &advRes)
	if advRes.Mode != "advise" || !strings.Contains(advRes.Reply, "诊断建议") {
		t.Fatalf("unexpected advise response: %+v", advRes)
	}

	// 2. Selection surgical rewrite mode -> returns mode="selection" + replacement.
	rrSel := doReq(t, h, srv.Token, "POST", "/api/article/edit", map[string]any{
		"mode":         "edit",
		"title":        "秋日手冲",
		"content":      "第一段。\n\n总而言之，秋天喝手冲很好。\n\n最后一段。",
		"selection":    "总而言之，秋天喝手冲很好。",
		"instruction":  "改得更有画面感",
		"textModelRef": "mocktxt2:writer-pro",
	})
	if rrSel.Code != 200 {
		t.Fatalf("selection edit failed: %d %s", rrSel.Code, rrSel.Body.String())
	}
	var selRes struct {
		Mode        string `json:"mode"`
		Replacement string `json:"replacement"`
		Summary     string `json:"summary"`
	}
	_ = json.Unmarshal(rrSel.Body.Bytes(), &selRes)
	if selRes.Mode != "selection" || !strings.Contains(selRes.Replacement, "92℃") || selRes.Summary == "" {
		t.Fatalf("unexpected selection response: %+v", selRes)
	}
}

func TestArticleEditSelectionScopeIsolationAndEchoGuard(t *testing.T) {
	var mu sync.Mutex
	var capturedMsgs []map[string]any
	mockText := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []map[string]any `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		capturedMsgs = req.Messages
		mu.Unlock()

		// Deliberately echo immediate before/after lines around the rewritten snippet to test echo stripping.
		replyObj := map[string]string{
			"replacement": "紧邻前文段落，用来测试局部衔接窗口是否只传附近内容。\n\n把这段话改写得更克制、更有节奏感。\n\n紧邻后文段落，同样仅用于局部衔接而不应被全文替换。",
			"summary":     "只改写了选中的核心一句",
		}
		b, _ := json.Marshal(replyObj)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": string(b)}}},
		})
	}))
	defer mockText.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()
	rrProv := doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id": "mocktxt3", "name": "MockText3", "kind": "openai", "purpose": "text",
		"baseUrl": mockText.URL + "/v1", "apiKey": "sk-mock3", "enabled": true,
		"models": []map[string]any{{"id": "writer-iso", "label": "Writer Iso"}},
	})
	if rrProv.Code != 200 {
		t.Fatalf("add provider: %d %s", rrProv.Code, rrProv.Body.String())
	}

	distantIntro := "DISTANT_INTRO_MARKER_NEVER_SEND " + strings.Repeat("这是一段远离选中区域的开头铺垫内容。", 30)
	nearBefore := "紧邻前文段落，用来测试局部衔接窗口是否只传附近内容。"
	targetSel := "原句略显啰嗦，需要单独润色这一句。"
	nearAfter := "紧邻后文段落，同样仅用于局部衔接而不应被全文替换。"
	distantOutro := strings.Repeat("这是一段远离选中区域的结尾总结内容。", 30) + " DISTANT_OUTRO_MARKER_NEVER_SEND"
	fullDoc := strings.Join([]string{distantIntro, nearBefore, targetSel, nearAfter, distantOutro}, "\n\n")

	rr := doReq(t, h, srv.Token, "POST", "/api/article/edit", map[string]any{
		"mode":        "edit",
		"title":       "长文局部改写测试",
		"content":     fullDoc,
		"selection":   targetSel,
		"instruction": "去掉冗余，保留原意",
		"sessionKey":  "article-full-doc-session",
		"history": []map[string]any{
			{"role": "user", "content": "请把整篇文章重新写一遍"},
			{"role": "assistant", "content": "好的，我将输出改写后的全文。"},
		},
		"textModelRef": "mocktxt3:writer-iso",
	})
	if rr.Code != 200 {
		t.Fatalf("selection edit failed: %d %s", rr.Code, rr.Body.String())
	}

	mu.Lock()
	msgs := capturedMsgs
	mu.Unlock()
	if len(msgs) != 2 {
		t.Fatalf("selection rewrite must isolate history (expected system+user=2 msgs), got %d", len(msgs))
	}
	userPrompt, _ := msgs[1]["content"].(string)
	if strings.Contains(userPrompt, "DISTANT_INTRO_MARKER_NEVER_SEND") || strings.Contains(userPrompt, "DISTANT_OUTRO_MARKER_NEVER_SEND") {
		t.Fatalf("selection rewrite leaked distant full-article paragraphs into prompt: %s", userPrompt)
	}
	if !strings.Contains(userPrompt, targetSel) || !strings.Contains(userPrompt, nearBefore) || !strings.Contains(userPrompt, nearAfter) {
		t.Fatalf("selection rewrite prompt missing target selection or local context window: %s", userPrompt)
	}

	var res struct {
		Mode        string `json:"mode"`
		Replacement string `json:"replacement"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &res)
	if res.Mode != "selection" {
		t.Fatalf("expected mode=selection, got %+v", res)
	}
	if res.Replacement != "把这段话改写得更克制、更有节奏感。" {
		t.Fatalf("expected echoed before/after context stripped, got %q", res.Replacement)
	}

	// Verify duplicate selection disambiguation with JS UTF-16 offsets (including surrogate-pair emoji).
	dupDoc := "段落一标记。\n\n重复句。\n\n🚀段落二标记。\n\n重复句。\n\n段落三标记。"
	// Compute UTF-16 start/end of the second "重复句。"
	secondByteIdx := strings.LastIndex(dupDoc, "重复句。")
	u16Start := 0
	for _, r := range dupDoc[:secondByteIdx] {
		if r > 0xFFFF {
			u16Start += 2
		} else {
			u16Start++
		}
	}
	u16End := u16Start + len([]rune("重复句。"))
	before, after := extractSelectionContextWindow(dupDoc, "重复句。", u16Start, u16End, 10)
	if !strings.Contains(before, "段落二标记") || !strings.Contains(after, "段落三标记") {
		t.Fatalf("expected UTF-16 offset to resolve second duplicate occurrence, got before=%q after=%q", before, after)
	}
}
