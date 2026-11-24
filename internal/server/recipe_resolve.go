package server

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/yang0/handraw-client/internal/prompt"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/store"
)

type rawRecipeFields struct {
	ID         string   `json:"id,omitempty"`
	StyleIDs   []string `json:"styleIds,omitempty"`
	Style      string   `json:"style,omitempty"`
	Style1     string   `json:"style1,omitempty"`
	Style2     string   `json:"style2,omitempty"`
	LayoutID   string   `json:"layoutId,omitempty"`
	Layout     string   `json:"layout,omitempty"`
	Colors     []string `json:"colors,omitempty"`
	Color      string   `json:"color,omitempty"`
	Tones      []string `json:"tones,omitempty"`
	Tone       string   `json:"tone,omitempty"`
	Mood       string   `json:"mood,omitempty"`
	Ratio      string   `json:"ratio,omitempty"`
	Mode       string   `json:"mode,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Quality    string   `json:"quality,omitempty"`
	Text       string   `json:"text,omitempty"`
	Extra      string   `json:"extra,omitempty"`
	Redraw     bool     `json:"redraw,omitempty"`
	ShootType  string   `json:"shootType,omitempty"`
	SC021Type  string   `json:"sc021Type,omitempty"`
}

func splitRecipeTokens(raw string) []string {
	var out []string
	for _, p := range regexp.MustCompile(`[,+、/]+`).Split(strings.TrimSpace(raw), -1) {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func uniqNonEmpty(lists ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, list := range lists {
		for _, v := range list {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			k := strings.ToLower(v)
			if seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, v)
		}
	}
	return out
}

func parseRawRecipe(raw json.RawMessage) rawRecipeFields {
	var r rawRecipeFields
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &r)
	}
	return r
}

// mergePersistedRecipe combines explicit body.Recipe, parent run's recipe (for
// edits), and the first resolved generation item so layout/color/tone/mood are
// always persisted alongside styles and ratio (#85).
func mergePersistedRecipe(raw, parentRaw json.RawMessage, in prompt.Input, resolution, quality string) json.RawMessage {
	cur := parseRawRecipe(raw)
	par := parseRawRecipe(parentRaw)

	styles := uniqNonEmpty(
		[]string{in.Style, in.Style2},
		cur.StyleIDs,
		[]string{cur.Style, cur.Style1, cur.Style2},
		par.StyleIDs,
		[]string{par.Style, par.Style1, par.Style2},
	)
	layoutID := firstStr(in.Layout, cur.LayoutID, cur.Layout, par.LayoutID, par.Layout)
	colors := uniqNonEmpty(
		splitRecipeTokens(in.Color),
		cur.Colors,
		splitRecipeTokens(cur.Color),
		par.Colors,
		splitRecipeTokens(par.Color),
	)
	tones := uniqNonEmpty(
		splitRecipeTokens(in.Tone),
		cur.Tones,
		splitRecipeTokens(cur.Tone),
		par.Tones,
		splitRecipeTokens(par.Tone),
	)
	mood := firstStr(in.Mood, cur.Mood, par.Mood)
	ratio := firstStr(in.Ratio, cur.Ratio, par.Ratio)
	mode := firstStr(in.Mode, cur.Mode, par.Mode)
	resVal := firstStr(resolution, cur.Resolution, par.Resolution)
	qualVal := firstStr(quality, cur.Quality, par.Quality)
	textVal := firstStr(in.Text, cur.Text, par.Text)
	extraVal := firstStr(in.Extra, cur.Extra, par.Extra)
	redrawVal := in.Redraw || cur.Redraw || par.Redraw
	recID := firstStr(cur.ID, par.ID)

	out := map[string]any{}
	if recID != "" {
		out["id"] = recID
	}
	if len(styles) > 0 {
		out["styleIds"] = styles
	}
	if layoutID != "" {
		out["layoutId"] = layoutID
	}
	if len(colors) > 0 {
		out["colors"] = colors
		out["color"] = strings.Join(colors, "+")
	}
	if len(tones) > 0 {
		out["tones"] = tones
		out["tone"] = strings.Join(tones, "+")
	}
	if mood != "" {
		out["mood"] = mood
	}
	if ratio != "" {
		out["ratio"] = ratio
	}
	if mode != "" {
		out["mode"] = mode
	}
	if resVal != "" {
		out["resolution"] = resVal
	}
	if qualVal != "" {
		out["quality"] = qualVal
	}
	if textVal != "" {
		out["text"] = textVal
	}
	if extraVal != "" {
		out["extra"] = extraVal
	}
	if redrawVal {
		out["redraw"] = true
	}
	if cur.ShootType != "" {
		out["shootType"] = cur.ShootType
	}
	if cur.SC021Type != "" {
		out["sc021Type"] = cur.SC021Type
	}
	b, err := json.Marshal(out)
	if err != nil {
		return raw
	}
	return b
}

var (
	rePromptStyleName = regexp.MustCompile(`风格名称[：:]\s*([^。\n]+)`)
	rePromptStyleTag  = regexp.MustCompile(`【画风[：:]\s*([^】]+)】`)
	rePromptLayout    = regexp.MustCompile(`图型[：:]\s*([^。\n]+)`)
	rePromptLayoutTag = regexp.MustCompile(`【图型[：:]\s*([^】]+)】`)
	rePromptColor     = regexp.MustCompile(`主题色[：:]\s*([^。\n]+)`)
	rePromptTone      = regexp.MustCompile(`影调[：:]\s*([^。\n]+)`)
	rePromptMood      = regexp.MustCompile(`情绪(?:氛围)?[：:]\s*([^。\n]+)`)
)

func stripParenEn(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexAny(s, "（("); idx > 0 {
		return strings.TrimSpace(s[:idx])
	}
	return s
}

func matchStyleInPack(p *resources.Pack, q string) (string, string) {
	q = strings.TrimSpace(q)
	if q == "" {
		return "", ""
	}
	if p == nil {
		return q, ""
	}
	if st, ok := p.Style(q); ok {
		return st.Number, firstStr(st.NameZh, st.Reference, st.GenerationName)
	}
	ql := strings.ToLower(q)
	qShort := strings.ToLower(stripParenEn(q))
	for _, st := range p.Styles {
		for _, cand := range []string{st.Number, st.NameZh, st.Reference, st.GenerationName} {
			cl := strings.ToLower(strings.TrimSpace(cand))
			if cl != "" && (cl == ql || cl == qShort) {
				return st.Number, firstStr(st.NameZh, st.Reference, st.GenerationName)
			}
		}
	}
	return q, ""
}

func matchLayoutInPack(p *resources.Pack, q string) (string, string) {
	q = strings.TrimSpace(q)
	if q == "" {
		return "", ""
	}
	if p == nil {
		return "", q
	}
	if l, ok := p.Layout(q); ok {
		return l.ID, firstStr(l.Name, l.NameEn)
	}
	ql := strings.ToLower(q)
	qParts := strings.Split(ql, "/")
	qHead := strings.TrimSpace(qParts[0])
	for _, l := range p.Layouts {
		nl := strings.ToLower(strings.TrimSpace(l.Name))
		nel := strings.ToLower(strings.TrimSpace(l.NameEn))
		if nl == ql || nel == ql || (qHead != "" && (nl == qHead || strings.HasPrefix(nl, qHead))) {
			return l.ID, firstStr(l.Name, l.NameEn)
		}
	}
	return "", q
}

func matchColorInPack(p *resources.Pack, q string) (string, string) {
	q = strings.TrimSpace(q)
	if q == "" {
		return "", ""
	}
	if p == nil {
		return "", q
	}
	if c, ok := p.Color(q); ok {
		return c.ID, firstStr(c.NameZh, c.NameEn)
	}
	ql := strings.ToLower(q)
	qShort := strings.ToLower(stripParenEn(q))
	for _, c := range p.Colors {
		zh := strings.ToLower(strings.TrimSpace(c.NameZh))
		en := strings.ToLower(strings.TrimSpace(c.NameEn))
		if ql == strings.ToLower(c.ID) || (zh != "" && (zh == ql || zh == qShort || strings.Contains(ql, zh))) || (en != "" && (en == ql || strings.Contains(ql, en))) {
			return c.ID, firstStr(c.NameZh, c.NameEn)
		}
	}
	return "", stripParenEn(q)
}

func matchToneInPack(p *resources.Pack, q string) (string, string) {
	q = strings.TrimSpace(q)
	if q == "" {
		return "", ""
	}
	if p == nil {
		return "", q
	}
	if t, ok := p.Tone(q); ok {
		return t.ID, firstStr(t.NameZh, t.NameEn)
	}
	ql := strings.ToLower(q)
	qShort := strings.ToLower(stripParenEn(q))
	for _, t := range p.Tones {
		zh := strings.ToLower(strings.TrimSpace(t.NameZh))
		en := strings.ToLower(strings.TrimSpace(t.NameEn))
		if ql == strings.ToLower(t.ID) || (zh != "" && (zh == ql || zh == qShort || strings.Contains(ql, zh))) || (en != "" && (en == ql || strings.Contains(ql, en))) {
			return t.ID, firstStr(t.NameZh, t.NameEn)
		}
	}
	return "", stripParenEn(q)
}

// resolveRunRecipe returns a complete, human-readable recipe map for a run,
// inheriting from ancestor versions and recovering missing layout/color/tone/
// style fields from prompt markers for historical runs (#85).
func (s *Server) resolveRunRecipe(run store.Run, versions []store.Run) map[string]any {
	var p *resources.Pack
	if s != nil {
		p = s.Pack()
	}

	// Collect current run + ancestors (closest first).
	chain := []store.Run{run}
	for i := len(versions) - 1; i >= 0; i-- {
		if versions[i].ID != run.ID {
			chain = append(chain, versions[i])
		}
	}

	var styles, colors, tones []string
	var layoutRaw, mood, ratio, mode, resolution, quality, textVal, extraVal, shootType, sc021Type string
	var redraw bool

	for _, r := range chain {
		rec := parseRawRecipe(r.Recipe)
		if len(styles) == 0 {
			styles = uniqNonEmpty(rec.StyleIDs, []string{rec.Style, rec.Style1, rec.Style2})
		}
		if layoutRaw == "" {
			layoutRaw = firstStr(rec.LayoutID, rec.Layout)
		}
		if len(colors) == 0 {
			colors = uniqNonEmpty(rec.Colors, splitRecipeTokens(rec.Color))
		}
		if len(tones) == 0 {
			tones = uniqNonEmpty(rec.Tones, splitRecipeTokens(rec.Tone))
		}
		if mood == "" {
			mood = rec.Mood
		}
		if ratio == "" {
			ratio = rec.Ratio
		}
		if mode == "" {
			mode = rec.Mode
		}
		if resolution == "" {
			resolution = rec.Resolution
		}
		if quality == "" {
			quality = rec.Quality
		}
		if textVal == "" {
			textVal = rec.Text
		}
		if extraVal == "" {
			extraVal = rec.Extra
		}
		if !redraw && rec.Redraw {
			redraw = true
		}
		if shootType == "" {
			shootType = rec.ShootType
		}
		if sc021Type == "" {
			sc021Type = rec.SC021Type
		}
	}

	// Fallback recovery from prompt text markers for historical runs.
	promptSources := []string{run.PromptZh}
	for _, im := range run.Images {
		if strings.TrimSpace(im.Prompt) != "" {
			promptSources = append(promptSources, im.Prompt)
		}
	}
	for _, src := range promptSources {
		if strings.TrimSpace(src) == "" {
			continue
		}
		if len(styles) == 0 {
			if m := rePromptStyleTag.FindStringSubmatch(src); len(m) > 1 {
				styles = uniqNonEmpty(splitRecipeTokens(m[1]))
			} else if m := rePromptStyleName.FindStringSubmatch(src); len(m) > 1 {
				styles = uniqNonEmpty([]string{strings.TrimSpace(m[1])})
			}
		}
		if layoutRaw == "" {
			if m := rePromptLayoutTag.FindStringSubmatch(src); len(m) > 1 {
				layoutRaw = strings.TrimSpace(m[1])
			} else if m := rePromptLayout.FindStringSubmatch(src); len(m) > 1 {
				layoutRaw = strings.TrimSpace(m[1])
			}
		}
		if len(colors) == 0 {
			if m := rePromptColor.FindStringSubmatch(src); len(m) > 1 {
				// Multi-color prompts join with " + " or "、"; keep each item clean.
				parts := regexp.MustCompile(`[+、]+`).Split(strings.TrimSpace(m[1]), -1)
				colors = uniqNonEmpty(parts)
			}
		}
		if len(tones) == 0 {
			if m := rePromptTone.FindStringSubmatch(src); len(m) > 1 {
				parts := regexp.MustCompile(`[+、]+`).Split(strings.TrimSpace(m[1]), -1)
				tones = uniqNonEmpty(parts)
			}
		}
		if mood == "" {
			if m := rePromptMood.FindStringSubmatch(src); len(m) > 1 {
				mood = strings.TrimSpace(m[1])
			}
		}
	}

	styleItems := make([]map[string]string, 0, len(styles))
	resolvedStyleIDs := make([]string, 0, len(styles))
	for _, sRaw := range styles {
		id, name := matchStyleInPack(p, sRaw)
		if id != "" {
			resolvedStyleIDs = append(resolvedStyleIDs, id)
		}
		styleItems = append(styleItems, map[string]string{"id": id, "name": name})
	}

	var layoutItem map[string]string
	resolvedLayoutID := ""
	if layoutRaw != "" {
		lid, lname := matchLayoutInPack(p, layoutRaw)
		resolvedLayoutID = lid
		layoutItem = map[string]string{"id": lid, "name": firstStr(lname, layoutRaw)}
	}

	colorItems := make([]map[string]string, 0, len(colors))
	resolvedColorIDs := make([]string, 0, len(colors))
	for _, cRaw := range colors {
		cid, cname := matchColorInPack(p, cRaw)
		if cid != "" {
			resolvedColorIDs = append(resolvedColorIDs, cid)
		} else if cname != "" {
			resolvedColorIDs = append(resolvedColorIDs, cname)
		}
		colorItems = append(colorItems, map[string]string{"id": cid, "name": firstStr(cname, cRaw)})
	}

	toneItems := make([]map[string]string, 0, len(tones))
	resolvedToneIDs := make([]string, 0, len(tones))
	for _, tRaw := range tones {
		tid, tname := matchToneInPack(p, tRaw)
		if tid != "" {
			resolvedToneIDs = append(resolvedToneIDs, tid)
		} else if tname != "" {
			resolvedToneIDs = append(resolvedToneIDs, tname)
		}
		toneItems = append(toneItems, map[string]string{"id": tid, "name": firstStr(tname, tRaw)})
	}

	out := map[string]any{
		"styleIds":   resolvedStyleIDs,
		"styles":     styleItems,
		"layoutId":   resolvedLayoutID,
		"colors":     resolvedColorIDs,
		"colorItems": colorItems,
		"tones":      resolvedToneIDs,
		"toneItems":  toneItems,
		"mood":       mood,
		"ratio":      ratio,
		"mode":       firstStr(mode, run.Mode),
		"resolution": resolution,
		"quality":    quality,
		"text":       textVal,
		"extra":      extraVal,
		"redraw":     redraw,
		"shootType":  shootType,
		"sc021Type":  sc021Type,
	}
	if layoutItem != nil {
		out["layout"] = layoutItem
	}
	return out
}
