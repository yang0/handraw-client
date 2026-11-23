package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Translate planning responses into the client's editable card contract.
// The website uses subject/cover/illustrations; local text providers may use
// theme/slots. Keep that difference out of the form and generation code.
func seriesCards(raw json.RawMessage) []map[string]string {
	var obj struct {
		Items []map[string]any `json:"items"`
		Cards []map[string]any `json:"cards"`
	}
	var rows []map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		rows = obj.Items
		if len(rows) == 0 {
			rows = obj.Cards
		}
	} else {
		_ = json.Unmarshal(raw, &rows)
	}
	var out []map[string]string
	for i, row := range rows {
		theme := firstStr(planString(row, "theme"), planString(row, "subject"), planString(row, "prompt"))
		if theme == "" {
			continue
		}
		out = append(out, map[string]string{
			"theme": theme, "title": firstStr(planString(row, "title"), fmt.Sprintf("第 %d 张", i+1)),
			"text": planString(row, "text"), "layout": planString(row, "layout"),
		})
	}
	return out
}

func planString(row map[string]any, key string) string {
	v, _ := row[key].(string)
	return strings.TrimSpace(v)
}

func planningSource(raw json.RawMessage) string {
	var response struct{ Source string }
	_ = json.Unmarshal(raw, &response)
	if response.Source == "template" || response.Source == "local" {
		return "local"
	}
	return "site"
}

func articleBlocks(content string) []map[string]any {
	var blocks []map[string]any
	for _, line := range strings.Split(content, "\n") {
		text := strings.TrimSpace(line)
		if text == "" {
			continue
		}
		kind := "p"
		if strings.HasPrefix(text, "#") {
			level := len(text) - len(strings.TrimLeft(text, "#"))
			if level > 6 {
				level = 6
			}
			kind = fmt.Sprintf("h%d", level)
		}
		blocks = append(blocks, map[string]any{"idx": len(blocks), "kind": kind, "text": text})
	}
	return blocks
}

func stripMarkdownLead(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimLeft(s, "#>*+-` \t")
	s = strings.ReplaceAll(s, "**", "")
	s = strings.ReplaceAll(s, "__", "")
	return strings.TrimSpace(s)
}

func snapAnchorToContent(anchor, content string, blocks []map[string]any) string {
	anchor = strings.TrimSpace(anchor)
	if anchor != "" && strings.Contains(content, anchor) {
		return anchor
	}
	if anchor != "" {
		clean := stripMarkdownLead(anchor)
		if clean != "" && strings.Contains(content, clean) {
			return clean
		}
		// Match against article blocks by normalized containment or prefix overlap.
		for _, blk := range blocks {
			txt, _ := blk["text"].(string)
			if txt == "" {
				continue
			}
			cleanBlk := stripMarkdownLead(txt)
			if clean != "" && (strings.Contains(cleanBlk, clean) || strings.Contains(clean, cleanBlk)) {
				return txt
			}
		}
		// Try matching the first 12 runes of cleaned anchor.
		prefix := firstNRunes(clean, 12)
		if utf8.RuneCountInString(prefix) >= 4 {
			for _, blk := range blocks {
				txt, _ := blk["text"].(string)
				if strings.Contains(txt, prefix) {
					return txt
				}
			}
		}
	}
	return anchor
}

func articleSlots(raw json.RawMessage, content, coverRatio, inlineRatio string, includeCover bool) ([]map[string]any, []string) {
	var obj struct {
		Cover             map[string]any   `json:"cover"`
		Illustrations     []map[string]any `json:"illustrations"`
		Slots             []map[string]any `json:"slots"`
		RecommendedStyles []string         `json:"recommendedStyles"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return nil, nil
	}
	rows := obj.Slots
	if len(rows) == 0 {
		if includeCover && obj.Cover != nil {
			obj.Cover["role"] = "cover"
			rows = append(rows, obj.Cover)
		}
		rows = append(rows, obj.Illustrations...)
	}
	blocks := articleBlocks(content)
	var slots []map[string]any
	for _, row := range rows {
		role := firstStr(planString(row, "role"), "inline")
		if role != "cover" {
			role = "inline"
		}
		if role == "cover" && !includeCover {
			continue
		}
		theme := firstStr(planString(row, "theme"), planString(row, "subject"))
		if theme == "" {
			continue
		}
		ratio := inlineRatio
		if role == "cover" {
			ratio = coverRatio
		}
		anchor := firstStr(planString(row, "anchor"), planString(row, "anchorText"))
		if anchor == "" && role != "cover" {
			if index, ok := row["afterBlockIdx"].(float64); ok && int(index) >= 0 && int(index) < len(blocks) {
				anchor, _ = blocks[int(index)]["text"].(string)
			}
		}
		if role != "cover" {
			anchor = snapAnchorToContent(anchor, content, blocks)
		}
		slots = append(slots, map[string]any{
			"role": role, "theme": theme, "anchor": anchor, "ratio": ratio,
			"title":  firstStr(planString(row, "title"), planString(row, "purpose"), fmt.Sprintf("配图 %d", len(slots)+1)),
			"layout": planString(row, "layout"),
		})
	}
	return slots, obj.RecommendedStyles
}

func articlePlanRequest(title, content, style, coverRatio, inlineRatio string, includeCover bool) map[string]any {
	return map[string]any{
		"title": title, "blocks": articleBlocks(content), "charCount": utf8.RuneCountInString(content),
		"styleId": style, "coverRatio": coverRatio, "inlineRatio": inlineRatio, "includeCover": includeCover,
	}
}
