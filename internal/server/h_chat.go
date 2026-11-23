package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"

	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/skills"
)

type chatHistoryMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatTurnRequest struct {
	SessionID     string               `json:"sessionId"`
	Messages      []chatHistoryMessage `json:"messages"`
	TextModelRef  string               `json:"textModelRef"`
	ImageModelRef string               `json:"imageModelRef"`
	SkillIDs      []string             `json:"skillIds"`
	Refs          []string             `json:"refs"`
	Resolution    string               `json:"resolution"`
	Ratio         string               `json:"ratio"`
	Confirmed     bool                 `json:"confirmed"`
}

type chatToolTrace struct {
	Name    string `json:"name"`
	Label   string `json:"label"`
	Summary string `json:"summary"`
	OK      bool   `json:"ok"`
}

type chatTurnResponse struct {
	OK             bool                  `json:"ok"`
	Reply          string                `json:"reply"`
	Source         string                `json:"source"`
	TextModel      string                `json:"textModel"`
	ImageModel     string                `json:"imageModel"`
	UsedSkills     []map[string]string   `json:"usedSkills"`
	ToolCalls      []chatToolTrace       `json:"toolCalls"`
	Runs           []any                 `json:"runs"`
	Usage          *providers.TokenUsage `json:"usage,omitempty"`
	PendingConfirm map[string]any        `json:"pendingConfirm,omitempty"`
	SkillsChanged  bool                  `json:"skillsChanged"`
	PluginsChanged bool                  `json:"pluginsChanged"`
}

var chatToolLabels = map[string]string{
	"search_resources":      "检索本地画风与图型库",
	"generate_images":       "提交生图任务",
	"list_skills":           "查看已安装 Skill",
	"install_skill":         "安装 Skill",
	"update_skill":          "更新 Skill",
	"remove_skill":          "卸载 Skill",
	"list_plugins":          "查看已安装插件",
	"search_market_plugins": "搜索插件市场",
	"install_plugin":        "安装插件",
}

func (s *Server) chatTurn(w http.ResponseWriter, r *http.Request) (any, error) {
	var req chatTurnRequest
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if len(req.Messages) == 0 {
		return nil, bad("请输入要发送的内容")
	}

	st := settings.Get()
	imageModelRef := strings.TrimSpace(req.ImageModelRef)
	if imageModelRef == "" {
		imageModelRef = strings.TrimSpace(st.DefaultModel)
	}
	// Keep empty when caller doesn't force a resolution so site models automatically
	// resolve to their first verified specification (e.g. 1k for gpt-image-2.5) (#61).
	resolution := strings.TrimSpace(req.Resolution)
	defaultRatio := firstStr(strings.TrimSpace(req.Ratio), "3:4")

	// Locate last user message & detect explicit /skill-id invocation.
	lastUserIdx := -1
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			lastUserIdx = i
			break
		}
	}
	if lastUserIdx < 0 || strings.TrimSpace(req.Messages[lastUserIdx].Content) == "" {
		return nil, bad("请输入要发送的内容")
	}
	lastUserText := strings.TrimSpace(req.Messages[lastUserIdx].Content)

	allSkills, _ := s.skillsManager().List()
	activeSkills, invokedSkillID, cleanedUserText := resolveActiveSkills(allSkills, req.SkillIDs, lastUserText)

	usedSkills := make([]map[string]string, 0, len(activeSkills))
	for _, sk := range activeSkills {
		usedSkills = append(usedSkills, map[string]string{"id": sk.ID, "name": sk.Name})
	}

	resp := &chatTurnResponse{
		OK:         true,
		ImageModel: imageModelRef,
		UsedSkills: usedSkills,
		ToolCalls:  []chatToolTrace{},
		Runs:       []any{},
	}

	// Quick direct slash commands work in both online and offline modes.
	if handled, err := s.handleChatSlashCommand(r.Context(), lastUserText, resp); handled {
		if err != nil {
			return nil, err
		}
		resp.Source = "local"
		return resp, nil
	}

	route, err := resolveAIRoute("text", req.TextModelRef)
	if err != nil {
		return nil, err
	}

	var tp settings.Provider
	var textModel string
	useSiteAI := false
	hasTextProvider := false
	switch route.Mode {
	case "provider":
		tp, textModel, hasTextProvider = route.Provider, route.Model, true
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		useSiteAI = true
	default:
		if s.Site.LoggedIn() {
			useSiteAI = true
		} else if p, m, ok := findTextProviderFor("text"); ok {
			tp, textModel, hasTextProvider = p, m, true
		}
	}

	execCtx := &chatExecContext{
		srv:           s,
		imageModelRef: imageModelRef,
		resolution:    resolution,
		defaultRatio:  defaultRatio,
		refs:          req.Refs,
		confirmed:     req.Confirmed,
		resp:          resp,
	}

	if useSiteAI || hasTextProvider {
		if useSiteAI {
			resp.Source = "site"
			resp.TextModel = "site:text"
		} else {
			resp.Source = "provider"
			resp.TextModel = tp.ID + ":" + textModel
		}
		p, _ := s.pack()
		sysPrompt := buildChatSystemPrompt(p, activeSkills, invokedSkillID)
		msgs := make([]providers.ChatMessage, 0, len(req.Messages)+2)
		msgs = append(msgs, providers.ChatMessage{Role: "system", Content: sysPrompt})

		start := 0
		if len(req.Messages) > 20 {
			start = len(req.Messages) - 20
		}
		for i := start; i < len(req.Messages); i++ {
			m := req.Messages[i]
			role := strings.TrimSpace(m.Role)
			content := strings.TrimSpace(m.Content)
			if content == "" || (role != "user" && role != "assistant") {
				continue
			}
			if i == lastUserIdx {
				if cleanedUserText != "" {
					content = cleanedUserText
				}
				// Append volatile per-turn hints only to the latest user message so the
				// static system prefix and prior history remain byte-identical for prompt caching (#61).
				var hints []string
				if defaultRatio != "" && defaultRatio != "3:4" {
					hints = append(hints, "默认比例 "+defaultRatio)
				}
				if len(req.Refs) > 0 {
					hints = append(hints, fmt.Sprintf("附带参考图 %d 张", len(req.Refs)))
				}
				if len(hints) > 0 {
					content += "\n\n[" + strings.Join(hints, "，") + "]"
				}
			}
			msgs = append(msgs, providers.ChatMessage{Role: role, Content: content})
		}

		tools := chatAgentToolDefs()
		cacheKey := "handraw-chat:" + firstStr(strings.TrimSpace(req.SessionID), "default")
		addUsage := func(u *providers.TokenUsage) {
			if u == nil {
				return
			}
			if resp.Usage == nil {
				resp.Usage = &providers.TokenUsage{}
			}
			resp.Usage.InputTokens += u.InputTokens
			resp.Usage.OutputTokens += u.OutputTokens
			resp.Usage.CacheReadTokens += u.CacheReadTokens
			resp.Usage.CacheWriteTokens += u.CacheWriteTokens
			resp.Usage.TotalTokens += u.TotalTokens
		}

		for step := 0; step < 6; step++ {
			var turnRes providers.ChatTurnResult
			var turnErr error
			if useSiteAI {
				siteRes, err := s.Site.AIChat(r.Context(), site.AIChatRequest{
					Capability:   "text",
					Messages:     msgs,
					Tools:        tools,
					ToolChoice:   "auto",
					FeatureScope: "client_chat",
				})
				turnErr = err
				if err == nil {
					turnRes.Content = siteRes.Content
					turnRes.Usage = providers.ExtractTokenUsage(siteRes.Usage)
					for _, tc := range siteRes.ToolCalls {
						var ptc providers.ToolCall
						ptc.ID = tc.ID
						ptc.Type = tc.Type
						ptc.Function.Name = tc.Function.Name
						ptc.Function.Arguments = tc.Function.Arguments
						turnRes.ToolCalls = append(turnRes.ToolCalls, ptc)
					}
				}
			} else {
				turnRes, turnErr = providers.ChatWithToolsCached(r.Context(), tp, textModel, msgs, tools, cacheKey)
			}
			if turnErr != nil {
				return nil, turnErr
			}
			addUsage(turnRes.Usage)
			if len(turnRes.ToolCalls) == 0 {
				resp.Reply = strings.TrimSpace(turnRes.Content)
				if resp.Reply == "" && len(resp.Runs) > 0 {
					resp.Reply = "已按你的要求提交生图任务，图像完成后会在下方自动显影。"
				}
				s.refreshChatRuns(resp)
				return resp, nil
			}
			msgs = append(msgs, providers.ChatMessage{
				Role:      "assistant",
				Content:   turnRes.Content,
				ToolCalls: turnRes.ToolCalls,
			})
			for _, tc := range turnRes.ToolCalls {
				toolOut, trace := execCtx.runTool(r.Context(), tc.Function.Name, tc.Function.Arguments)
				resp.ToolCalls = append(resp.ToolCalls, trace)
				msgs = append(msgs, providers.ChatMessage{
					Role:       "tool",
					ToolCallID: tc.ID,
					Name:       tc.Function.Name,
					Content:    toolOut,
				})
			}
		}
		if resp.Reply == "" {
			resp.Reply = "已完成相关操作，请查看上方执行结果。"
		}
		s.refreshChatRuns(resp)
		return resp, nil
	}

	// Fallback when no third-party OpenAI text model is configured:
	// still support direct skill install, plugin search/install, and chat-to-draw!
	resp.Source = "local"
	resp.TextModel = "site:auto"
	out, err := s.handleChatWithoutTextProvider(r.Context(), cleanedUserText, execCtx)
	if err == nil && out != nil {
		s.refreshChatRuns(out)
	}
	return out, err
}

