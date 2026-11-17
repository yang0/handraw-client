// Package prompt assembles bilingual prompts exactly as the Skill's
// prompt_style.py / resolve_reference.py do. Golden cases produced by the
// Skill (tests/fixtures/prompt_golden.json) keep the three implementations
// in agreement.
package prompt

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/yang0/handraw-client/internal/resources"
)

// Rules are the data-driven parts of the Skill's prompt builder. Defaults
// mirror prompt_style.py; a resource pack's prompt_rules.json overrides them.
type Rules struct {
	ReferenceIsolationZh string   `json:"reference_isolation_zh"`
	ReferenceIsolationEn string   `json:"reference_isolation_en"`
	GraphicTextSuffix    string   `json:"graphic_text_suffix"`
	RedrawZh             string   `json:"redraw_instruction_zh"`
	RedrawEn             string   `json:"redraw_instruction_en"`
	NegativeWords        []string `json:"negative_trait_words"`
	NegativeRegex        string   `json:"negative_trait_regex"`
	KeepRawStyles        []string `json:"keep_raw_styles"`
	PlaceholderZh        string   `json:"theme_placeholder_zh"`
	PlaceholderEn        string   `json:"theme_placeholder_en"`
}

func DefaultRules() Rules {
	return Rules{
		ReferenceIsolationZh: "所附图片仅用于参考画风。只提取参考图的风格特征，例如线条、笔触、媒介、材质、色彩倾向和整体视觉语言；" +
			"不要使用、复制或延续参考图中的任何主体、人物、动物、服装、道具、动作、姿态、场景、背景、构图、布局、文字或故事。" +
			"最终画面内容完全以用户提供的主题为准。",
		ReferenceIsolationEn: "Use the attached image only as a style reference. Extract only its stylistic qualities, such as linework, brushwork, medium, " +
			"material texture, color tendencies, and overall visual language. Do not use, copy, or carry over any subject, person, animal, " +
			"clothing, prop, action, pose, setting, background, composition, layout, text, or story from the reference image. " +
			"The user's written theme is the sole source for the image content.",
		GraphicTextSuffix: "【如果主题直白包含画面元素那就按主题出图，文案由你来升华，但是不要直接描述画面。 如果主题比较概念化，那么文案和主题尽量保持一致，如果文案较长由你提炼，由你先设计画面隐喻（人类和非人类都行）再出图   。    文字参与构图，图文一体】",
		RedrawZh:          "【请只提取人物的五官特征和姿态，场景轮廓，在画风上严格按 选择的风格重新画，不要在原照片上加质感。】",
		RedrawEn:          "[Extract only the character's facial features and posture, and the scene contours. Strictly redraw from scratch according to the selected style; do not add texture or filters onto the original photo.]",
		NegativeWords:     []string{"避免", "不要", "不准", "禁止"},
		NegativeRegex:     `无(?:写实纹理|精细材质|真实纹理)`,
		KeepRawStyles:     []string{"FE-048", "FE-049", "FE-051", "FH-050", "FD-042", "240", "242", "257", "259", "260"},
		PlaceholderZh:     "【请在此输入画面主题，或在生图模型中垫入你的照片】",
		PlaceholderEn:     "[Enter theme here, or attach your photo in the image AI]",
	}
}

