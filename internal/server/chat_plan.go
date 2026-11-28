package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
)

type chatPlanTurn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatPlanSelected struct {
	Style1        string   `json:"style1"`
	Style2        string   `json:"style2"`
	Layout        string   `json:"layout"`
	Colors        []string `json:"colors"`
	Color         string   `json:"color"`
	Tones         []string `json:"tones"`
	Tone          string   `json:"tone"`
	Moods         []string `json:"moods"`
	Mood          string   `json:"mood"`
	Mode          string   `json:"mode"`
	Ratio         string   `json:"ratio"`
	Whitespace    string   `json:"whitespace"`
	Audience      string   `json:"audience"`
	BusinessScene string   `json:"businessScene"`
}

type chatPlanRequest struct {
	Message  string           `json:"message"`
	History  []chatPlanTurn   `json:"history"`
	Selected chatPlanSelected `json:"selected"`
	ModelRef string           `json:"modelRef"`
}

type chatPlanCommon struct {
	Style1        string   `json:"style1"`
	Style1Name    string   `json:"style1Name"`
	Style2        string   `json:"style2"`
	Style2Name    string   `json:"style2Name"`
	Mode          string   `json:"mode"`
	Ratio         string   `json:"ratio"`
	Colors        []string `json:"colors"`
	ColorNames    []string `json:"colorNames"`
	Tones         []string `json:"tones"`
	Moods         []string `json:"moods"`
	Whitespace    string   `json:"whitespace"`
	Audience      string   `json:"audience"`
	BusinessScene string   `json:"businessScene"`
}

type chatPlanItem struct {
	Index       int    `json:"index"`
	Title       string `json:"title"`
	Subject     string `json:"subject"`
	DisplayCopy string `json:"displayCopy"`
	Layout      string `json:"layout"`
	LayoutName  string `json:"layoutName"`
	Ratio       string `json:"ratio"`
	Mood        string `json:"mood"`
}

type chatPlanResponse struct {
	OK          bool           `json:"ok"`
	Source      string         `json:"source"`
	StyleLocked bool           `json:"styleLocked"`
	Kind        string         `json:"kind"` // single | multi
	Reply       string         `json:"reply"`
	Common      chatPlanCommon `json:"common"`
	Items       []chatPlanItem `json:"items"`
}

