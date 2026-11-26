package server

import (
	"regexp"
	"strings"

	"github.com/yang0/handraw-client/internal/store"
)

var (
	reTitleLeadPrefix = regexp.MustCompile(`^(?:(?:封面|主图|首图|标题|主题|痛点场景|核心干货\s*\d*|收尾总结|配图\s*\d*|分镜\s*\d*)\s*[：:\-—｜|]\s*|第\s*\d+\s*[张页图幅节章]\s*[：:\-—·、\s]\s*|(?:图|页|[Pp]|[Ss]lide)\s*\d+\s*[：:\-—·、.]\s*|\d+\s*[.、)）]\s*)`)
	reTitleHelperNote = regexp.MustCompile(`\s*[（(][^（）()]{0,16}(?:视觉冲击|主图|封面图?|配图|竖版|横版|构图|手绘风)[^（）()]{0,12}[）)]\s*$`)
	rePromptTextCue    = regexp.MustCompile(`(?:主标题|画面文字|文字内容|文案|展示文字|醒目大字(?:写着)?)[：:\s]*[「『"“]?([^\n」』"”]{2,40})`)
	reTitleMultiSpaces = regexp.MustCompile(`\s+`)
)

func stripCanvasComboSuffix(s string) string {
	s = strings.TrimSpace(s)
	for _, suf := range []string{" · 组合", "·组合", " - 组合", "-组合"} {
		if strings.HasSuffix(s, suf) {
			s = strings.TrimSpace(strings.TrimSuffix(s, suf))
		}
	}
	return s
}

func stripSampleSuffix(s string) (base string, isSample bool) {
	s = strings.TrimSpace(s)
	for _, suf := range []string{" · 样张", "·样张", " - 样张"} {
		if strings.HasSuffix(s, suf) {
			return strings.TrimSpace(strings.TrimSuffix(s, suf)), true
		}
	}
	return s, false
}

// isPlaceholderRunTitle reports whether s is an empty or generic auto-generated
// placeholder title (such as "未命名画布 · 组合" or "参数组合画布 · 组合") that
// should be replaced with a content-derived title (#184).
func isPlaceholderRunTitle(s string) bool {
	base, _ := stripSampleSuffix(stripCanvasComboSuffix(s))
	base = strings.TrimSpace(base)
	switch base {
	case "",
		"未命名画布",
		"参数组合画布",
		"画布",
		"新建画布",
		"未命名",
		"未命名作品",
		"未命名系列图",
		"画布作品",
		"画布生成",
		"画布生成结果",
		"系列图",
		"系列创作",
		"手绘风创作",
		"直出创作",
		"文章配图",
		"手绘视觉主题展示",
		"基于所附参考图的手绘创作",
		"基于参考图的手绘创作",
		"手绘插画":
		return true
	default:
		return false
	}
}

func unwrapOuterQuotes(s string) string {
	pairs := [][2]string{
		{"「", "」"},
		{"『", "』"},
		{"《", "》"},
		{"“", "”"},
		{"\"", "\""},
		{"'", "'"},
	}
	for _, p := range pairs {
		if strings.HasPrefix(s, p[0]) && strings.HasSuffix(s, p[1]) && len(s) > len(p[0])+len(p[1]) {
			inner := strings.TrimSpace(s[len(p[0]) : len(s)-len(p[1])])
			if !strings.Contains(inner, p[1]) {
				return inner
			}
		}
	}
	return s
}