// RulesFrom merges a pack's prompt_rules.json over the defaults. It accepts
// the Skill's nested schema (schema_version 1) and the flat field names.
func RulesFrom(raw json.RawMessage) Rules {
	r := DefaultRules()
	if len(raw) == 0 {
		return r
	}
	var nested struct {
		RefIso       map[string]string `json:"reference_isolation"`
		Suffix       string            `json:"graphic_text_suffix"`
		Redraw       map[string]string `json:"redraw_instruction"`
		Placeholder  map[string]string `json:"theme_placeholder"`
		TraitsFilter struct {
			NegativeWords []string `json:"negative_words"`
			NegativeRegex string   `json:"negative_regex"`
			KeepRawStyles []string `json:"keep_raw_styles"`
			KeepRawLegacy []string `json:"keep_raw_legacy"`
		} `json:"traits_filter"`
	}
	if json.Unmarshal(raw, &nested) == nil && nested.RefIso != nil {
		over := Rules{
			ReferenceIsolationZh: nested.RefIso["zh"], ReferenceIsolationEn: nested.RefIso["en"],
			GraphicTextSuffix: nested.Suffix,
			RedrawZh:          nested.Redraw["zh"], RedrawEn: nested.Redraw["en"],
			PlaceholderZh: nested.Placeholder["zh"], PlaceholderEn: nested.Placeholder["en"],
			NegativeWords: nested.TraitsFilter.NegativeWords, NegativeRegex: nested.TraitsFilter.NegativeRegex,
			KeepRawStyles: append(append([]string{}, nested.TraitsFilter.KeepRawStyles...), nested.TraitsFilter.KeepRawLegacy...),
		}
		return merge(r, over)
	}
	var over Rules
	if json.Unmarshal(raw, &over) != nil {
		return r
	}
	return merge(r, over)
}

func merge(r, over Rules) Rules {
	set := func(dst *string, v string) {
		if v != "" {
			*dst = v
		}
	}
	set(&r.ReferenceIsolationZh, over.ReferenceIsolationZh)
	set(&r.ReferenceIsolationEn, over.ReferenceIsolationEn)
	set(&r.GraphicTextSuffix, over.GraphicTextSuffix)
	set(&r.RedrawZh, over.RedrawZh)
	set(&r.RedrawEn, over.RedrawEn)
	set(&r.NegativeRegex, over.NegativeRegex)
	set(&r.PlaceholderZh, over.PlaceholderZh)
	set(&r.PlaceholderEn, over.PlaceholderEn)
	if len(over.NegativeWords) > 0 {
		r.NegativeWords = over.NegativeWords
	}
	if len(over.KeepRawStyles) > 0 {
		r.KeepRawStyles = over.KeepRawStyles
	}
	return r
}

// Input is one prompt request. Fields mirror prompt_style.py's arguments.
type Input struct {
	Style    string `json:"style"`
	Style2   string `json:"style2,omitempty"` // fusion: second style (client extension)
	Layout   string `json:"layout"`
	Color    string `json:"color"`
	Tone     string `json:"tone,omitempty"` // client extension
	Mood     string `json:"mood,omitempty"` // client extension
	Theme    string `json:"theme"`
	Ratio    string `json:"ratio"`
	Subject  string `json:"subject"`
	Text     string `json:"text"`
	Model    string `json:"model"`
	Mode     string `json:"mode"` // pure-image | graphic-text
	Redraw   bool   `json:"redraw"`
	Language string `json:"language"`        // auto | zh | en (only affects layout prompts)
	Extra    string `json:"extra,omitempty"` // free-form additions (client extension)
}

// Result is the assembled prompt plus what the generator needs.
type Result struct {
	Zh             string   `json:"zh"`
	En             string   `json:"en"`
	Primary        string   `json:"primary"` // the one to send: layout prompts are single-language
	Language       string   `json:"language"`
	StyleID        string   `json:"styleId,omitempty"`
	LayoutID       string   `json:"layoutId,omitempty"`
	ColorID        string   `json:"colorId,omitempty"`
	ReferenceImage string   `json:"referenceImage,omitempty"` // pack-relative image to attach
	UseReference   bool     `json:"useReference"`
	Activation     string   `json:"activation,omitempty"`
	GraphicText    bool     `json:"graphicText"`
	Labels         []string `json:"labels"`
	Tags           string   `json:"tags"` // 【画风：FA-013 】【图型：IG-038 】
}

// Decision mirrors resolve_reference.resolve.
type Decision struct {
	NameActivation   string `json:"nameActivation"`
	TraitsActivation string `json:"traitsActivation"`
	Activation       string `json:"activation"`
	UseReference     bool   `json:"useReference"`
	Traits           string `json:"traits"`
	ReferencePath    string `json:"referencePath"`
	Note             string `json:"note"`
}

var cjk = regexp.MustCompile(`[\x{3400}-\x{9fff}]`)

func DetectLanguage(s string) string {
	if cjk.MatchString(s) {
		return "zh"
	}
	return "en"
}