func (s *Server) refreshChatRuns(resp *chatTurnResponse) {
	if resp == nil || len(resp.Runs) == 0 || s.DB == nil {
		return
	}
	for i, rObj := range resp.Runs {
		b, err := json.Marshal(rObj)
		if err != nil {
			continue
		}
		var meta struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(b, &meta) == nil && meta.ID != "" {
			if fresh, err := s.DB.GetRun(meta.ID); err == nil && fresh.ID != "" {
				resp.Runs[i] = fresh
			}
		}
	}
}

func resolveActiveSkills(all []skills.Skill, explicitIDs []string, userText string) ([]skills.Skill, string, string) {
	byID := map[string]skills.Skill{}
	for _, sk := range all {
		byID[sk.ID] = sk
	}

	invokedID := ""
	cleaned := userText
	if strings.HasPrefix(userText, "/") {
		fields := strings.SplitN(userText[1:], " ", 2)
		cand := skills.SanitizeID(fields[0])
		if _, ok := byID[cand]; ok {
			invokedID = cand
			if len(fields) > 1 && strings.TrimSpace(fields[1]) != "" {
				cleaned = strings.TrimSpace(fields[1])
			} else {
				cleaned = "请按技能「" + byID[cand].Name + "」的规范开始协助我。"
			}
		}
	}

	seen := map[string]bool{}
	var active []skills.Skill
	add := func(id string) {
		id = skills.SanitizeID(id)
		if id == "" || seen[id] {
			return
		}
		if sk, ok := byID[id]; ok {
			seen[id] = true
			active = append(active, sk)
		}
	}

	if invokedID != "" {
		add(invokedID)
	}
	if explicitIDs != nil {
		for _, id := range explicitIDs {
			add(id)
		}
	} else {
		for _, sk := range all {
			if sk.Enabled {
				add(sk.ID)
			}
		}
	}
	if len(active) > 6 {
		active = active[:6]
	}
	return active, invokedID, cleaned
}

