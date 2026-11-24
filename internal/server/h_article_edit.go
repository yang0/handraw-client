package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/yang0/handraw-client/internal/providers"
)

type articleEditHistoryTurn struct {
	Role    string `json:"role"` // "user" | "assistant"
	Content string `json:"content"`
}

type articleEditRequest struct {
	Title        string                   `json:"title"`
	Content      string                   `json:"content"`
	Instruction  string                   `json:"instruction"`
	Mode         string                   `json:"mode"`      // "edit" (default) | "advise"
	Selection    string                   `json:"selection"` // optional selected passage for surgical local rewrite
	History      []articleEditHistoryTurn `json:"history"`   // optional recent multi-turn context
	SkillIDs     []string                 `json:"skillIds"`
	TextModelRef string                   `json:"textModelRef"`
}

func appendArticleHistory(msgs []providers.ChatMessage, history []articleEditHistoryTurn) []providers.ChatMessage {
	if len(history) == 0 {
		return msgs
	}
	start := 0
	if len(history) > 8 {
		start = len(history) - 8
	}
	for _, h := range history[start:] {
		role := strings.ToLower(strings.TrimSpace(h.Role))
		if role != "user" && role != "assistant" {
			continue
		}
		txt := strings.TrimSpace(h.Content)
		if txt == "" {
			continue
		}
		if r := []rune(txt); len(r) > 2000 {
			txt = string(r[:2000]) + "…"
		}
		msgs = append(msgs, providers.ChatMessage{Role: role, Content: txt})
	}
	return msgs
}

func (s *Server) executeHostChatWithJSONFallback(ctx context.Context, req hostChatRequest) (map[string]any, error) {
	res, err := s.executeHostChat(ctx, req)
	if err != nil && req.JSONMode {
		retry := req
		retry.JSONMode = false
		if retryRes, retryErr := s.executeHostChat(ctx, retry); retryErr == nil {
			return retryRes, nil
		}
	}
	return res, err
}