func (s *Server) studioChatPlan(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	var body chatPlanRequest
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	body.Message = strings.TrimSpace(body.Message)
	if body.Message == "" {
		return nil, bad("请先输入想画的内容或修改意见")
	}
	body.Selected = normalizeChatSelected(body.Selected)
	route, err := resolveAIRouteForScene("text", "studioPlan", body.ModelRef)
	if err != nil {
		return nil, err
	}

	planWithSite := func() (*chatPlanResponse, error) {
		hist := make([]map[string]string, 0, len(body.History))
		start := 0
		if len(body.History) > 8 {
			start = len(body.History) - 8
		}
		for _, h := range body.History[start:] {
			role := strings.TrimSpace(h.Role)
			content := strings.TrimSpace(h.Content)
			if content == "" || (role != "user" && role != "assistant") {
				continue
			}
			hist = append(hist, map[string]string{"role": role, "content": content})
		}
		req := map[string]any{
			"message": body.Message,
			"history": hist,
			"selected": map[string]any{
				"style1":        body.Selected.Style1,
				"style2":        body.Selected.Style2,
				"layout":        body.Selected.Layout,
				"colors":        body.Selected.Colors,
				"tones":         body.Selected.Tones,
				"moods":         body.Selected.Moods,
				"mode":          body.Selected.Mode,
				"ratio":         body.Selected.Ratio,
				"whitespace":    body.Selected.Whitespace,
				"audience":      body.Selected.Audience,
				"businessScene": body.Selected.BusinessScene,
			},
		}
		raw, err := s.Site.ChatPlan(r.Context(), req)
		if err != nil {
			return nil, err
		}
		resp, err := parseAndNormalizeChatPlan(raw, p, body.Selected, "site")
		if err != nil {
			return nil, err
		}
		return resp, nil
	}

	planWithSiteBatch := func(count int) (*chatPlanResponse, error) {
		req := map[string]any{
			"seed":       body.Message,
			"count":      count,
			"layoutMode": "ai",
			"styleId":    body.Selected.Style1,
		}
		if body.Selected.Layout != "" {
			req["layoutMode"] = "fixed"
			req["fixedLayout"] = body.Selected.Layout
		}
		raw, err := s.Site.BatchPlan(r.Context(), req)
		if err != nil {
			return nil, err
		}
		cards := seriesCards(raw)
		if len(cards) == 0 {
			return nil, bad("线上规划返回为空")
		}
		items := make([]chatPlanItem, 0, len(cards))
		for i, c := range cards {
			if i >= 12 {
				break
			}
			items = append(items, chatPlanItem{
				Index:       i + 1,
				Title:       firstStr(c["title"], fmt.Sprintf("第 %d 张", i+1)),
				Subject:     c["theme"],
				DisplayCopy: c["text"],
				Layout:      firstStr(c["layout"], body.Selected.Layout),
				Ratio:       body.Selected.Ratio,
			})
		}
		resp := &chatPlanResponse{
			OK:     true,
			Source: "site",
			Reply:  fmt.Sprintf("已规划 %d 张系列画面方案，你可以直接生成或微调单张内容。", len(items)),
			Items:  items,
		}
		finalizeChatPlan(resp, p, body.Selected, body.Message)
		return resp, nil
	}

	planWithProvider := func(tp settings.Provider, model string) (*chatPlanResponse, error) {
		msgs := buildChatPlanMessages(p, body)
		reply, err := providers.Chat(r.Context(), tp, model, msgs, true)
		if err != nil {
			return nil, err
		}
		raw := json.RawMessage(extractJSON(reply))
		resp, err := parseAndNormalizeChatPlan(raw, p, body.Selected, "provider")
		if err != nil {
			return nil, bad("自定义文本模型返回的画面规划无法解析")
		}
		return resp, nil
	}

	planWithHarness := func() (*chatPlanResponse, error) {
		msgs := buildChatPlanMessages(p, body)
		res, err := s.callHarnessText(r.Context(), route, msgs, true)
		if err != nil {
			return nil, err
		}
		raw := json.RawMessage(extractJSON(res.Text))
		resp, err := parseAndNormalizeChatPlan(raw, p, body.Selected, "harness")
		if err != nil {
			return nil, bad("本地 Harness 返回的画面规划无法解析")
		}
		return resp, nil
	}

	snap := s.communityCatalog(r.Context(), false)
	applyOverrides := func(res *chatPlanResponse, err error) (*chatPlanResponse, error) {
		if err != nil || res == nil {
			return res, err
		}
		finalizeChatPlanWithOverrides(res, p, snap, body.Selected, body.Message)
		return res, nil
	}

	switch route.Mode {
	case "harness":
		return applyOverrides(planWithHarness())
	case "provider":
		return applyOverrides(planWithProvider(route.Provider, route.Model))
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		return applyOverrides(planWithSite())
	default:
		if s.Site.LoggedIn() {
			if res, err := planWithSite(); err == nil {
				return applyOverrides(res, nil)
			}
		}
		if tp, model, ok := findTextProviderFor("text"); ok {
			if res, err := planWithProvider(tp, model); err == nil {
				return applyOverrides(res, nil)
			}
		}
		if s.Site.LoggedIn() {
			if cnt, lines := detectMultiIntent(body.Message); cnt >= 2 && len(lines) == 0 {
				if res, err := planWithSiteBatch(cnt); err == nil {
					return applyOverrides(res, nil)
				}
			}
		}
		return applyOverrides(buildLocalChatPlan(p, body.Message, body.Selected), nil)
	}
}

func normalizeChatSelected(sel chatPlanSelected) chatPlanSelected {
	sel.Style1 = strings.TrimSpace(sel.Style1)
	sel.Style2 = strings.TrimSpace(sel.Style2)
	sel.Layout = strings.TrimSpace(sel.Layout)
	if strings.TrimSpace(sel.Mode) != "" {
		sel.Mode = normalizeChatMode(sel.Mode)
	}
	sel.Ratio = strings.TrimSpace(sel.Ratio)
	sel.Whitespace = strings.TrimSpace(sel.Whitespace)
	sel.Audience = strings.TrimSpace(sel.Audience)
	sel.BusinessScene = strings.TrimSpace(sel.BusinessScene)

	if len(sel.Colors) == 0 && strings.TrimSpace(sel.Color) != "" {
		for _, tok := range strings.FieldsFunc(sel.Color, func(r rune) bool { return r == ',' || r == '+' || r == '，' }) {
			if t := strings.TrimSpace(tok); t != "" {
				sel.Colors = append(sel.Colors, t)
			}
		}
	}
	if len(sel.Tones) == 0 && strings.TrimSpace(sel.Tone) != "" {
		sel.Tones = []string{strings.TrimSpace(sel.Tone)}
	}
	if len(sel.Moods) == 0 && strings.TrimSpace(sel.Mood) != "" {
		for _, tok := range strings.FieldsFunc(sel.Mood, func(r rune) bool { return r == ',' || r == '，' || r == '、' }) {
			if t := strings.TrimSpace(tok); t != "" {
				sel.Moods = append(sel.Moods, t)
			}
		}
	}
	return sel
}

