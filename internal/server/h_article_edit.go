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
	Title          string                   `json:"title"`
	Content        string                   `json:"content"`
	Instruction    string                   `json:"instruction"`
	Mode           string                   `json:"mode"`           // "edit" (default) | "advise"
	Selection      string                   `json:"selection"`      // optional selected passage for surgical local rewrite
	SelectionStart int                      `json:"selectionStart"` // optional UTF-16/rune start offset of selection in content
	SelectionEnd   int                      `json:"selectionEnd"`   // optional UTF-16/rune end offset of selection in content
	History        []articleEditHistoryTurn `json:"history"`        // optional recent multi-turn context
	SkillIDs       []string                 `json:"skillIds"`
	TextModelRef   string                   `json:"textModelRef"`
	SessionKey     string                   `json:"sessionKey"`
}

func attachChatMeta(out map[string]any, chatRes map[string]any) map[string]any {
	out["source"] = chatRes["source"]
	out["model"] = firstStr(asString(chatRes["model"]), asString(chatRes["service"]))
	if h := asString(chatRes["harness"]); h != "" {
		out["harness"] = h
	}
	if hn := asString(chatRes["harnessName"]); hn != "" {
		out["harnessName"] = hn
	}
	if ms, ok := chatRes["elapsedMs"]; ok {
		out["elapsedMs"] = ms
	}
	if ws, ok := chatRes["warmSession"].(bool); ok && ws {
		out["warmSession"] = true
	}
	return out
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
			if selection != "" {
				cleanedInstruction = "请结合语境解释或分析这段选中内容。"
			} else {
				cleanedInstruction = "请按照已启用的 Skill 规范，对这篇文章给出结构化诊断与具体改进建议。"
			}
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

	// 1. Ask AI / Q&A & Consultation mode (#148):
	// Answer general/conceptual questions directly instead of forcing full-article diagnosis,
	// and when a passage is selected, strictly scope context to that passage + narrow local window.
	if mode == "advise" {
		var sysPrompt string
		var userMsg strings.Builder
		var msgs []providers.ChatMessage
		sessionKey := strings.TrimSpace(req.SessionKey)

		if selection != "" {
			sysPrompt = strings.TrimSpace(`你是文章工作台的智能问答与写作助手。用户选中了文章中的一小段文字并向你提问。

规则（必须严格遵守）：
1. 优先直接、准确地回答用户的具体问题！
   - 如果用户问的是概念解释、术语含义、背景知识、对比或事实问题（例如「啥是矢量图」「SVG 和 PNG 区别」「这里提到的 XX 是什么意思」），直接用通俗清晰的语言解释清楚即可；可简短结合选中片段语境，绝对不要擅自跑去诊断整篇文章、点评全文结构或起标题！
   - 如果用户要求分析、挑刺、延伸或提建议，只围绕【选中片段】本身展开，不要偏题评论文章其他未选中的段落。
2. 【附近上下文】仅用于帮助你理解选区语境，不要把它当成诊断对象。
3. 直接输出清晰易读的 Markdown 正文，不要包裹 JSON。`)

			beforeCtx, afterCtx := extractSelectionContextWindow(content, selection, req.SelectionStart, req.SelectionEnd, 220)
			userMsg.WriteString("【用户问题】\n")
			userMsg.WriteString(cleanedInstruction)
			if title != "" {
				userMsg.WriteString("\n\n【文章标题（仅参考背景）】\n")
				userMsg.WriteString(title)
			}
			userMsg.WriteString("\n\n【选中片段】\n")
			userMsg.WriteString(selection)
			if beforeCtx != "" || afterCtx != "" {
				userMsg.WriteString("\n\n【附近上下文（仅帮助理解语境，不要诊断其他段落）】")
				if beforeCtx != "" {
					userMsg.WriteString("\n前文：")
					userMsg.WriteString(beforeCtx)
				}
				if afterCtx != "" {
					userMsg.WriteString("\n后文：")
					userMsg.WriteString(afterCtx)
				}
			}
			// Isolate selection Q&A from prior full-article history & warm full-article harness sessions (#148).
			msgs = []providers.ChatMessage{{Role: "user", Content: userMsg.String()}}
			sessionKey = ""
		} else {
			sysPrompt = strings.TrimSpace(`你是文章工作台的智能问答与写作助手。

规则（必须严格遵守）：
1. 先判断用户问题的真实意图，再决定回答方式：
   - 通用知识问答 / 概念解释 / 事实查证 / 举例启发（例如「啥是矢量图」「SVG 和 PNG 有什么区别」「帮我举个例子」）：请直接、通俗、准确地回答问题本身，绝对不要自作主张输出整篇文章诊断报告、改稿意见或起标题！
   - 文章诊断 / 起标题 / 结构点评 / 写作建议（当用户明确要求诊断文章、指出问题、起标题或给改稿建议时）：再紧扣文章原文，指出具体位置与问题原因，给出可执行的建议或编号方案。
2. 直接输出清晰易读的 Markdown 正文，不要包裹 JSON。`)

			userMsg.WriteString("【用户问题】\n")
			userMsg.WriteString(cleanedInstruction)
			if title != "" {
				userMsg.WriteString("\n\n【当前文章标题（按需参考）】\n")
				userMsg.WriteString(title)
			}
			if strings.TrimSpace(content) != "" {
				userMsg.WriteString("\n\n【当前文章正文（仅当问题涉及本文或用户明确要求诊断/起标题时参考；若用户只是问通用知识或概念问题，请直接回答问题本身，不要擅自诊断文章）】\n")
				userMsg.WriteString(content)
			}
			msgs = appendArticleHistory(nil, req.History)
			msgs = append(msgs, providers.ChatMessage{Role: "user", Content: userMsg.String()})
		}

		chatRes, err := s.executeHostChat(r.Context(), hostChatRequest{
			ModelRef:   strings.TrimSpace(req.TextModelRef),
			Scene:      "articleEdit",
			Capability: "text",
			System:     sysPrompt,
			SkillIDs:   activeIDs,
			Messages:   msgs,
			JSONMode:   false,
			SessionKey: sessionKey,
		})
		if err != nil {
			return nil, err
		}
		reply := strings.TrimSpace(asString(chatRes["text"]))
		if reply == "" {
			return nil, bad("AI 返回的回复为空，请重试或换个文本模型")
		}
		return attachChatMeta(map[string]any{
			"ok":         true,
			"mode":       "advise",
			"reply":      reply,
			"selection":  selection,
			"usedSkills": usedSkills,
		}, chatRes), nil
	}

	// 2. Surgical selection rewrite mode: modify ONLY the highlighted passage (#145).
	// Never dump the entire article or reuse warm full-article harness sessions/history,
	// otherwise models & writing skills frequently return the rewritten full article.
	if selection != "" {
		sysPrompt := strings.TrimSpace(`你是精准的中文文章局部润色编辑。用户只选中了文章中的一小段文字要求局部改写。

铁律（必须严格遵守，优先级高于一切 Skill 与惯例）：
1. 只改写【选中待改片段】本身，绝对禁止输出文章标题、前文、后文、其他段落或整篇文章！
2. 即使已启用的写作 Skill 提到「输出完整正文」或「全文润色」，本次任务也仅将该 Skill 的文风/规则作用于【选中待改片段】，replacement 字段必须只包含改写后的这一小段文字。
3. 保持与前后文语气、人称、事实一致，保留片段内原有的 Markdown 格式或配图链接（如有）。
4. 严格只输出一个 JSON 对象，不要包含额外解释，字段如下：
{
  "replacement": "仅包含改写后的局部片段文本（严禁夹带前文、后文或全文）",
  "summary": "1 句话简洁概括本次局部修改点"
}`)
		beforeCtx, afterCtx := extractSelectionContextWindow(content, selection, req.SelectionStart, req.SelectionEnd, 220)
		var userMsg strings.Builder
		userMsg.WriteString("【修改要求】\n")
		userMsg.WriteString(cleanedInstruction)
		if title != "" {
			userMsg.WriteString("\n\n【文章标题（仅参考语境，禁止输出）】\n")
			userMsg.WriteString(title)
		}
		if beforeCtx != "" {
			userMsg.WriteString("\n\n【前文摘录（仅用于衔接，严禁输出到 replacement）】\n")
			userMsg.WriteString(beforeCtx)
		}
		userMsg.WriteString("\n\n【选中待改片段】\n（只改写并输出这一段，严禁带入标题或前后文）\n")
		userMsg.WriteString(selection)
		if afterCtx != "" {
			userMsg.WriteString("\n\n【后文摘录（仅用于衔接，严禁输出到 replacement）】\n")
			userMsg.WriteString(afterCtx)
		}

		// Intentionally do NOT attach full-article History or warm SessionKey so the model
		// cannot drift back into full-article rewrite mode.
		msgs := []providers.ChatMessage{{Role: "user", Content: userMsg.String()}}

		chatRes, err := s.executeHostChatWithJSONFallback(r.Context(), hostChatRequest{
			ModelRef:   strings.TrimSpace(req.TextModelRef),
			Scene:      "articleEdit",
			Capability: "text",
			System:     sysPrompt,
			SkillIDs:   activeIDs,
			Messages:   msgs,
			JSONMode:   true,
			SessionKey: "",
		})
		if err != nil {
			return nil, err
		}
		rawReply, _ := chatRes["text"].(string)
		replacement, summary := parseArticleSelectionOutput(rawReply, selection, beforeCtx, afterCtx)
		if strings.TrimSpace(replacement) == "" {
			return nil, bad("AI 返回的局部改写结果为空，请重试或换个文本模型")
		}
		return attachChatMeta(map[string]any{
			"ok":          true,
			"mode":        "selection",
			"selection":   selection,
			"replacement": replacement,
			"summary":     summary,
			"usedSkills":  usedSkills,
		}, chatRes), nil
	}

	// 3. Smart article edit mode:
	// - Pure greeting/question -> fast conversational {"noEdit": true, "reply": "..."}
	// - Targeted edits -> fast incremental {"patches": [{"find": "...", "replace": "..."}]}
	// - Major rewrite -> {"title": "...", "content": "...", "summary": "..."}
	sysPrompt := strings.TrimSpace(`你是专业中文文章编辑与润色助手。请根据【用户要求】（以及启用的 Skill 规范）处理提供的 Markdown 文章，并严格只输出一个 JSON 对象，不要包含额外解释。

根据用户意图选择最轻量的返回格式：
A. 如果用户只是打招呼（如「你好」）、测试连通性或纯提问咨询，并未要求修改文章，请直接返回：
{
  "noEdit": true,
  "reply": "简短自然的中文回复"
}

B. 如果只需局部修改文章中的若干句子或段落（推荐，速度最快），请使用增量替换补丁（find 必须是原文中精确存在的连续片段）：
{
  "title": "修改后的主标题（不变可省略）",
  "patches": [
    { "find": "原文精确片段", "replace": "修改后的片段" }
  ],
  "summary": "1~2 句话概括修改点"
}

C. 如果需要对全文结构大幅重写或通篇润色，请返回完整正文：
{
  "title": "修改后的主标题（如无需修改则保持原标题）",
  "content": "修改后的完整 Markdown 正文",
  "summary": "1~2 句话简洁概括本次做了哪些修改"
}

要求：忠实保留原文核心事实、数据、专有名词与已有配图链接（如 ![...](assets/...)），除非用户明确要求删改。`)

	var userMsg strings.Builder
	userMsg.WriteString("【用户要求】\n")
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
		Scene:      "articleEdit",
		Capability: "text",
		System:     sysPrompt,
		SkillIDs:   activeIDs,
		Messages:   msgs,
		JSONMode:   true,
		SessionKey: strings.TrimSpace(req.SessionKey),
	})
	if err != nil {
		return nil, err
	}

	rawReply, _ := chatRes["text"].(string)
	parsed := parseArticleEditSmartOutput(rawReply, title, content)
	if parsed.noEdit && strings.TrimSpace(parsed.reply) != "" {
		return attachChatMeta(map[string]any{
			"ok":         true,
			"mode":       "advise",
			"reply":      strings.TrimSpace(parsed.reply),
			"usedSkills": usedSkills,
		}, chatRes), nil
	}
	if strings.TrimSpace(parsed.content) == "" {
		return nil, bad("AI 返回的修改结果为空，请重试或换个文本模型")
	}

	return attachChatMeta(map[string]any{
		"ok":         true,
		"mode":       "edit",
		"title":      parsed.title,
		"content":    parsed.content,
		"summary":    parsed.summary,
		"usedSkills": usedSkills,
	}, chatRes), nil
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