var traitSplit = regexp.MustCompile(`[；;。\n]+`)

// PositiveTraits drops negative clauses ("避免…", "不要…").
func (r Rules) PositiveTraits(traits string) string {
	if traits == "" {
		return ""
	}
	neg := regexp.MustCompile(r.NegativeRegex)
	var kept []string
	for _, part := range traitSplit.Split(traits, -1) {
		part = strings.Trim(part, " ，,、：:。；;\t")
		if part == "" {
			continue
		}
		skip := false
		for _, w := range r.NegativeWords {
			if strings.Contains(part, w) {
				skip = true
				break
			}
		}
		if skip || (r.NegativeRegex != "" && neg.MatchString(part)) {
			continue
		}
		kept = append(kept, part)
	}
	return strings.Join(kept, "；")
}

// Resolve decides whether name, traits, or a reference image activates a style for a model.
func Resolve(p *resources.Pack, r Rules, model string, s resources.Style) Decision {
	if model == "" {
		model = "gpt-image-2"
	}
	entry := map[string]string{}
	for k, v := range p.Capabilities.Default {
		if sv, ok := v.(string); ok {
			entry[k] = sv
		}
	}
	if prof, ok := p.Capabilities.Models[model]; ok {
		if prof.NameActivation != "" {
			entry["name_activation"] = prof.NameActivation
		}
		if prof.TraitsActivation != "" {
			entry["traits_activation"] = prof.TraitsActivation
		}
		if prof.Note != "" {
			entry["note"] = prof.Note
		}
		legacy := ""
		for l, n := range p.Aliases {
			if n == s.Number {
				legacy = l
				break
			}
		}
		st, ok := prof.Styles[s.Number]
		if !ok && legacy != "" {
			st = prof.Styles[legacy]
		}
		for k, v := range st {
			entry[k] = v
		}
	}
	na := orDefault(entry["name_activation"], "unknown")
	ta := orDefault(entry["traits_activation"], "unknown")
	keepRaw := false
	for _, k := range r.KeepRawStyles {
		if k == s.Number {
			keepRaw = true
		}
	}
	for l, n := range p.Aliases {
		if n == s.Number {
			for _, k := range r.KeepRawStyles {
				if k == l {
					keepRaw = true
				}
			}
		}
	}
	traits := s.Traits
	if !keepRaw {
		traits = r.PositiveTraits(s.Traits)
	}
	d := Decision{NameActivation: na, TraitsActivation: ta, Note: entry["note"]}
	switch {
	case na == "strong":
		d.Activation, d.UseReference, d.Traits = "name+style", false, ""
	case ta == "strong" && traits != "":
		d.Activation, d.UseReference, d.Traits = "name+style+traits", false, traits
	default:
		d.UseReference, d.Traits = true, traits
		if traits != "" {
			d.Activation = "name+style+traits+reference-image"
		} else {
			d.Activation = "name+style+reference-image"
		}
	}
	if d.UseReference {
		if s.Grid != "" {
			d.ReferencePath = s.Grid
		} else {
			d.ReferencePath = s.Image
		}
	}
	return d
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

type colorInfo struct {
	ID, NameZh, NameEn, PromptZh, PromptEn string
}

var colorSplit = regexp.MustCompile(`[,+、/]+`)

func resolveSingleColor(p *resources.Pack, q string) (colorInfo, error) {
	ql := strings.ToLower(strings.TrimSpace(q))
	isID := strings.HasPrefix(ql, "c-")
	qNum := ""
	if isID {
		qNum = strings.TrimLeft(strings.TrimPrefix(ql, "c-"), "0")
	}
	for _, c := range p.Colors {
		cid := strings.ToLower(c.ID)
		cNum := strings.TrimLeft(strings.TrimPrefix(cid, "c-"), "0")
		if ql == cid || (qNum != "" && qNum == cNum) || strings.Contains(strings.ToLower(c.NameZh), ql) || strings.Contains(strings.ToLower(c.NameEn), ql) {
			return colorInfo{c.ID, c.NameZh, c.NameEn, c.PromptZh, c.PromptEn}, nil
		}
	}
	if isID {
		return colorInfo{}, fmt.Errorf("未知主题色编号：%s", q)
	}
	name := strings.TrimSpace(q)
	return colorInfo{"", name, name, "主题色：" + name + "。", "Theme color: " + name + "."}, nil
}

func resolveColor(p *resources.Pack, q string) (colorInfo, error) {
	var tokens []string
	for _, t := range colorSplit.Split(q, -1) {
		if t = strings.TrimSpace(t); t != "" {
			tokens = append(tokens, t)
		}
	}
	if len(tokens) <= 1 {
		return resolveSingleColor(p, q)
	}
	var res []colorInfo
	for _, t := range tokens {
		c, err := resolveSingleColor(p, t)
		if err != nil {
			return colorInfo{}, err
		}
		res = append(res, c)
	}
	var ids, zhNames, enNames, zhPlain []string
	for _, c := range res {
		if c.ID != "" {
			ids = append(ids, c.ID)
		}
		if c.NameEn != "" {
			zhNames = append(zhNames, c.NameZh+"（"+c.NameEn+"）")
		} else {
			zhNames = append(zhNames, c.NameZh)
		}
		enNames = append(enNames, c.NameEn)
		zhPlain = append(zhPlain, c.NameZh)
	}
	out := colorInfo{ID: strings.Join(ids, " + "), NameZh: strings.Join(zhPlain, " 搭配 "), NameEn: strings.Join(enNames, " + ")}
	if len(res) == 2 {
		out.PromptZh = fmt.Sprintf("主题色：主色为%s（%s），点缀色为%s（%s）。", res[0].NameZh, res[0].NameEn, res[1].NameZh, res[1].NameEn)
		out.PromptEn = fmt.Sprintf("Theme color: %s as primary tone, accented with %s.", res[0].NameEn, res[1].NameEn)
	} else {
		out.PromptZh = "主题色：" + strings.Join(zhNames, " 搭配 ") + "。"
		out.PromptEn = "Theme color: " + strings.Join(enNames, " paired with ") + "."
	}
	return out, nil
}

// Build assembles the prompt. It follows prompt_style.py main() line by line,
// then appends client extensions (tone, mood, fusion, extra) which the Skill
// does not have; with those empty the output equals the Skill's.
func Build(p *resources.Pack, r Rules, in Input) (Result, error) {
	res := Result{Labels: []string{}}
	if in.Mode == "" {
		in.Mode = "pure-image"
	}
	// Poster shares the graphic-text engine; its composition instructions
	// arrive in Extra, while the saved recipe retains the poster selection.
	if in.Mode == "poster" {
		in.Mode = "graphic-text"
	}
	if in.Language == "" {
		in.Language = "auto"
	}
	if in.Model == "" {
		in.Model = "gpt-image-2"
	}
	if strings.TrimSpace(in.Theme) == "" {
		if in.Language == "en" {
			in.Theme = r.PlaceholderEn
		} else {
			in.Theme = r.PlaceholderZh
		}
	}
	if in.Style == "" && in.Layout == "" && in.Color == "" {
		return res, fmt.Errorf("请至少选择画风、图型或主题色之一")
	}
	var color *colorInfo
	if in.Color != "" {
		c, err := resolveColor(p, in.Color)
		if err != nil {
			return res, err
		}
		color = &c
		res.ColorID = c.ID
		res.Labels = append(res.Labels, "主题色 "+strings.TrimSpace(c.ID+" "+c.NameZh))
	}
	var style *resources.Style
	if in.Style != "" {
		s, ok := p.Style(in.Style)
		if !ok {
			return res, fmt.Errorf("找不到画风 %s", in.Style)
		}
		style = &s
		res.StyleID = s.Number
		res.Labels = append(res.Labels, "画风 "+s.Number+" "+s.GenerationName)
	}
	var zhExtra, enExtra []string
	if in.Ratio != "" {
		zhExtra = append(zhExtra, "画幅："+in.Ratio)
		enExtra = append(enExtra, "aspect ratio: "+in.Ratio)
	}
	if in.Subject != "" {
		zhExtra = append(zhExtra, "主体限制："+in.Subject)
		enExtra = append(enExtra, "subject constraints: "+in.Subject)
	}
	if in.Text != "" {
		zhExtra = append(zhExtra, "文字要求："+in.Text)
		enExtra = append(enExtra, "text requirement: "+in.Text)
	}
	extraZh := strings.Join(zhExtra, "；")
	extraEn := strings.Join(enExtra, "; ")
	extZh, extEn := extensions(p, in)

	if in.Layout != "" {
		l, ok := p.Layout(in.Layout)
		if !ok {
			return res, fmt.Errorf("找不到图型 %s", in.Layout)
		}
		res.LayoutID = l.ID
		res.Labels = append(res.Labels, "图型 "+l.ID+" "+l.Name)
		lang := in.Language
		if lang == "auto" {
			lang = DetectLanguage(in.Theme)
		}
		res.Language = lang
		isEcom := l.Category == "ecommerce" || strings.HasPrefix(l.ID, "EC-")
		var parts []string
		layoutPrompt := l.PromptZh
		if lang != "zh" {
			layoutPrompt = l.PromptEn
		}
		if lang == "zh" {
			parts = []string{"图型：" + l.Name + "。", "主题：" + in.Theme + "。", "排版要求：" + layoutPrompt}
		} else {
			name := l.NameEn
			if name == "" {
				name = l.Name
			}
			parts = []string{"Layout: " + name + ".", "Theme: " + in.Theme + ".", "Layout instructions: " + layoutPrompt}
		}
		if color != nil {
			cp := color.PromptZh
			if lang != "zh" {
				cp = color.PromptEn
			}
			parts = append(parts[:1], append([]string{cp}, parts[1:]...)...)
		}
		if style != nil {
			d := Resolve(p, r, in.Model, *style)
			if lang == "zh" {
				parts = append(parts, fmt.Sprintf("风格名称：%s。参考作者/风格名称：%s。", style.GenerationName, style.Reference))
				if d.Traits != "" {
					parts = append(parts, "核心风格特征："+d.Traits+"。")
				}
			} else {
				parts = append(parts, fmt.Sprintf("Style name: %s. Reference author/style name: %s.", style.GenerationName, style.Reference))
				if d.Traits != "" {
					parts = append(parts, "Core style traits: "+d.Traits+".")
				}
			}
			res.Activation = d.Activation
			// Graphic-text layouts never put the reference into the prompt, but the
			// generator may still attach it for weakly activated styles.
			res.UseReference = d.UseReference
			res.ReferenceImage = d.ReferencePath
		}
		if in.Redraw {
			if lang == "zh" {
				parts = append(parts, r.RedrawZh)
			} else {
				parts = append(parts, r.RedrawEn)
			}
		}
		if lang == "zh" {
			if extraZh != "" {
				parts = append(parts, "；"+extraZh)
			}
		} else if extraEn != "" {
			parts = append(parts, extraEn+".")
		}
		if !isEcom {
			parts = append(parts, r.GraphicTextSuffix)
			res.GraphicText = true
		}
		if lang == "zh" {
			res.Zh = strings.Join(parts, "") + extZh
			res.Primary = res.Zh
		} else {
			res.En = strings.Join(parts, " ") + extEn
			res.Primary = res.En
		}
		res.Tags = tags(res)
		return res, nil
	}

	suffix := ""
	if in.Mode == "graphic-text" {
		suffix = r.GraphicTextSuffix
		res.GraphicText = true
	}
	zhX, enX := "", ""
	if extraZh != "" {
		zhX = "；" + extraZh
	}
	if extraEn != "" {
		enX = " " + extraEn + "."
	}
	redZh, redEn := "", ""
	if in.Redraw {
		redZh, redEn = r.RedrawZh, " "+r.RedrawEn
	}
	if style == nil {
		res.Zh = fmt.Sprintf("%s主题：%s。%s%s%s", color.PromptZh, in.Theme, zhX, redZh, suffix) + extZh
		res.En = fmt.Sprintf("%s Theme: %s.%s%s%s", color.PromptEn, in.Theme, enX, redEn, suffix) + extEn
		res.Language = DetectLanguage(in.Theme)
		res.Primary = pick(res)
		res.Tags = tags(res)
		return res, nil
	}
	d := Resolve(p, r, in.Model, *style)
	res.Activation = d.Activation
	res.UseReference = d.UseReference
	res.ReferenceImage = d.ReferencePath
	traitsZh, traitsEn := "", ""
	if d.Traits != "" {
		traitsZh = "核心风格特征：" + d.Traits + "。"
		traitsEn = " Core style traits: " + d.Traits + "."
	}
	refZh, refEn := "", ""
	if d.UseReference && in.Mode == "pure-image" {
		if d.ReferencePath != "" {
			refZh = "参考图：请上传本地参考图 " + d.ReferencePath + "。" + r.ReferenceIsolationZh
			refEn = " Reference image: upload local reference image " + d.ReferencePath + ". " + r.ReferenceIsolationEn
		} else {
			refZh = "参考图：" + r.ReferenceIsolationZh
			refEn = " Reference image: " + r.ReferenceIsolationEn
		}
	}
	colZh, colEn := "", ""
	if color != nil {
		colZh, colEn = color.PromptZh, " "+color.PromptEn
	}
	res.Zh = fmt.Sprintf("风格名称：%s。%s主题：%s。参考作者/风格名称：%s。%s%s%s%s%s", style.GenerationName, colZh, in.Theme, style.Reference, traitsZh, refZh, zhX, redZh, suffix) + extZh
	res.En = fmt.Sprintf("Style name: %s.%s Theme: %s. Reference author/style name: %s.%s%s%s%s%s", style.GenerationName, colEn, in.Theme, style.Reference, traitsEn, refEn, enX, redEn, suffix) + extEn
	res.Language = DetectLanguage(in.Theme)
	res.Primary = pick(res)
	res.Tags = tags(res)
	return res, nil
}

// ForGeneration rewrites a prompt for direct API use: the "please upload
// local reference image <path>" sentence becomes "the attached image",
// because the generator attaches the file itself.
func ForGeneration(res Result, r Rules) string {
	s := res.Primary
	if res.ReferenceImage != "" {
		s = strings.Replace(s, "参考图：请上传本地参考图 "+res.ReferenceImage+"。", "参考图：", 1)
		s = strings.Replace(s, " Reference image: upload local reference image "+res.ReferenceImage+".", " Reference image:", 1)
	}
	return s
}

func pick(res Result) string {
	if res.Language == "en" {
		return res.En
	}
	return res.Zh
}

func tags(res Result) string {
	var b strings.Builder
	if res.StyleID != "" {
		b.WriteString("【画风：" + res.StyleID + " 】")
	}
	if res.LayoutID != "" {
		b.WriteString("【图型：" + res.LayoutID + " 】")
	}
	return b.String()
}

// extensions renders client-only options (fusion, tone, mood, extra).
func extensions(p *resources.Pack, in Input) (zh, en string) {
	var z, e []string
	if in.Style2 != "" {
		if s, ok := p.Style(in.Style2); ok {
			z = append(z, fmt.Sprintf("融合第二画风：%s（%s），两种画风的笔触与材质有机融合，不要拼贴。", s.GenerationName, s.Reference))
			e = append(e, fmt.Sprintf("Fuse with a second style: %s (%s); blend linework and materials organically, no collage.", s.GenerationName, s.Reference))
		}
	}
	if in.Tone != "" {
		if t, ok := p.Tone(in.Tone); ok {
			z = append(z, fmt.Sprintf("影调：%s，%s。", t.NameZh, t.DescZh))
			e = append(e, fmt.Sprintf("Tone: %s, %s.", t.NameEn, strings.ToLower(t.DescEn)))
		}
	}
	if in.Mood != "" {
		z = append(z, "情绪："+in.Mood+"。")
		e = append(e, "Mood: "+in.Mood+".")
	}
	if strings.TrimSpace(in.Extra) != "" {
		z = append(z, strings.TrimSpace(in.Extra))
		e = append(e, strings.TrimSpace(in.Extra))
	}
	if len(z) == 0 {
		return "", ""
	}
	return strings.Join(z, ""), " " + strings.Join(e, " ")
}