func buildCompactCatalogBlock(p *resources.Pack) string {
	if p == nil {
		return ""
	}
	var sections []string
	if len(p.Styles) > 0 {
		items := append([]resources.Style(nil), p.Styles...)
		sort.Slice(items, func(i, j int) bool { return items[i].Number < items[j].Number })
		parts := make([]string, 0, len(items))
		for _, st := range items {
			nm := firstStr(st.NameZh, st.GenerationName)
			nm = strings.ReplaceAll(strings.TrimSpace(nm), "|", " ")
			if len([]rune(nm)) > 24 {
				nm = string([]rune(nm)[:24])
			}
			parts = append(parts, st.Number+":"+nm)
		}
		sections = append(sections, "可选画风编号（generate_images 的 style 必须从此目录挑选）：\n"+strings.Join(parts, "|"))
	}
	if len(p.Layouts) > 0 {
		items := append([]resources.Layout(nil), p.Layouts...)
		sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
		parts := make([]string, 0, len(items))
		for _, l := range items {
			nm := strings.ReplaceAll(strings.TrimSpace(l.Name), "|", " ")
			if len([]rune(nm)) > 18 {
				nm = string([]rune(nm)[:18])
			}
			parts = append(parts, l.ID+":"+nm)
		}
		sections = append(sections, "可选图型编号（layout，纯意境自由构图或纯图模式可留空）：\n"+strings.Join(parts, "|"))
	}
	if len(p.Colors) > 0 {
		items := append([]resources.Color(nil), p.Colors...)
		sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
		parts := make([]string, 0, len(items))
		for _, c := range items {
			nm := strings.ReplaceAll(strings.TrimSpace(c.NameZh), "|", " ")
			if len([]rune(nm)) > 12 {
				nm = string([]rune(nm)[:12])
			}
			parts = append(parts, c.ID+":"+nm)
		}
		sections = append(sections, "可选主题色编号（color，可选）：\n"+strings.Join(parts, "|"))
	}
	if len(p.Tones) > 0 {
		items := append([]resources.Tone(nil), p.Tones...)
		sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
		parts := make([]string, 0, len(items))
		for _, t := range items {
			nm := strings.ReplaceAll(strings.TrimSpace(t.NameZh), "|", " ")
			if len([]rune(nm)) > 12 {
				nm = string([]rune(nm)[:12])
			}
			parts = append(parts, t.ID+":"+nm)
		}
		sections = append(sections, "可选影调编号：\n"+strings.Join(parts, "|"))
	}
	return strings.Join(sections, "\n\n")
}