func normalizeChatMode(m string) string {
	switch strings.ToLower(strings.TrimSpace(m)) {
	case "pure", "pure-image", "pure_image":
		return "pure-image"
	case "poster":
		return "poster"
	case "graphic-text", "graphic_text", "text", "":
		return "graphic-text"
	default:
		return "graphic-text"
	}
}

var reValidRatio = regexp.MustCompile(`^\d+(?:\.\d+)?:\d+(?:\.\d+)?$`)
var reStrayCopyLine = regexp.MustCompile(`(?m)(?:^|\n)\s*画面文字[：:][^\n]*`)

func normalizeChatRatio(r, fallback string) string {
	r = strings.TrimSpace(r)
	if reValidRatio.MatchString(r) {
		return r
	}
	fallback = strings.TrimSpace(fallback)
	if reValidRatio.MatchString(fallback) {
		return fallback
	}
	return "3:4"
}

func buildChatPlanMessages(p *resources.Pack, body chatPlanRequest) []providers.ChatMessage {
	var styleCatalog []string
	for i, st := range p.Styles {
		if i >= 40 {
			break
		}
		name := firstStr(st.NameZh, st.GenerationName)
		styleCatalog = append(styleCatalog, fmt.Sprintf("%s(%s)", st.Number, name))
	}
	var layoutCatalog []string
	for i, l := range p.Layouts {
		if i >= 24 {
			break
		}
		layoutCatalog = append(layoutCatalog, fmt.Sprintf("%s(%s)", l.ID, l.Name))
	}
	var colorCatalog []string
	for i, c := range p.Colors {
		if i >= 24 {
			break
		}
		colorCatalog = append(colorCatalog, fmt.Sprintf("%s(%s)", c.ID, c.NameZh))
	}

	sys := fmt.Sprintf(`你是「手绘风」视觉设计规划助手。根据用户的创作描述，自动判断应该输出单张图还是多张图（最多 12 张），并给出统一的画风/配色/比例与每张图的画面描述。
严格规则：
1. 若用户描述包含明确张数（如“出4张”“一套”“九宫格”“封面+3张”“系列”）或多行分条清单，则输出多张 items（2~12 张）；否则输出 1 张。
2. 若用户在 selected 中已经指定了 style1/style2/mode/ratio/colors/layout，必须尊重用户已选项；未指定时再从可选目录推荐最匹配的编号。
3. 影调（tones）、情绪（moods）、留白（whitespace）、目标受众（audience）、业务场景（businessScene）属于左侧「更多设置」的用户自选项，Skill 严禁代填；若用户已填写则作为创作参考，未填写时不要输出或编造这些字段。
4. 只返回严格 JSON，不要包含 Markdown 代码块或多余解释，结构如下：
{
  "kind": "single" | "multi",
  "reply": "简短中文设计说明（1-2 句）",
  "common": {
    "style1": "画风编号",
    "style2": "可选第二画风编号或空字符串",
    "mode": "graphic-text" | "pure-image" | "poster",
    "ratio": "3:4",
    "colors": ["主题色编号"]
  },
  "items": [
    {
      "index": 1,
      "title": "短标题（12字内）",
      "subject": "具体生动的中文画面主体与场景描述（不含画面文字字段）",
      "displayCopy": "图文/海报模式下画面内显示的简短文案，纯图模式留空",
      "layout": "可选图型编号或空字符串",
      "ratio": "3:4"
    }
  ]
}
可选画风示例：%s
可选图型示例：%s
可选主题色示例：%s`,
		strings.Join(styleCatalog, "、"),
		strings.Join(layoutCatalog, "、"),
		strings.Join(colorCatalog, "、"),
	)

	msgs := []providers.ChatMessage{{Role: "system", Content: sys}}
	start := 0
	if len(body.History) > 6 {
		start = len(body.History) - 6
	}
	for _, h := range body.History[start:] {
		role := strings.TrimSpace(h.Role)
		content := strings.TrimSpace(h.Content)
		if content == "" || (role != "user" && role != "assistant") {
			continue
		}
		msgs = append(msgs, providers.ChatMessage{Role: role, Content: content})
	}
	selJSON, _ := json.Marshal(body.Selected)
	userContent := fmt.Sprintf("用户已选参数：%s\n用户需求：%s", string(selJSON), body.Message)
	msgs = append(msgs, providers.ChatMessage{Role: "user", Content: userContent})
	return msgs
}