// extractSelectionContextWindow returns up to radius runes immediately before and
// after the selected passage in content so the model has local flow context without
// ever receiving the full article (#145).
func extractSelectionContextWindow(content, selection string, startHint, endHint, radius int) (before, after string) {
	if content == "" || selection == "" || radius <= 0 {
		return "", ""
	}
	runes := []rune(content)
	selRunes := []rune(selection)
	sIdx, eIdx := -1, -1

	// Prefer caller-provided rune or JS UTF-16 code-unit offsets when they align with selection.
	if startHint >= 0 && endHint > startHint {
		if endHint <= len(runes) && strings.TrimSpace(string(runes[startHint:endHint])) == selection {
			sIdx, eIdx = startHint, endHint
		} else if rs, re, ok := utf16RangeToRuneRange(runes, startHint, endHint); ok && strings.TrimSpace(string(runes[rs:re])) == selection {
			sIdx, eIdx = rs, re
		}
	}
	if sIdx < 0 {
		if byteIdx := strings.Index(content, selection); byteIdx >= 0 {
			sIdx = len([]rune(content[:byteIdx]))
			eIdx = sIdx + len(selRunes)
		}
	}
	if sIdx < 0 {
		return "", ""
	}
	bStart := sIdx - radius
	if bStart < 0 {
		bStart = 0
	}
	aEnd := eIdx + radius
	if aEnd > len(runes) {
		aEnd = len(runes)
	}
	before = strings.TrimSpace(string(runes[bStart:sIdx]))
	after = strings.TrimSpace(string(runes[eIdx:aEnd]))
	return before, after
}