// buildChatSystemPrompt keeps the static rules and sorted Handraw resource catalog
// byte-identical at the start of the system message to maximize upstream relay
// Prompt Cache hit rates across turns and tool-call steps (#61).
func buildChatSystemPrompt(p *resources.Pack, activeSkills []skills.Skill, invokedID string) string {
	var sb strings.Builder
	sb.WriteString(`你是「手绘风」桌面工作台的 AI 会话助手，类似 Codex / DSH 的对话式智能工作台。
你可以：
1. 与用户自然聊天、讨论选题、润色文案、编写提示词或回答问题。
2. 当用户明确想画图、生图、出系列图/海报/配图时，直接从下方内置的手绘风目录挑选合适编号，一步调用 generate_images 提交生图任务（支持单图和最多 12 张多图），无需让用户手动切换页面。
3. 当用户想安装、创建、查看或卸载 Skill 时，主动调用 list_skills / install_skill / remove_skill 工具完成。
4. 当用户想查找或安装插件时，主动调用 list_plugins / search_market_plugins / install_plugin 工具完成。

重要约定：
- 如果用户只是普通聊天、问问题或探讨方案，直接文字回复，不要误调用生图工具。
- 生图时请优先直接从下方目录选定 style / layout / color 编号并立即调用 generate_images；不要反复调用 search_resources（仅在确需查某画风特征细节时最多调用 1-2 次）。
- 默认比例为 3:4（除非用户在消息中另有要求或指明海报 9:16 / 横版等）。
- 用户以中文提出需求且未明确要求英文或双语时，海报/图文模式的 items[].text 必须全部使用简体中文文案（不要擅自在主标题前加英文大字）；海报/社媒卡模式务必把需要呈现在画面中的中文文案完整填入 items[].text。
- 回复简洁清晰，使用中文 Markdown 排版。`)

	if catalog := buildCompactCatalogBlock(p); catalog != "" {
		sb.WriteString("\n\n## Handraw 本地视觉资源目录（直接选编号即可）\n\n")
		sb.WriteString(catalog)
	}

	if len(activeSkills) > 0 {
		sorted := append([]skills.Skill(nil), activeSkills...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
		sb.WriteString("\n\n## 当前会话已启用的 Skills\n")
		if invokedID != "" {
			sb.WriteString(fmt.Sprintf("注意：用户本次消息通过 `/%s` 显式调用了该 Skill，请优先严格遵循其指令。\n", invokedID))
		}
		for _, sk := range sorted {
			body := strings.TrimSpace(sk.Body)
			runes := []rune(body)
			limit := 2600
			if sk.Builtin || sk.ID == skills.BuiltinHandrawSkillID {
				limit = 6000
			}
			if len(runes) > limit {
				body = string(runes[:limit]) + "\n...(已截断)"
			}
			sb.WriteString(fmt.Sprintf("\n### Skill: %s (id: %s)\n", sk.Name, sk.ID))
			if sk.Description != "" {
				sb.WriteString("简介：" + sk.Description + "\n")
			}
			sb.WriteString(body + "\n")
		}
	}
	return sb.String()
}

func chatAgentToolDefs() []providers.ToolDef {
	return []providers.ToolDef{
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "search_resources",
				Description: "搜索本地手绘风资源包中的画风(styles)、图型(layouts)、主题色(colors)或影调(tones)，返回编号和中文名称。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"kind":  map[string]any{"type": "string", "enum": []string{"styles", "layouts", "colors", "tones"}},
						"query": map[string]any{"type": "string", "description": "搜索关键词，可留空返回热门示例"},
						"limit": map[string]any{"type": "integer", "description": "返回条数，默认 10"},
					},
					"required": []string{"kind"},
				},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "generate_images",
				Description: "使用用户当前选择的生图模型提交单张或多张（最多12张）手绘风生图任务。图像会在聊天界面实时显影。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"title": map[string]any{"type": "string", "description": "本次创作简短标题"},
						"mode":  map[string]any{"type": "string", "enum": []string{"graphic-text", "pure-image", "poster"}},
						"ratio": map[string]any{"type": "string", "description": "默认画面比例，如 3:4、1:1、4:3、16:9、9:16"},
						"items": map[string]any{
							"type":        "array",
							"description": "要生成的画面列表（1~12 张）",
							"items": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"theme":  map[string]any{"type": "string", "description": "具体生动的画面主体与场景描述"},
									"style":  map[string]any{"type": "string", "description": "画风编号，如 FA-013"},
									"style2": map[string]any{"type": "string", "description": "可选第二画风编号"},
									"layout": map[string]any{"type": "string", "description": "可选图型编号，如 SC-001"},
									"color":  map[string]any{"type": "string", "description": "可选主题色编号"},
									"ratio":  map[string]any{"type": "string", "description": "单张比例，可省略继承默认"},
									"text":   map[string]any{"type": "string", "description": "图文/海报模式下画面内必现文字；中文需求下默认全部使用简体中文文案，不要擅自添加英文主标题"},
									"mode":   map[string]any{"type": "string", "enum": []string{"graphic-text", "pure-image", "poster"}},
								},
								"required": []string{"theme"},
							},
						},
					},
					"required": []string{"items"},
				},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "list_skills",
				Description: "列出用户当前已安装的自定义 Skills。",
				Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "install_skill",
				Description: "安装一个 Skill。可传入本地路径/目录/zip/HTTP或GitHub链接(source)，也可直接由 AI 编写 SKILL.md 内容(name/description/content)并安装。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"source":      map[string]any{"type": "string", "description": "本地目录、.md/.zip 文件路径，或 HTTP/HTTPS/GitHub 链接"},
						"id":          map[string]any{"type": "string", "description": "可选 Skill ID（英文字母数字短横线）"},
						"name":        map[string]any{"type": "string", "description": "直接创建时的 Skill 名称"},
						"description": map[string]any{"type": "string", "description": "直接创建时的简短说明"},
						"content":     map[string]any{"type": "string", "description": "直接创建时的 SKILL.md Markdown 指令正文"},
					},
				},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "update_skill",
				Description: "免重启在线动态更新内置官方手绘 Skill（默认 id 为 handraw-skill）或其他支持远端同步的 Skill。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id": map[string]any{"type": "string", "description": "要更新的 Skill ID，留空则默认更新内置官方手绘skill (handraw-skill)"},
					},
				},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "remove_skill",
				Description: "卸载指定 ID 的自定义 Skill。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id": map[string]any{"type": "string", "description": "要卸载的 Skill ID"},
					},
					"required": []string{"id"},
				},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "list_plugins",
				Description: "列出当前已安装的内置与社区插件及其启用状态。",
				Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "search_market_plugins",
				Description: "搜索官方及已配置插件市场中的可用插件。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{"type": "string", "description": "搜索关键词，留空返回推荐列表"},
					},
				},
			},
		},
		{
			Type: "function",
			Function: providers.ToolFunctionDef{
				Name:        "install_plugin",
				Description: "从插件市场（传 marketName）或直接从地址/本地路径（传 source）安装插件并默认启用。",
				Parameters: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"marketName": map[string]any{"type": "string", "description": "插件市场中的插件名称（name）"},
						"sourceId":   map[string]any{"type": "string", "description": "可选市场源 ID"},
						"source":     map[string]any{"type": "string", "description": "直接安装时的 Git URL / zip URL / 本地路径"},
						"enable":     map[string]any{"type": "boolean", "description": "安装后是否立即启用，默认 true"},
					},
				},
			},
		},
	}
}

type chatExecContext struct {
	srv           *Server
	imageModelRef string
	resolution    string
	defaultRatio  string
	refs          []string
	confirmed     bool
	resp          *chatTurnResponse
}