func (s *Server) articleEdit(w http.ResponseWriter, r *http.Request) (any, error) {
	var req articleEditRequest
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	instruction := strings.TrimSpace(req.Instruction)
	if instruction == "" {
		return nil, bad("请输入希望 AI 处理文章的具体要求")
	}
	content := strings.ReplaceAll(req.Content, "\r\n", "\n")
	title := strings.TrimSpace(req.Title)
	selection := strings.ReplaceAll(strings.TrimSpace(req.Selection), "\r\n", "\n")
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode != "advise" {
		mode = "edit"
	}

	allSkills, _ := s.skillsManager().List()
	activeSkills, _, cleanedInstruction := resolveActiveSkills(allSkills, req.SkillIDs, instruction)
	if strings.TrimSpace(cleanedInstruction) == "" {
		if mode == "advise" {
			cleanedInstruction = "请按照已启用的 Skill 规范，对这篇文章给出结构化诊断与具体改进建议。"
		} else if selection != "" {
			cleanedInstruction = "请按照已启用的 Skill 规范优化并润色选中的片段。"
		} else {
			cleanedInstruction = "请按照已启用的 Skill 规范优化并润色这篇 Markdown 文章。"
		}
	}

	usedSkills := make([]map[string]string, 0, len(activeSkills))
	activeIDs := make([]string, 0, len(activeSkills))
	for _, sk := range activeSkills {
		usedSkills = append(usedSkills, map[string]string{"id": sk.ID, "name": sk.Name})
		activeIDs = append(activeIDs, sk.ID)
	}

	// 1. Advise / Diagnose mode: return structured Markdown feedback without overwriting the article.
	if mode == "advise" {
		sysPrompt := strings.TrimSpace(`你是资深中文内容主编与写作教练。请通读用户提供的文章（以及可能选中的重点片段与启用的 Skill 规范），输出清晰、直接、可执行的 Markdown 诊断、改稿建议或标题方案。

要求：
1. 紧扣文章原文，指出具体位置与问题原因，不要泛泛而谈。
2. 如用户要求提供标题、开头或句式示例，用清晰的编号列表呈现，方便一键采用。
3. 直接输出 Markdown 正文，不要包裹 JSON。`)

		var userMsg strings.Builder
		userMsg.WriteString("【用户需求】\n")
		userMsg.WriteString(cleanedInstruction)
		userMsg.WriteString("\n\n【当前标题】\n")
		userMsg.WriteString(firstStr(title, "（未设置标题）"))
		if selection != "" {
			userMsg.WriteString("\n\n【重点关注片段】\n")
			userMsg.WriteString(selection)
		}
		userMsg.WriteString("\n\n【文章 Markdown 正文】\n")
		userMsg.WriteString(content)

		msgs := appendArticleHistory(nil, req.History)
		msgs = append(msgs, providers.ChatMessage{Role: "user", Content: userMsg.String()})

		chatRes, err := s.executeHostChat(r.Context(), hostChatRequest{
			ModelRef:   strings.TrimSpace(req.TextModelRef),
			Capability: "text",
			System:     sysPrompt,
			SkillIDs:   activeIDs,
			Messages:   msgs,
			JSONMode:   false,
		})
		if err != nil {
			return nil, err
		}
		reply := strings.TrimSpace(asString(chatRes["text"]))
		if reply == "" {
			return nil, bad("AI 返回的建议为空，请重试或换个文本模型")
		}
		return map[string]any{
			"ok":         true,
			"mode":       "advise",
			"reply":      reply,
			"usedSkills": usedSkills,
			"source":     chatRes["source"],
			"model":      firstStr(asString(chatRes["model"]), asString(chatRes["service"])),
		}, nil
	}

	// 2. Surgical selection rewrite mode: modify ONLY the highlighted passage.
	if selection != "" {
		sysPrompt := strings.TrimSpace(`你是精准的中文文章局部润色编辑。用户只选中了文章中的一小段文字要求改写。

核心要求：
1. 只改写【选中待改片段】，保持与上下文语气、人称与事实一致，严禁复述文章其他段落。
2. 保留片段内必要的 Markdown 格式或配图链接（如有）。
3. 请严格只输出一个 JSON 对象，不要包含额外解释，字段如下：
{
  "replacement": "改写后的局部片段文本",
  "summary": "1 句话简洁概括本次局部修改点"
}`)
		var userMsg strings.Builder
		userMsg.WriteString("【修改要求】\n")
		userMsg.WriteString(cleanedInstruction)
		userMsg.WriteString("\n\n【选中待改片段】\n")
		userMsg.WriteString(selection)
		userMsg.WriteString("\n\n【文章上下文参考】\n标题：")
		userMsg.WriteString(firstStr(title, "（未设置标题）"))
		userMsg.WriteString("\n")
		ctxContent := content
		if r := []rune(ctxContent); len(r) > 4000 {
			ctxContent = string(r[:4000]) + "\n……"
		}
		userMsg.WriteString(ctxContent)

		msgs := appendArticleHistory(nil, req.History)
		msgs = append(msgs, providers.ChatMessage{Role: "user", Content: userMsg.String()})

		chatRes, err := s.executeHostChatWithJSONFallback(r.Context(), hostChatRequest{
			ModelRef:   strings.TrimSpace(req.TextModelRef),
			Capability: "text",
			System:     sysPrompt,
			SkillIDs:   activeIDs,
			Messages:   msgs,
			JSONMode:   true,
		})
		if err != nil {
			return nil, err
		}
		rawReply, _ := chatRes["text"].(string)
		replacement, summary := parseArticleSelectionOutput(rawReply)
		if strings.TrimSpace(replacement) == "" {
			return nil, bad("AI 返回的局部改写结果为空，请重试或换个文本模型")
		}
		return map[string]any{
			"ok":          true,
			"mode":        "selection",
			"selection":   selection,
			"replacement": replacement,
			"summary":     summary,
			"usedSkills":  usedSkills,
			"source":      chatRes["source"],
			"model":       firstStr(asString(chatRes["model"]), asString(chatRes["service"])),
		}, nil
	}

	// 3. Full-article edit mode (default).
	sysPrompt := strings.TrimSpace(`你是专业中文文章编辑与润色助手。请根据用户的修改要求（以及下方启用的 Skill 规范），修改提供的 Markdown 文章。

核心要求：
1. 忠实保留原文的核心事实、数据、专有名词与已有配图链接（如 ![...](assets/...)），除非用户明确要求删改。
2. 输出合法 Markdown 正文，段落层次清晰、自然流畅。
3. 请严格只输出一个 JSON 对象，不要包含额外解释，字段如下：
{
  "title": "修改后的文章主标题（如无需修改则保持原标题）",
  "content": "修改后的完整 Markdown 正文",
  "summary": "1~2 句话简洁概括本次做了哪些修改"
}`)

	var userMsg strings.Builder
	userMsg.WriteString("【修改要求】\n")
	userMsg.WriteString(cleanedInstruction)
	userMsg.WriteString("\n\n【当前标题】\n")
	if title != "" {
		userMsg.WriteString(title)
	} else {
		userMsg.WriteString("（未设置标题）")
	}
	userMsg.WriteString("\n\n【当前 Markdown 正文】\n")
	userMsg.WriteString(content)

	msgs := appendArticleHistory(nil, req.History)
	msgs = append(msgs, providers.ChatMessage{Role: "user", Content: userMsg.String()})

	chatRes, err := s.executeHostChatWithJSONFallback(r.Context(), hostChatRequest{
		ModelRef:   strings.TrimSpace(req.TextModelRef),
		Capability: "text",
		System:     sysPrompt,
		SkillIDs:   activeIDs,
		Messages:   msgs,
		JSONMode:   true,
	})
	if err != nil {
		return nil, err
	}

	rawReply, _ := chatRes["text"].(string)
	newTitle, newContent, summary := parseArticleEditOutput(rawReply, title)
	if strings.TrimSpace(newContent) == "" {
		return nil, bad("AI 返回的修改结果为空，请重试或换个文本模型")
	}

	return map[string]any{
		"ok":         true,
		"mode":       "edit",
		"title":      newTitle,
		"content":    newContent,
		"summary":    summary,
		"usedSkills": usedSkills,
		"source":     chatRes["source"],
		"model":      firstStr(asString(chatRes["model"]), asString(chatRes["service"])),
	}, nil
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func stripJSONCandidate(raw string) string {
	candidate := strings.TrimSpace(raw)
	if strings.HasPrefix(candidate, "```") {
		if idx := strings.IndexByte(candidate, '\n'); idx >= 0 {
			candidate = candidate[idx+1:]
		}
		if end := strings.LastIndex(candidate, "```"); end >= 0 {
			candidate = candidate[:end]
		}
		candidate = strings.TrimSpace(candidate)
	}
	if !strings.HasPrefix(candidate, "{") {
		if s := strings.IndexByte(candidate, '{'); s >= 0 {
			if e := strings.LastIndexByte(candidate, '}'); e > s {
				candidate = candidate[s : e+1]
			}
		}
	}
	return candidate
}

func parseArticleSelectionOutput(raw string) (replacement, summary string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}
	candidate := stripJSONCandidate(trimmed)
	var parsed struct {
		Replacement string `json:"replacement"`
		Content     string `json:"content"`
		Text        string `json:"text"`
		Summary     string `json:"summary"`
	}
	if json.Unmarshal([]byte(candidate), &parsed) == nil {
		rep := firstStr(parsed.Replacement, parsed.Content, parsed.Text)
		if strings.TrimSpace(rep) != "" {
			sum := strings.TrimSpace(parsed.Summary)
			if sum == "" {
				sum = "已完成局部片段改写"
			}
			return strings.ReplaceAll(rep, "\r\n", "\n"), sum
		}
	}
	return strings.ReplaceAll(trimmed, "\r\n", "\n"), "已完成局部片段改写"
}

func parseArticleEditOutput(raw, fallbackTitle string) (title, content, summary string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallbackTitle, "", ""
	}
	candidate := stripJSONCandidate(trimmed)
	var parsed struct {
		Title   string `json:"title"`
		Content string `json:"content"`
		Summary string `json:"summary"`
	}
	if json.Unmarshal([]byte(candidate), &parsed) == nil && strings.TrimSpace(parsed.Content) != "" {
		t := strings.TrimSpace(parsed.Title)
		if t == "" {
			t = fallbackTitle
		}
		sum := strings.TrimSpace(parsed.Summary)
		if sum == "" {
			sum = "已完成文章修改"
		}
		return t, strings.ReplaceAll(parsed.Content, "\r\n", "\n"), sum
	}
	// Graceful fallback if the model returned plain Markdown directly.
	md := strings.ReplaceAll(trimmed, "\r\n", "\n")
	t := fallbackTitle
	if t == "" {
		t = extractMarkdownTitle(md, "未命名文章.md")
	}
	return t, md, "已完成文章修改"
}