// extractCleanTitle derives a concise, human-readable work title from a raw
// theme, display text, or prompt line. Returns "" if raw only contains
// placeholders.
func extractCleanTitle(raw string, maxRunes int) string {
	if maxRunes <= 0 {
		maxRunes = 28
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(raw, "\r\n", "\n"), "\r", "\n")
	line := ""
	for _, part := range strings.Split(normalized, "\n") {
		part = strings.TrimSpace(part)
		if part != "" {
			line = part
			break
		}
	}
	if line == "" {
		return ""
	}
	for i := 0; i < 2; i++ {
		next := strings.TrimSpace(reTitleLeadPrefix.ReplaceAllString(line, ""))
		if next == "" || next == line {
			break
		}
		line = next
	}
	if stripped := strings.TrimSpace(reTitleHelperNote.ReplaceAllString(line, "")); len([]rune(stripped)) >= 4 {
		line = stripped
	}
	line = unwrapOuterQuotes(strings.TrimSpace(line))
	line = reTitleMultiSpaces.ReplaceAllString(line, " ")
	if isPlaceholderRunTitle(line) {
		return ""
	}
	runes := []rune(line)
	if len(runes) > maxRunes {
		cut := maxRunes
		for i := 8; i < maxRunes && i < len(runes); i++ {
			switch runes[i] {
			case '。', '！', '？', '；', '｜', '|', '—':
				cut = i
				i = maxRunes
			}
		}
		line = strings.TrimRight(string(runes[:cut]), "，、：:；;—- ")
	}
	if isPlaceholderRunTitle(line) {
		return ""
	}
	return line
}

func extractTitleFromPromptText(prompt string) string {
	if m := rePromptTextCue.FindStringSubmatch(prompt); len(m) > 1 {
		if t := extractCleanTitle(m[1], 28); t != "" {
			return t
		}
	}
	return ""
}

// resolveRunTitle chooses the best title for a new generation run (#184):
//   - Respects non-placeholder explicit titles (stripping redundant " · 组合").
//   - When the incoming title is empty or a generic placeholder (e.g.
//     "未命名画布 · 组合", "参数组合画布 · 组合"), derives a clean title from
//     the batch's item themes, display text, prompts, or reference notes.
func resolveRunTitle(rawTitle string, items []generateItem, itemThemes []string, fallback string) string {
	cleanedRaw := stripCanvasComboSuffix(rawTitle)
	if !isPlaceholderRunTitle(cleanedRaw) {
		return firstNRunes(cleanedRaw, 40)
	}
	_, isSample := stripSampleSuffix(cleanedRaw)
	suffix := ""
	if isSample {
		suffix = " · 样张"
	}

	candidates := make([]string, 0, len(itemThemes)+len(items)*3)
	candidates = append(candidates, itemThemes...)
	for _, it := range items {
		candidates = append(candidates, it.Theme, it.Text)
	}
	for _, it := range items {
		if t := extractTitleFromPromptText(it.Prompt); t != "" {
			candidates = append(candidates, t)
		}
		candidates = append(candidates, it.Prompt)
		for _, rs := range it.RefSpecs {
			candidates = append(candidates, rs.Note, rs.Label)
		}
	}
	for _, c := range candidates {
		if t := extractCleanTitle(c, 28); t != "" {
			return t + suffix
		}
	}
	return firstStr(fallback, "手绘风创作") + suffix
}

// normalizeRunDisplayTitle replaces legacy placeholder titles (e.g.
// "未命名画布 · 组合" / "参数组合画布 · 组合") on existing runs when serving
// /api/works and /api/works/{id} so previously created works display meaningful
// titles immediately (#184).
func normalizeRunDisplayTitle(run *store.Run) {
	if run == nil {
		return
	}
	if !isPlaceholderRunTitle(run.Title) {
		return
	}
	_, isSample := stripSampleSuffix(stripCanvasComboSuffix(run.Title))
	suffix := ""
	if isSample {
		suffix = " · 样张"
	}
	candidates := make([]string, 0, 2+len(run.Images)*2)
	candidates = append(candidates, run.OriginalRequest)
	for _, im := range run.Images {
		candidates = append(candidates, im.Theme)
	}
	for _, im := range run.Images {
		if t := extractTitleFromPromptText(im.Prompt); t != "" {
			candidates = append(candidates, t)
		}
	}
	if t := extractTitleFromPromptText(run.PromptZh); t != "" {
		candidates = append(candidates, t)
	}
	for _, c := range candidates {
		if t := extractCleanTitle(c, 28); t != "" {
			run.Title = t + suffix
			return
		}
	}
}
