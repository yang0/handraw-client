package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/yang0/handraw-client/internal/providers"
)

type articleEditRequest struct {
	Title        string   `json:"title"`
	Content      string   `json:"content"`
	Instruction  string   `json:"instruction"`
	SkillIDs     []string `json:"skillIds"`
	TextModelRef string   `json:"textModelRef"`
}

func (s *Server) articleEdit(w http.ResponseWriter, r *http.Request) (any, error) {
	var req articleEditRequest
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	instruction := strings.TrimSpace(req.Instruction)
	if instruction == "" {
		return nil, bad("请输入希望 AI 修改文章的具体要求")
	}
	content := strings.ReplaceAll(req.Content, "\r\n", "\n")
	title := strings.TrimSpace(req.Title)

	allSkills, _ := s.skillsManager().List()
	activeSkills, _, cleanedInstruction := resolveActiveSkills(allSkills, req.SkillIDs, instruction)
	if strings.TrimSpace(cleanedInstruction) == "" {
		cleanedInstruction = "请按照已启用的 Skill 规范优化并润色这篇 Markdown 文章。"
	}

	usedSkills := make([]map[string]string, 0, len(activeSkills))
	activeIDs := make([]string, 0, len(activeSkills))
	for _, sk := range activeSkills {
		usedSkills = append(usedSkills, map[string]string{"id": sk.ID, "name": sk.Name})
		activeIDs = append(activeIDs, sk.ID)
	}

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

	chatRes, err := s.executeHostChat(r.Context(), hostChatRequest{
		ModelRef:   strings.TrimSpace(req.TextModelRef),
		Capability: "text",
		System:     sysPrompt,
		SkillIDs:   activeIDs,
		Messages:   []providers.ChatMessage{{Role: "user", Content: userMsg.String()}},
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

func parseArticleEditOutput(raw, fallbackTitle string) (title, content, summary string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallbackTitle, "", ""
	}
	// Strip optional markdown code fences around JSON.
	candidate := trimmed
	if strings.HasPrefix(candidate, "```") {
		if idx := strings.IndexByte(candidate, '\n'); idx >= 0 {
			candidate = candidate[idx+1:]
		}
		if end := strings.LastIndex(candidate, "```"); end >= 0 {
			candidate = candidate[:end]
		}
		candidate = strings.TrimSpace(candidate)
	}
	// Also tolerate leading prose before '{' and trailing prose after '}'.
	if !strings.HasPrefix(candidate, "{") {
		if s := strings.IndexByte(candidate, '{'); s >= 0 {
			if e := strings.LastIndexByte(candidate, '}'); e > s {
				candidate = candidate[s : e+1]
			}
		}
	}
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