func parseAndNormalizeChatPlan(raw json.RawMessage, p *resources.Pack, sel chatPlanSelected, source string) (*chatPlanResponse, error) {
	var parsed struct {
		OK          bool   `json:"ok"`
		Source      string `json:"source"`
		StyleLocked bool   `json:"styleLocked"`
		Kind        string `json:"kind"`
		Reply       string `json:"reply"`
		Common      struct {
			Style1        string   `json:"style1"`
			Style1Name    string   `json:"style1Name"`
			Style2        string   `json:"style2"`
			Style2Name    string   `json:"style2Name"`
			Mode          string   `json:"mode"`
			Ratio         string   `json:"ratio"`
			Colors        []string `json:"colors"`
			Color         string   `json:"color"`
			ColorNames    []string `json:"colorNames"`
			Tones         []string `json:"tones"`
			Tone          string   `json:"tone"`
			Moods         []string `json:"moods"`
			Mood          string   `json:"mood"`
			Whitespace    string   `json:"whitespace"`
			Audience      string   `json:"audience"`
			BusinessScene string   `json:"businessScene"`
		} `json:"common"`
		Items []struct {
			Index       int    `json:"index"`
			Title       string `json:"title"`
			Subject     string `json:"subject"`
			Theme       string `json:"theme"`
			Prompt      string `json:"prompt"`
			DisplayCopy string `json:"displayCopy"`
			Text        string `json:"text"`
			Layout      string `json:"layout"`
			LayoutName  string `json:"layoutName"`
			Ratio       string `json:"ratio"`
			Mood        string `json:"mood"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	if len(parsed.Items) == 0 {
		return nil, bad("规划未返回任何画面条目")
	}
	colors := parsed.Common.Colors
	if len(colors) == 0 && strings.TrimSpace(parsed.Common.Color) != "" {
		colors = []string{strings.TrimSpace(parsed.Common.Color)}
	}
	tones := parsed.Common.Tones
	if len(tones) == 0 && strings.TrimSpace(parsed.Common.Tone) != "" {
		tones = []string{strings.TrimSpace(parsed.Common.Tone)}
	}
	moods := parsed.Common.Moods
	if len(moods) == 0 && strings.TrimSpace(parsed.Common.Mood) != "" {
		moods = []string{strings.TrimSpace(parsed.Common.Mood)}
	}
	resp := &chatPlanResponse{
		OK:     true,
		Source: source,
		Kind:   parsed.Kind,
		Reply:  strings.TrimSpace(parsed.Reply),
		Common: chatPlanCommon{
			Style1:        strings.TrimSpace(parsed.Common.Style1),
			Style1Name:    strings.TrimSpace(parsed.Common.Style1Name),
			Style2:        strings.TrimSpace(parsed.Common.Style2),
			Style2Name:    strings.TrimSpace(parsed.Common.Style2Name),
			Mode:          strings.TrimSpace(parsed.Common.Mode),
			Ratio:         strings.TrimSpace(parsed.Common.Ratio),
			Colors:        colors,
			ColorNames:    parsed.Common.ColorNames,
			Tones:         tones,
			Moods:         moods,
			Whitespace:    strings.TrimSpace(parsed.Common.Whitespace),
			Audience:      strings.TrimSpace(parsed.Common.Audience),
			BusinessScene: strings.TrimSpace(parsed.Common.BusinessScene),
		},
	}
	for i, it := range parsed.Items {
		if i >= 12 {
			break
		}
		subj := firstStr(strings.TrimSpace(it.Subject), strings.TrimSpace(it.Theme), strings.TrimSpace(it.Prompt))
		if subj == "" {
			continue
		}
		resp.Items = append(resp.Items, chatPlanItem{
			Index:       len(resp.Items) + 1,
			Title:       firstStr(strings.TrimSpace(it.Title), fmt.Sprintf("图 %d", len(resp.Items)+1)),
			Subject:     subj,
			DisplayCopy: firstStr(strings.TrimSpace(it.DisplayCopy), strings.TrimSpace(it.Text)),
			Layout:      strings.TrimSpace(it.Layout),
			LayoutName:  strings.TrimSpace(it.LayoutName),
			Ratio:       strings.TrimSpace(it.Ratio),
			Mood:        strings.TrimSpace(it.Mood),
		})
	}
	if len(resp.Items) == 0 {
		return nil, bad("规划未包含有效画面描述")
	}
	finalizeChatPlan(resp, p, sel, "")
	return resp, nil
}

func finalizeChatPlan(resp *chatPlanResponse, p *resources.Pack, sel chatPlanSelected, origMsg string) {
	finalizeChatPlanWithOverrides(resp, p, communityCatalogSnapshot{}, sel, origMsg)
}

func finalizeChatPlanWithOverrides(resp *chatPlanResponse, p *resources.Pack, snap communityCatalogSnapshot, sel chatPlanSelected, origMsg string) {
	resp.OK = true
	resp.StyleLocked = sel.Style1 != ""

	// Resolve style1 (locked by user if provided). Online exclusive overrides win over bundled pack (#211).
	style1 := sel.Style1
	if style1 == "" {
		style1 = resp.Common.Style1
	}
	if st, ok := resolveStyleFromSnapshot(p, snap, style1); ok {
		// If the user did NOT lock a style, never auto-assign a locked paid exclusive/community style.
		if sel.Style1 == "" && (st.PromptHidden || st.SiteModelOnly || st.Source == "exclusive" || st.Source == "community") && !st.Unlocked && !st.IsMine {
			defStyle := defaultFreePackStyle(p, snap)
			resp.Common.Style1 = defStyle.Number
			resp.Common.Style1Name = firstStr(defStyle.NameZh, defStyle.GenerationName, defStyle.Number)
		} else {
			resp.Common.Style1 = st.Number
			resp.Common.Style1Name = firstStr(st.NameZh, st.GenerationName, st.Number)
		}
	} else if looksLikeProtectedCode(style1) {
		// Preserve community/exclusive protected style codes that live outside the local pack (#207).
		code := strings.ToUpper(strings.TrimSpace(style1))
		resp.Common.Style1 = code
		resp.Common.Style1Name = firstStr(resp.Common.Style1Name, code)
	} else {
		defStyle := defaultFreePackStyle(p, snap)
		resp.Common.Style1 = defStyle.Number
		resp.Common.Style1Name = firstStr(defStyle.NameZh, defStyle.GenerationName, defStyle.Number)
	}

	// Resolve style2.
	style2 := sel.Style2
	if style2 == "" && !resp.StyleLocked {
		style2 = resp.Common.Style2
	}
	if style2 != "" {
		if st2, ok := resolveStyleFromSnapshot(p, snap, style2); ok {
			resp.Common.Style2 = st2.Number
			resp.Common.Style2Name = firstStr(st2.NameZh, st2.GenerationName, st2.Number)
		} else if looksLikeProtectedCode(style2) {
			code := strings.ToUpper(strings.TrimSpace(style2))
			resp.Common.Style2 = code
			resp.Common.Style2Name = firstStr(resp.Common.Style2Name, code)
		} else {
			resp.Common.Style2 = ""
			resp.Common.Style2Name = ""
		}
	} else {
		resp.Common.Style2 = ""
		resp.Common.Style2Name = ""
	}

	// Mode & Ratio.
	if sel.Mode != "" {
		resp.Common.Mode = normalizeChatMode(sel.Mode)
	} else {
		resp.Common.Mode = normalizeChatMode(resp.Common.Mode)
	}
	defaultRatio := "3:4"
	if resp.Common.Mode == "poster" && sel.Ratio == "" {
		defaultRatio = "9:16"
	}
	if sel.Ratio != "" {
		resp.Common.Ratio = normalizeChatRatio(sel.Ratio, defaultRatio)
	} else {
		resp.Common.Ratio = normalizeChatRatio(resp.Common.Ratio, defaultRatio)
	}

	// Colors.
	rawColors := sel.Colors
	if len(rawColors) == 0 {
		rawColors = resp.Common.Colors
	}
	validColors := make([]string, 0, len(rawColors))
	colorNames := make([]string, 0, len(rawColors))
	for _, cid := range rawColors {
		if c, ok := p.Color(strings.TrimSpace(cid)); ok {
			validColors = append(validColors, c.ID)
			colorNames = append(colorNames, firstStr(c.NameZh, c.ID))
		}
	}
	resp.Common.Colors = validColors
	resp.Common.ColorNames = colorNames

	// User-only "More Settings" fields (tones, moods, whitespace, audience, businessScene):
	// Skill planner must NEVER auto-fill them; preserve ONLY what the user explicitly selected (#204, handraw-web#588).
	validTones := make([]string, 0, len(sel.Tones))
	for _, tid := range sel.Tones {
		if t, ok := p.Tone(strings.TrimSpace(tid)); ok {
			validTones = append(validTones, t.ID)
		}
	}
	resp.Common.Tones = validTones
	if len(sel.Moods) > 0 {
		resp.Common.Moods = append([]string{}, sel.Moods...)
	} else {
		resp.Common.Moods = []string{}
	}
	resp.Common.Whitespace = sel.Whitespace
	resp.Common.Audience = sel.Audience
	resp.Common.BusinessScene = sel.BusinessScene

	// Items normalization.
	if len(resp.Items) > 12 {
		resp.Items = resp.Items[:12]
	}
	for i := range resp.Items {
		it := &resp.Items[i]
		it.Index = i + 1
		it.Subject = strings.TrimSpace(reStrayCopyLine.ReplaceAllString(it.Subject, ""))
		it.Mood = ""
		if it.Title == "" {
			if len(resp.Items) == 1 {
				it.Title = firstStr(firstNRunes(origMsg, 14), "当前画面")
			} else {
				it.Title = fmt.Sprintf("第 %d 张", i+1)
			}
		}
		it.Ratio = normalizeChatRatio(it.Ratio, resp.Common.Ratio)
		if resp.Common.Mode == "pure-image" {
			it.Layout = ""
			it.LayoutName = ""
			it.DisplayCopy = ""
		} else {
			lid := firstStr(it.Layout, sel.Layout)
			if lid != "" {
				if l, ok := p.Layout(lid); ok {
					it.Layout = l.ID
					it.LayoutName = firstStr(l.Name, l.ID)
				} else if looksLikeProtectedCode(lid) {
					code := strings.ToUpper(strings.TrimSpace(lid))
					it.Layout = code
					it.LayoutName = firstStr(it.LayoutName, code)
				} else {
					it.Layout = ""
					it.LayoutName = ""
				}
			}
		}
	}

	if len(resp.Items) > 1 {
		resp.Kind = "multi"
	} else {
		resp.Kind = "single"
	}
	if resp.Reply == "" {
		if resp.Kind == "multi" {
			resp.Reply = fmt.Sprintf("已为你规划 %d 张连贯画面方案（画风 %s），可直接生成或点击任意缩略图微调。", len(resp.Items), resp.Common.Style1Name)
		} else {
			resp.Reply = fmt.Sprintf("已准备好单图方案（画风 %s · %s），正在为你绘制。", resp.Common.Style1Name, resp.Common.Ratio)
		}
	}
}

func defaultPackStyle(p *resources.Pack) resources.Style {
	for _, code := range []string{"FA-002", "FA-006", "FA-018"} {
		if st, ok := p.Style(code); ok {
			return st
		}
	}
	if len(p.Styles) > 0 {
		return p.Styles[0]
	}
	return resources.Style{Number: "FA-002", NameZh: "手绘插画"}
}

var (
	reExplicitCount = regexp.MustCompile(`(?:出|画|生成|做|来|要|写|排|共|一共)?\s*(\d{1,2}|[两二三四五六七八九十])\s*(?:张|幅|页|图|幕|屏)`)
	reCoverPlus     = regexp.MustCompile(`封面\s*[+＋加和与]\s*(\d{1,2}|[两二三四五六七八九十])\s*(?:张|幅|页|图)`)
	reListPrefix    = regexp.MustCompile(`^(?:[-*•·]\s*|\d+[.、)）]\s*|第[一二三四五六七八九十\d]+[张幅页图幕][:：]?\s*)`)
)

func parseZhOrInt(s string) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	switch s {
	case "两", "二":
		return 2
	case "三":
		return 3
	case "四":
		return 4
	case "五":
		return 5
	case "六":
		return 6
	case "七":
		return 7
	case "八":
		return 8
	case "九":
		return 9
	case "十":
		return 10
	default:
		return 0
	}
}

// detectMultiIntent inspects a message for multi-image intent:
// returns desired count (>=2 for multi, 1 for single) and optional parsed lines when user pasted a list.
func detectMultiIntent(msg string) (int, []string) {
	msg = strings.TrimSpace(strings.ReplaceAll(msg, "\r\n", "\n"))
	if msg == "" {
		return 1, nil
	}
	rawLines := strings.Split(msg, "\n")
	var cleanLines []string
	for _, ln := range rawLines {
		t := strings.TrimSpace(reListPrefix.ReplaceAllString(strings.TrimSpace(ln), ""))
		if t != "" {
			cleanLines = append(cleanLines, t)
		}
	}
	if len(cleanLines) >= 2 {
		if len(cleanLines) > 12 {
			cleanLines = cleanLines[:12]
		}
		return len(cleanLines), cleanLines
	}

	if m := reCoverPlus.FindStringSubmatch(msg); len(m) > 1 {
		if n := parseZhOrInt(m[1]); n >= 1 {
			total := n + 1
			if total > 12 {
				total = 12
			}
			return total, nil
		}
	}
	if strings.Contains(msg, "九宫格") {
		return 9, nil
	}
	if strings.Contains(msg, "六宫格") {
		return 6, nil
	}
	if strings.Contains(msg, "四宫格") {
		return 4, nil
	}
	if m := reExplicitCount.FindStringSubmatch(msg); len(m) > 1 {
		n := parseZhOrInt(m[1])
		if n >= 2 {
			if n > 12 {
				n = 12
			}
			return n, nil
		}
	}
	for _, kw := range []string{"一套", "一组", "系列", "多图", "合集", "分镜", "连续"} {
		if strings.Contains(msg, kw) {
			return 4, nil
		}
	}
	return 1, nil
}

func buildLocalChatPlan(p *resources.Pack, msg string, sel chatPlanSelected) *chatPlanResponse {
	cnt, lines := detectMultiIntent(msg)
	resp := &chatPlanResponse{
		OK:     true,
		Source: "local",
	}
	if cnt <= 1 {
		resp.Items = []chatPlanItem{{
			Index:   1,
			Title:   firstStr(firstNRunes(msg, 14), "当前画面"),
			Subject: msg,
			Layout:  sel.Layout,
			Ratio:   sel.Ratio,
		}}
		finalizeChatPlan(resp, p, sel, msg)
		return resp
	}

	items := make([]chatPlanItem, 0, cnt)
	if len(lines) >= 2 {
		for i, ln := range lines {
			items = append(items, chatPlanItem{
				Index:   i + 1,
				Title:   firstStr(firstNRunes(ln, 12), fmt.Sprintf("第 %d 张", i+1)),
				Subject: ln,
				Layout:  sel.Layout,
				Ratio:   sel.Ratio,
			})
		}
	} else {
		beats := []string{
			"开篇主画面 · 氛围建立与核心主体特写",
			"日常展开 · 互动细节与生活质感",
			"重点特写 · 核心道具与层次光影",
			"收束定格 · 温暖余韵与完整场景",
			"延伸视角 · 换角度呈现细节故事",
			"轻松片刻 · 趣味互动小插曲",
			"静物摆拍 · 精选物件与手绘注解",
			"场景远景 · 整体空间与情绪留白",
			"尾声彩蛋 · 呼应开篇的治愈瞬间",
		}
		for i := 0; i < cnt; i++ {
			beat := beats[i%len(beats)]
			title := fmt.Sprintf("第 %d 张", i+1)
			if i == 0 && strings.Contains(msg, "封面") {
				title = "封面主图"
			}
			items = append(items, chatPlanItem{
				Index:   i + 1,
				Title:   title,
				Subject: fmt.Sprintf("%s — %s", msg, beat),
				Layout:  sel.Layout,
				Ratio:   sel.Ratio,
			})
		}
	}
	resp.Items = items
	finalizeChatPlan(resp, p, sel, msg)
	return resp
}