func utf16RangeToRuneRange(runes []rune, startU16, endU16 int) (int, int, bool) {
	if startU16 < 0 || endU16 <= startU16 {
		return -1, -1, false
	}
	u16 := 0
	rs, re := -1, -1
	for i, r := range runes {
		if u16 == startU16 {
			rs = i
		}
		if r > 0xFFFF {
			u16 += 2
		} else {
			u16++
		}
		if u16 == endU16 {
			re = i + 1
			break
		}
	}
	if rs >= 0 && re > rs {
		return rs, re, true
	}
	return -1, -1, false
}

// stripEchoedSelectionContext trims unchanged surrounding context if a model
// accidentally echoed the beforeCtx/afterCtx excerpt around its rewritten passage.
func stripEchoedSelectionContext(rep, beforeCtx, afterCtx string) string {
	out := strings.TrimSpace(strings.ReplaceAll(rep, "\r\n", "\n"))
	if out == "" {
		return out
	}
	if b := strings.TrimSpace(beforeCtx); len([]rune(b)) >= 12 {
		if strings.HasPrefix(out, b) {
			trimmed := strings.TrimSpace(strings.TrimPrefix(out, b))
			if trimmed != "" {
				out = trimmed
			}
		} else {
			// Also handle echoing the last paragraph of beforeCtx.
			parts := strings.Split(b, "\n")
			lastLine := strings.TrimSpace(parts[len(parts)-1])
			if len([]rune(lastLine)) >= 12 && strings.HasPrefix(out, lastLine+"\n") {
				trimmed := strings.TrimSpace(strings.TrimPrefix(out, lastLine))
				if trimmed != "" {
					out = trimmed
				}
			}
		}
	}
	if a := strings.TrimSpace(afterCtx); len([]rune(a)) >= 12 {
		if strings.HasSuffix(out, a) {
			trimmed := strings.TrimSpace(strings.TrimSuffix(out, a))
			if trimmed != "" {
				out = trimmed
			}
		} else {
			parts := strings.Split(a, "\n")
			firstLine := strings.TrimSpace(parts[0])
			if len([]rune(firstLine)) >= 12 && strings.HasSuffix(out, "\n"+firstLine) {
				trimmed := strings.TrimSpace(strings.TrimSuffix(out, firstLine))
				if trimmed != "" {
					out = trimmed
				}
			}
		}
	}
	return out
}