func (c *chatExecContext) runTool(ctx context.Context, name, rawArgs string) (string, chatToolTrace) {
	label := chatToolLabels[name]
	if label == "" {
		label = name
	}
	fail := func(msg string) (string, chatToolTrace) {
		b, _ := json.Marshal(map[string]any{"ok": false, "error": msg})
		return string(b), chatToolTrace{Name: name, Label: label, Summary: msg, OK: false}
	}
	okOut := func(summary string, payload any) (string, chatToolTrace) {
		b, _ := json.Marshal(payload)
		return string(b), chatToolTrace{Name: name, Label: label, Summary: summary, OK: true}
	}

	switch name {
	case "search_resources":
		var args struct {
			Kind  string `json:"kind"`
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		_ = json.Unmarshal([]byte(rawArgs), &args)
		if args.Limit <= 0 || args.Limit > 20 {
			args.Limit = 10
		}
		p, err := c.srv.pack()
		if err != nil {
			return fail(err.Error())
		}
		tokens := tokenizeSearchQuery(args.Query)
		type scoredHit struct {
			score int
			item  map[string]string
		}
		var scored []scoredHit
		var fallback []map[string]string
		scoreText := func(hay string) int {
			if len(tokens) == 0 {
				return 1
			}
			low := strings.ToLower(hay)
			sc := 0
			for _, tok := range tokens {
				if strings.Contains(low, tok) {
					sc++
				}
			}
			return sc
		}
		switch strings.ToLower(args.Kind) {
		case "layouts":
			for _, l := range p.Layouts {
				m := map[string]string{"id": l.ID, "name": l.Name, "category": l.Category}
				if len(fallback) < args.Limit {
					fallback = append(fallback, m)
				}
				if sc := scoreText(l.ID + " " + l.Name + " " + l.Category + " " + strings.Join(l.Keywords, " ")); sc > 0 {
					scored = append(scored, scoredHit{score: sc, item: m})
				}
			}
		case "colors":
			for _, col := range p.Colors {
				m := map[string]string{"id": col.ID, "name": col.NameZh, "category": col.CategoryZh}
				if len(fallback) < args.Limit {
					fallback = append(fallback, m)
				}
				if sc := scoreText(col.ID + " " + col.NameZh + " " + col.CategoryZh + " " + col.QuoteZh); sc > 0 {
					scored = append(scored, scoredHit{score: sc, item: m})
				}
			}
		case "tones":
			for _, tn := range p.Tones {
				m := map[string]string{"id": tn.ID, "name": tn.NameZh}
				if len(fallback) < args.Limit {
					fallback = append(fallback, m)
				}
				if sc := scoreText(tn.ID + " " + tn.NameZh + " " + tn.DescZh); sc > 0 {
					scored = append(scored, scoredHit{score: sc, item: m})
				}
			}
		default:
			for _, st := range p.Styles {
				m := map[string]string{
					"id":     st.Number,
					"name":   firstStr(st.NameZh, st.GenerationName),
					"traits": firstNRunes(st.Traits, 50),
				}
				if len(fallback) < args.Limit {
					fallback = append(fallback, m)
				}
				if sc := scoreText(st.Number + " " + st.NameZh + " " + st.GenerationName + " " + st.Traits + " " + st.GroupZh); sc > 0 {
					scored = append(scored, scoredHit{score: sc, item: m})
				}
			}
		}
		sort.SliceStable(scored, func(i, j int) bool { return scored[i].score > scored[j].score })
		hits := make([]map[string]string, 0, args.Limit)
		for _, sh := range scored {
			hits = append(hits, sh.item)
			if len(hits) >= args.Limit {
				break
			}
		}
		note := ""
		if len(hits) == 0 && len(fallback) > 0 {
			hits = fallback
			note = "未精确命中关键词，已返回常用候选，可直接选用编号并调用 generate_images"
		}
		return okOut(fmt.Sprintf("找到 %d 条 %s 资源", len(hits), firstStr(args.Kind, "styles")), map[string]any{"ok": true, "items": hits, "note": note})

	case "generate_images":
		var args struct {
			Title string `json:"title"`
			Mode  string `json:"mode"`
			Ratio string `json:"ratio"`
			Items []struct {
				Theme  string `json:"theme"`
				Style  string `json:"style"`
				Style2 string `json:"style2"`
				Layout string `json:"layout"`
				Color  string `json:"color"`
				Ratio  string `json:"ratio"`
				Text   string `json:"text"`
				Mode   string `json:"mode"`
			} `json:"items"`
		}
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil || len(args.Items) == 0 {
			return fail("缺少生图 items 参数")
		}
		if len(args.Items) > 12 {
			args.Items = args.Items[:12]
		}
		p, _ := c.srv.pack()
		defStyle := "FA-013"
		if p != nil {
			defStyle = defaultPackStyle(p).Number
		}
		baseMode := normalizeChatMode(args.Mode)
		baseRatio := normalizeChatRatio(args.Ratio, c.defaultRatio)
		genItems := make([]map[string]any, 0, len(args.Items))
		for _, it := range args.Items {
			m := baseMode
			if strings.TrimSpace(it.Mode) != "" {
				m = normalizeChatMode(it.Mode)
			}
			stID := strings.TrimSpace(it.Style)
			if p != nil && stID != "" {
				if found, ok := p.Style(stID); ok {
					stID = found.Number
				} else {
					stID = defStyle
				}
			}
			if stID == "" {
				stID = defStyle
			}
			layID := strings.TrimSpace(it.Layout)
			if m == "pure-image" {
				layID = ""
			} else if p != nil && layID != "" {
				if found, ok := p.Layout(layID); ok {
					layID = found.ID
				} else {
					layID = ""
				}
			}
			genItems = append(genItems, map[string]any{
				"theme":  strings.TrimSpace(it.Theme),
				"style":  stID,
				"style2": strings.TrimSpace(it.Style2),
				"layout": layID,
				"color":  strings.TrimSpace(it.Color),
				"ratio":  normalizeChatRatio(it.Ratio, baseRatio),
				"text":   strings.TrimSpace(it.Text),
				"mode":   m,
			})
		}
		runMode := "single"
		if len(genItems) > 1 {
			runMode = "series"
		}
		payload := map[string]any{
			"mode":       runMode,
			"title":      firstStr(strings.TrimSpace(args.Title), firstNRunes(args.Items[0].Theme, 24), "会话生图"),
			"modelRef":   c.imageModelRef,
			"resolution": c.resolution,
			"quality":    "standard",
			"confirmed":  c.confirmed,
			"refs":       c.refs,
			"items":      genItems,
			"recipe": map[string]any{
				"styleIds": []string{fmt.Sprint(genItems[0]["style"])},
				"ratio":    baseRatio,
				"mode":     baseMode,
			},
		}
		res, err := c.srv.invokeLocalJSON(ctx, c.srv.generate, payload)
		if err != nil {
			return fail(err.Error())
		}
		m, _ := res.(map[string]any)
		if need, _ := m["needConfirm"].(bool); need {
			c.resp.PendingConfirm = m
			return okOut(fmt.Sprintf("预计生成 %v 张，需费用二次确认", m["count"]), m)
		}
		if runObj, ok := m["run"]; ok && runObj != nil {
			c.resp.Runs = append(c.resp.Runs, runObj)
		}
		return okOut(fmt.Sprintf("已提交 %d 张生图任务（模型 %s）", len(genItems), firstStr(c.imageModelRef, "默认")), map[string]any{
			"ok":    true,
			"count": len(genItems),
			"run":   m["run"],
		})

	case "list_skills":
		items, err := c.srv.skillsManager().List()
		if err != nil {
			return fail(err.Error())
		}
		brief := make([]map[string]any, 0, len(items))
		for _, sk := range items {
			brief = append(brief, map[string]any{
				"id":              sk.ID,
				"name":            sk.Name,
				"description":     sk.Description,
				"enabled":         sk.Enabled,
				"builtin":         sk.Builtin,
				"version":         sk.Version,
				"latestVersion":   sk.LatestVersion,
				"updateAvailable": sk.UpdateAvailable,
				"updatable":       sk.Updatable,
				"source":          sk.Source,
			})
		}
		return okOut(fmt.Sprintf("共 %d 个已安装 Skill", len(brief)), map[string]any{"ok": true, "items": brief})

	case "update_skill":
		var args struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(rawArgs), &args)
		id := strings.TrimSpace(args.ID)
		if id == "" {
			id = skills.BuiltinHandrawSkillID
		}
		sk, changed, err := c.srv.skillsManager().Update(ctx, id)
		if err != nil {
			return fail(err.Error())
		}
		c.resp.SkillsChanged = true
		c.srv.Emit("skills", map[string]any{"updated": true, "changed": changed, "id": sk.ID, "version": sk.Version})
		msg := fmt.Sprintf("Skill「%s」已是最新版本 %s", sk.Name, sk.Version)
		if changed {
			msg = fmt.Sprintf("已热更新 Skill「%s」至 %s（免重启生效）", sk.Name, sk.Version)
		}
		return okOut(msg, map[string]any{
			"ok":      true,
			"updated": changed,
			"id":      sk.ID,
			"name":    sk.Name,
			"version": sk.Version,
		})

	case "install_skill":
		var args struct {
			Source      string `json:"source"`
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Content     string `json:"content"`
		}
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
			return fail("install_skill 参数无效")
		}
		mgr := c.srv.skillsManager()
		var (
			sk  skills.Skill
			err error
		)
		if strings.TrimSpace(args.Source) != "" {
			sk, err = mgr.InstallFromSource(ctx, args.Source)
		} else {
			sk, err = mgr.InstallInline(args.ID, args.Name, args.Description, args.Content, "chat")
		}
		if err != nil {
			return fail(err.Error())
		}
		c.resp.SkillsChanged = true
		c.srv.Emit("skills", map[string]any{"updated": true, "id": sk.ID})
		return okOut(fmt.Sprintf("已安装 Skill「%s」(%s)", sk.Name, sk.ID), map[string]any{
			"ok":          true,
			"id":          sk.ID,
			"name":        sk.Name,
			"description": sk.Description,
			"enabled":     sk.Enabled,
		})

	case "remove_skill":
		var args struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(rawArgs), &args)
		if err := c.srv.skillsManager().Remove(args.ID); err != nil {
			return fail(err.Error())
		}
		c.resp.SkillsChanged = true
		c.srv.Emit("skills", map[string]any{"updated": true, "removed": args.ID})
		return okOut("已卸载 Skill: "+args.ID, map[string]any{"ok": true, "removed": args.ID})

	case "list_plugins":
		out := map[string]any{
			"ok":        true,
			"builtin":   c.srv.Plugins.States(),
			"community": c.srv.Plugins.ListCommunity(c.srv.enabledPlugins()),
		}
		return okOut("已获取插件列表", out)

	case "search_market_plugins":
		var args struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal([]byte(rawArgs), &args)
		req, _ := http.NewRequestWithContext(ctx, "GET", "/api/plugins/market", nil)
		raw, err := c.srv.pluginMarketList(httptest.NewRecorder(), req)
		if err != nil {
			return fail(err.Error())
		}
		m, _ := raw.(map[string]any)
		allPlugs, _ := m["plugins"].([]marketViewPlugin)
		q := strings.ToLower(strings.TrimSpace(args.Query))
		var hits []map[string]any
		for _, pl := range allPlugs {
			if q != "" && !strings.Contains(strings.ToLower(pl.Name+" "+pl.Title+" "+pl.Description+" "+strings.Join(pl.Categories, " ")), q) {
				continue
			}
			hits = append(hits, map[string]any{
				"name":          pl.Name,
				"title":         pl.Title,
				"description":   pl.Description,
				"sourceId":      pl.SourceID,
				"latestVersion": pl.LatestVersion,
				"installed":     pl.Installed,
				"enabled":       pl.Enabled,
			})
			if len(hits) >= 12 {
				break
			}
		}
		return okOut(fmt.Sprintf("插件市场匹配到 %d 个插件", len(hits)), map[string]any{"ok": true, "plugins": hits, "errors": m["errors"]})

	case "install_plugin":
		var args struct {
			MarketName string `json:"marketName"`
			SourceID   string `json:"sourceId"`
			Source     string `json:"source"`
			Enable     *bool  `json:"enable"`
		}
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
			return fail("install_plugin 参数无效")
		}
		enable := args.Enable == nil || *args.Enable
		if strings.TrimSpace(args.MarketName) != "" {
			res, err := c.srv.invokeLocalJSON(ctx, c.srv.pluginMarketInstall, map[string]any{
				"sourceId": strings.TrimSpace(args.SourceID),
				"name":     strings.TrimSpace(args.MarketName),
				"enable":   enable,
			})
			if err != nil {
				return fail(err.Error())
			}
			c.resp.PluginsChanged = true
			return okOut("已从插件市场安装插件："+args.MarketName, map[string]any{"ok": true, "result": res})
		}
		if strings.TrimSpace(args.Source) != "" {
			plug, err := c.srv.Plugins.Install(ctx, strings.TrimSpace(args.Source))
			if err != nil {
				return fail(err.Error())
			}
			if enable {
				_, _ = settings.Update(func(st *settings.Settings) error {
					if st.Plugins == nil {
						st.Plugins = map[string]bool{}
					}
					st.Plugins["community:"+plug.ID] = true
					return nil
				})
				plug.Enabled = true
				if plug.Kind == "dsh" && c.srv.DSH != nil {
					_ = c.srv.SyncDSH(ctx)
				}
			}
			c.srv.Emit("plugins", c.srv.Plugins.States())
			c.resp.PluginsChanged = true
			return okOut(fmt.Sprintf("已安装插件「%s」(%s)", firstStr(plug.Name, plug.ID), plug.ID), map[string]any{"ok": true, "plugin": plug})
		}
		return fail("请提供 marketName 或 source")

	default:
		return fail("未知工具：" + name)
	}
}