func parseArticleSelectionOutput(raw, selection, beforeCtx, afterCtx string) (replacement, summary string) {
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
		rep := firstStr(parsed.Replacement, parsed.Text, parsed.Content)
		if strings.TrimSpace(rep) != "" {
			sum := strings.TrimSpace(parsed.Summary)
			if sum == "" {
				sum = "已完成局部片段改写"
			}
			return stripEchoedSelectionContext(rep, beforeCtx, afterCtx), sum
		}
	}
	return stripEchoedSelectionContext(trimmed, beforeCtx, afterCtx), "已完成局部片段改写"
}

type articleEditSmartResult struct {
	noEdit  bool
	reply   string
	title   string
	content string
	summary string
}

type articleEditPatch struct {
	Find    string `json:"find"`
	Replace string `json:"replace"`
}

func parseArticleEditSmartOutput(raw, fallbackTitle, originalContent string) articleEditSmartResult {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return articleEditSmartResult{title: fallbackTitle}
	}
	candidate := stripJSONCandidate(trimmed)
	var parsed struct {
		NoEdit  bool               `json:"noEdit"`
		Reply   string             `json:"reply"`
		Title   string             `json:"title"`
		Content string             `json:"content"`
		Patches []articleEditPatch `json:"patches"`
		Summary string             `json:"summary"`
	}
	if json.Unmarshal([]byte(candidate), &parsed) == nil {
		if parsed.NoEdit && strings.TrimSpace(parsed.Reply) != "" {
			return articleEditSmartResult{noEdit: true, reply: strings.TrimSpace(parsed.Reply)}
		}
		t := firstStr(strings.TrimSpace(parsed.Title), fallbackTitle)
		sum := firstStr(strings.TrimSpace(parsed.Summary), "已完成文章修改")
		if len(parsed.Patches) > 0 && strings.TrimSpace(originalContent) != "" {
			next := strings.ReplaceAll(originalContent, "\r\n", "\n")
			applied := 0
			for _, pt := range parsed.Patches {
				find := strings.ReplaceAll(pt.Find, "\r\n", "\n")
				rep := strings.ReplaceAll(pt.Replace, "\r\n", "\n")
				if find == "" {
					continue
				}
				if strings.Contains(next, find) {
					next = strings.Replace(next, find, rep, 1)
					applied++
				}
			}
			if applied > 0 {
				return articleEditSmartResult{title: t, content: next, summary: sum}
			}
		}
		if strings.TrimSpace(parsed.Content) != "" {
			return articleEditSmartResult{
				title:   t,
				content: strings.ReplaceAll(parsed.Content, "\r\n", "\n"),
				summary: sum,
			}
		}
		if strings.TrimSpace(parsed.Reply) != "" {
			return articleEditSmartResult{noEdit: true, reply: strings.TrimSpace(parsed.Reply)}
		}
	}
	t, c, s := parseArticleEditOutput(raw, fallbackTitle)
	return articleEditSmartResult{title: t, content: c, summary: s}
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