func (s *Server) handleChatSlashCommand(ctx context.Context, text string, resp *chatTurnResponse) (bool, error) {
	if text == "/update-skill" || strings.HasPrefix(text, "/update-skill ") {
		id := strings.TrimSpace(strings.TrimPrefix(text, "/update-skill"))
		if id == "" {
			id = skills.BuiltinHandrawSkillID
		}
		sk, changed, err := s.skillsManager().Update(ctx, id)
		if err != nil {
			return true, bad(err.Error())
		}
		resp.SkillsChanged = true
		s.Emit("skills", map[string]any{"updated": true, "changed": changed, "id": sk.ID, "version": sk.Version})
		summary := fmt.Sprintf("Skill「%s」已是最新（%s）", sk.Name, sk.Version)
		if changed {
			summary = fmt.Sprintf("已在线热更新 Skill「%s」至 %s", sk.Name, sk.Version)
		}
		resp.ToolCalls = append(resp.ToolCalls, chatToolTrace{
			Name: "update_skill", Label: chatToolLabels["update_skill"],
			Summary: summary, OK: true,
		})
		resp.Reply = summary + "，无需重启即可直接生效。"
		return true, nil
	}
	if strings.HasPrefix(text, "/install-skill ") {
		src := strings.TrimSpace(strings.TrimPrefix(text, "/install-skill "))
		sk, err := s.skillsManager().InstallFromSource(ctx, src)
		if err != nil {
			return true, bad(err.Error())
		}
		resp.SkillsChanged = true
		s.Emit("skills", map[string]any{"updated": true, "id": sk.ID})
		resp.ToolCalls = append(resp.ToolCalls, chatToolTrace{
			Name: "install_skill", Label: chatToolLabels["install_skill"],
			Summary: fmt.Sprintf("已安装 Skill「%s」(%s)", sk.Name, sk.ID), OK: true,
		})
		resp.Reply = fmt.Sprintf("已成功安装 Skill **%s** (`%s`)，并已默认启用。\n\n你可以在左侧 Skills 面板随时开关，或在输入框用 `/%s` 显式调用它。", sk.Name, sk.ID, sk.ID)
		return true, nil
	}
	if strings.HasPrefix(text, "/install-plugin ") {
		src := strings.TrimSpace(strings.TrimPrefix(text, "/install-plugin "))
		c := &chatExecContext{srv: s, resp: resp}
		argObj := map[string]any{"enable": true}
		if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") || strings.Contains(src, "\\") || strings.Contains(src, "/") {
			argObj["source"] = src
		} else {
			argObj["marketName"] = src
		}
		b, _ := json.Marshal(argObj)
		_, trace := c.runTool(ctx, "install_plugin", string(b))
		resp.ToolCalls = append(resp.ToolCalls, trace)
		if !trace.OK {
			return true, bad(trace.Summary)
		}
		resp.Reply = fmt.Sprintf("已完成插件安装：%s。侧边栏导航会自动刷新。", trace.Summary)
		return true, nil
	}
	return false, nil
}

var (
	reDrawIntent    = regexp.MustCompile(`(?i)(画一|画\s*\d+|画[两二三四五六七八九十]|帮我画|给我画|生图|生成.{0,8}(图|画|海报|插画|手账|封面)|来[一两二三四五六七八九十\d]+[张幅页]|九宫格|四格|海报|插画|手账|draw|generate\s+image)`)
	reInstallSkill  = regexp.MustCompile(`(?i)(安装|添加|导入).{0,6}(skill|技能)`)
	reUpdateSkill   = regexp.MustCompile(`(?i)(更新|升级|同步).{0,6}(手绘\s*)?(skill|技能)`)
	reInstallPlugin = regexp.MustCompile(`(?i)(安装|搜索|查看|逛).{0,6}(插件|plugin)`)
	reURLOrPath     = regexp.MustCompile(`(https?://\S+|[A-Za-z]:\\[^\s"'<>]+|/[^\s"'<>]+\.(?:md|zip))`)
)

func (s *Server) handleChatWithoutTextProvider(ctx context.Context, text string, execCtx *chatExecContext) (*chatTurnResponse, error) {
	// 0. Skill update intent (e.g. "更新手绘skill")
	if reUpdateSkill.MatchString(text) {
		b, _ := json.Marshal(map[string]any{"id": skills.BuiltinHandrawSkillID})
		_, trace := execCtx.runTool(ctx, "update_skill", string(b))
		execCtx.resp.ToolCalls = append(execCtx.resp.ToolCalls, trace)
		if trace.OK {
			execCtx.resp.Reply = trace.Summary + "。"
		} else {
			execCtx.resp.Reply = "更新手绘 Skill 失败：" + trace.Summary
		}
		return execCtx.resp, nil
	}
	// 1. Skill installation intent with path/URL
	if reInstallSkill.MatchString(text) {
		if m := reURLOrPath.FindString(text); m != "" {
			b, _ := json.Marshal(map[string]any{"source": strings.TrimRight(m, ".,;，。；）)")})
			_, trace := execCtx.runTool(ctx, "install_skill", string(b))
			execCtx.resp.ToolCalls = append(execCtx.resp.ToolCalls, trace)
			if trace.OK {
				execCtx.resp.Reply = fmt.Sprintf("已为你完成安装：%s。现在可以直接在会话中使用它。", trace.Summary)
			} else {
				execCtx.resp.Reply = "安装 Skill 未成功：" + trace.Summary
			}
			return execCtx.resp, nil
		}
		_, trace := execCtx.runTool(ctx, "list_skills", "{}")
		execCtx.resp.ToolCalls = append(execCtx.resp.ToolCalls, trace)
		execCtx.resp.Reply = "请附上 Skill 的本地目录、`.md`/`.zip` 路径或 GitHub 链接（例如：`/install-skill https://...`），或点击左侧「Skills → + 安装」直接创建。"
		return execCtx.resp, nil
	}

	// 2. Plugin search/install intent
	if reInstallPlugin.MatchString(text) {
		if strings.Contains(text, "安装") {
			if m := reURLOrPath.FindString(text); m != "" {
				b, _ := json.Marshal(map[string]any{"source": strings.TrimRight(m, ".,;，。；）)"), "enable": true})
				_, trace := execCtx.runTool(ctx, "install_plugin", string(b))
				execCtx.resp.ToolCalls = append(execCtx.resp.ToolCalls, trace)
				execCtx.resp.Reply = trace.Summary
				return execCtx.resp, nil
			}
		}
		out, trace := execCtx.runTool(ctx, "search_market_plugins", `{"query":""}`)
		execCtx.resp.ToolCalls = append(execCtx.resp.ToolCalls, trace)
		var parsed struct {
			Plugins []struct {
				Name        string `json:"name"`
				Title       string `json:"title"`
				Description string `json:"description"`
				Installed   bool   `json:"installed"`
			} `json:"plugins"`
		}
		_ = json.Unmarshal([]byte(out), &parsed)
		if len(parsed.Plugins) > 0 {
			var sb strings.Builder
			sb.WriteString("为你从插件市场查到以下插件（输入 `/install-plugin 插件名` 可直接安装）：\n\n")
			for i, pl := range parsed.Plugins {
				if i >= 8 {
					break
				}
				mark := ""
				if pl.Installed {
					mark = " *(已安装)*"
				}
				sb.WriteString(fmt.Sprintf("- **%s** (`%s`)%s：%s\n", firstStr(pl.Title, pl.Name), pl.Name, mark, pl.Description))
			}
			execCtx.resp.Reply = sb.String()
		} else {
			execCtx.resp.Reply = "当前未能拉取到插件市场列表，你可以直接发送 `/install-plugin <插件链接或本地路径>` 安装插件。"
		}
		return execCtx.resp, nil
	}

	// 3. Chat-to-draw intent (single or multi!)
	if reDrawIntent.MatchString(text) {
		rawPlan, err := s.invokeLocalJSON(ctx, s.studioChatPlan, map[string]any{
			"message": text,
			"selected": map[string]any{
				"ratio": execCtx.defaultRatio,
			},
		})
		if err != nil {
			return nil, err
		}
		plan, _ := rawPlan.(*chatPlanResponse)
		if plan == nil {
			b, _ := json.Marshal(rawPlan)
			plan = &chatPlanResponse{}
			_ = json.Unmarshal(b, plan)
		}
		if len(plan.Items) > 0 {
			genItems := make([]map[string]any, 0, len(plan.Items))
			for _, it := range plan.Items {
				genItems = append(genItems, map[string]any{
					"theme":  it.Subject,
					"style":  plan.Common.Style1,
					"style2": plan.Common.Style2,
					"layout": it.Layout,
					"color":  firstStr(strings.Join(plan.Common.Colors, ","), ""),
					"ratio":  it.Ratio,
					"text":   it.DisplayCopy,
					"mode":   plan.Common.Mode,
				})
			}
			argBytes, _ := json.Marshal(map[string]any{
				"title": firstNRunes(text, 24),
				"mode":  plan.Common.Mode,
				"ratio": plan.Common.Ratio,
				"items": genItems,
			})
			_, trace := execCtx.runTool(ctx, "generate_images", string(argBytes))
			execCtx.resp.ToolCalls = append(execCtx.resp.ToolCalls, trace)
			if !trace.OK {
				execCtx.resp.Reply = "提交生图任务失败：" + trace.Summary
			} else if execCtx.resp.PendingConfirm != nil {
				execCtx.resp.Reply = "本次生图预计费用超过了你设置的确认阈值，请点击下方「确认继续生成」。"
			} else {
				execCtx.resp.Reply = fmt.Sprintf("%s\n\n已使用生图模型 `%s` 提交 **%d 张** 画面任务，生成完成后会自动显影在下方。", plan.Reply, firstStr(execCtx.imageModelRef, "默认模型"), len(genItems))
			}
			return execCtx.resp, nil
		}
	}

	// 4. General chat without configured text model
	execCtx.resp.Reply = strings.TrimSpace(`当前尚未配置可用于自由对话的第三方 OpenAI 兼容文本模型。

你可以：
1. 在 **设置 → 模型与接口** 添加一个文本模型（支持 DeepSeek、OpenAI、中转站等），并在底部 **文本** 下拉框选中它，或登录手绘风账号使用网站官方智能文字服务。
2. 即使暂未配置文本模型，你也可以直接在这里：
   - **对话生图**：例如发送「画 4 张周末咖啡店治愈手账」或「画一张雨夜书店插画」
   - **安装 Skill**：发送 ` + "`/install-skill <本地路径或链接>`" + `
   - **安装插件**：发送「搜索插件」或 ` + "`/install-plugin <插件名或链接>`")
	return execCtx.resp, nil
}

func tokenizeSearchQuery(q string) []string {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return nil
	}
	parts := strings.FieldsFunc(q, func(r rune) bool {
		switch r {
		case ' ', '\t', '\n', ',', '，', '、', '/', '+', '|', ';', '；':
			return true
		}
		return false
	})
	seen := map[string]bool{}
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}
