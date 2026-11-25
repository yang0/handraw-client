// Package resources loads the official resource pack (styles, layouts,
// colors, tones, characters…) from local files. Images are served from disk;
// nothing here needs the network.
//
// A pack directory looks like:
//
//	manifest.json
//	references/styles.json, layouts.json, colors.json, tones.json, …
//	references/prompt_rules.json, similarity.json   (optional)
//	layouts/*.md                                     (optional: layout prompts when not inlined)
//	images/individual/FA/FA-001.webp, images/layouts/…, images/colors/…, images/tones/…
//
// The loader also accepts the raw Skill checkout (E:\handraw-style) so the
// client works in development before a pack is built.
package resources

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

type Style struct {
	Number         string   `json:"number"`
	Group          string   `json:"group"`
	GroupCode      string   `json:"groupCode"`
	GroupZh        string   `json:"groupZh"`
	GroupEn        string   `json:"groupEn"`
	Reference      string   `json:"reference"`
	GenerationName string   `json:"generation_name"`
	Traits         string   `json:"traits"`
	Image          string   `json:"image"` // pack-relative or local path for custom
	Images         []string `json:"images,omitempty"`
	RemoteImageURL string   `json:"remoteImageUrl,omitempty"`
	Grid           string   `json:"grid,omitempty"`
	Source         string   `json:"source"` // official | mine | unlocked | community | exclusive
	Author         string   `json:"author,omitempty"`
	AuthorName     string   `json:"authorName,omitempty"`
	License        string   `json:"license,omitempty"`
	NameZh         string   `json:"nameZh,omitempty"`
	Description    string   `json:"description,omitempty"`
	TraitsEn       string   `json:"traitsEn,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	UnlockCost     int      `json:"unlockCost,omitempty"`
	Unlocked       bool     `json:"unlocked,omitempty"`
	IsMine         bool     `json:"isMine,omitempty"`
	PromptHidden   bool     `json:"promptHidden,omitempty"`
	SiteModelOnly  bool     `json:"siteModelOnly,omitempty"`
}

type Layout struct {
	ID             string   `json:"id"`
	Category       string   `json:"category"`
	Name           string   `json:"name"`
	NameEn         string   `json:"name_en"`
	Image          string   `json:"image"`
	Images         []string `json:"images,omitempty"`
	RemoteImageURL string   `json:"remoteImageUrl,omitempty"`
	PromptFile     string   `json:"prompt_file,omitempty"`
	Keywords       []string `json:"keywords"`
	PromptZh       string   `json:"prompt_zh"`
	PromptEn       string   `json:"prompt_en"`
	Description    string   `json:"description,omitempty"`
	Author         string   `json:"author,omitempty"`
	AuthorName     string   `json:"authorName,omitempty"`
	License        string   `json:"license,omitempty"`
	Source         string   `json:"source"`
	UnlockCost     int      `json:"unlockCost,omitempty"`
	Unlocked       bool     `json:"unlocked,omitempty"`
	IsMine         bool     `json:"isMine,omitempty"`
	PromptHidden   bool     `json:"promptHidden,omitempty"`
	SiteModelOnly  bool     `json:"siteModelOnly,omitempty"`
}

type Color struct {
	ID         string `json:"id"`
	Category   string `json:"category"`
	CategoryZh string `json:"category_zh"`
	CategoryEn string `json:"category_en"`
	NameZh     string `json:"name_zh"`
	NameEn     string `json:"name_en"`
	QuoteZh    string `json:"quote_zh"`
	QuoteEn    string `json:"quote_en"`
	Image      string `json:"image"`
	PromptZh   string `json:"prompt_zh"`
	PromptEn   string `json:"prompt_en"`
	Hex        string `json:"hex,omitempty"`
}

type Tone struct {
	ID         string `json:"id"`
	NameZh     string `json:"name_zh"`
	NameEn     string `json:"name_en"`
	Category   string `json:"category"`
	CategoryZh string `json:"category_zh"`
	CategoryEn string `json:"category_en"`
	DescZh     string `json:"desc_zh"`
	DescEn     string `json:"desc_en"`
	Image      string `json:"image"`
}

type Asset struct {
	ID     string   `json:"id"`
	Kind   string   `json:"kind"` // character | prop | scene
	Name   string   `json:"name"`
	NameEn string   `json:"name_en"`
	Image  string   `json:"image"`
	Layout string   `json:"layout,omitempty"`
	Tags   []string `json:"tags,omitempty"`
}

type Capabilities struct {
	Default map[string]any                `json:"default"`
	Models  map[string]CapabilityProfile `json:"models"`
}

type CapabilityProfile struct {
	NameActivation   string                       `json:"name_activation"`
	TraitsActivation string                       `json:"traits_activation"`
	Note             string                       `json:"note"`
	Styles           map[string]map[string]string `json:"styles"`
}

// Pack is an immutable loaded resource pack.
type Pack struct {
	Dir          string
	ImageRoot    string // directory that "images/..." paths are relative to
	Version      string
	Styles       []Style
	Layouts      []Layout
	Colors       []Color
	Tones        []Tone
	Assets       []Asset
	Capabilities Capabilities
	Aliases      map[string]string // legacy number -> canonical
	Similar      map[string][]string
	Rules        json.RawMessage
	Groups       []Group

	styleIdx  map[string]int
	layoutIdx map[string]int
	colorIdx  map[string]int
	toneIdx   map[string]int
}

type Group struct {
	Code  string `json:"code"`
	Zh    string `json:"zh"`
	En    string `json:"en"`
	Count int    `json:"count"`
}

var (
	mu      sync.RWMutex
	current *Pack
)

func Current() *Pack {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

func SetCurrent(p *Pack) {
	mu.Lock()
	current = p
	mu.Unlock()
}

// Locate finds the first usable pack among candidates.
func Locate(candidates ...string) (string, error) {
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, err := refDir(c); err == nil {
			return c, nil
		}
	}
	return "", errors.New("no resource pack found")
}

// refDir returns the references directory of a pack or a Skill checkout.
func refDir(dir string) (string, error) {
	for _, p := range []string{
		filepath.Join(dir, "references"),
		filepath.Join(dir, "skills", "handdraw-style-prompter", "references"),
	} {
		if st, err := os.Stat(filepath.Join(p, "styles.json")); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s has no references/styles.json", dir)
}

var upDirs = regexp.MustCompile(`^(\.\./)+`)

// normImage turns "../../../images/x.webp" into "images/x.webp".
func normImage(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = upDirs.ReplaceAllString(p, "")
	p = strings.TrimPrefix(p, "./")
	return p
}

func readJSON(path string, out any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

var groupRe = regexp.MustCompile(`^([A-Z]{2})\s+(.+?)\s*/\s*(.+)$`)
var langMarker = regexp.MustCompile(`<!--\s*(zh|en)\s*-->`)

// Load reads a pack directory.
func Load(dir string) (*Pack, error) {
	ref, err := refDir(dir)
	if err != nil {
		return nil, err
	}
	p := &Pack{Dir: dir, ImageRoot: dir, Aliases: map[string]string{}, Similar: map[string][]string{}}
	var manifest struct {
		Version string `json:"version"`
	}
	if readJSON(filepath.Join(dir, "manifest.json"), &manifest) == nil {
		p.Version = manifest.Version
	}
	if p.Version == "" {
		var v struct {
			Version string `json:"version"`
		}
		if readJSON(filepath.Join(ref, "version.json"), &v) == nil {
			p.Version = "skill-" + v.Version
		} else {
			p.Version = "dev"
		}
	}
	if err := readJSON(filepath.Join(ref, "styles.json"), &p.Styles); err != nil {
		return nil, fmt.Errorf("styles.json: %w", err)
	}
	_ = readJSON(filepath.Join(ref, "layouts.json"), &p.Layouts)
	_ = readJSON(filepath.Join(ref, "colors.json"), &p.Colors)
	_ = readJSON(filepath.Join(ref, "tones.json"), &p.Tones)
	_ = readJSON(filepath.Join(ref, "model_capabilities.json"), &p.Capabilities)
	var alias struct {
		LegacyToNew map[string]string `json:"legacy_to_new"`
	}
	if readJSON(filepath.Join(ref, "style_alias_map.json"), &alias) == nil && alias.LegacyToNew != nil {
		p.Aliases = alias.LegacyToNew
	}
	for _, name := range []string{filepath.Join(ref, "similarity.json"), filepath.Join(dir, "similarity.json")} {
		if b, err := os.ReadFile(name); err == nil {
			p.Similar = parseSimilarity(b)
			break
		}
	}
	for _, name := range []string{filepath.Join(ref, "prompt_rules.json"), filepath.Join(dir, "prompt_rules.json")} {
		if b, err := os.ReadFile(name); err == nil {
			p.Rules = b
			break
		}
	}
	for kind, file := range map[string]string{"character": "characters.json", "prop": "props.json", "scene": "scenes.json"} {
		var items []Asset
		if readJSON(filepath.Join(ref, file), &items) == nil {
			for _, it := range items {
				it.Kind = kind
				it.Image = normImage(it.Image)
				p.Assets = append(p.Assets, it)
			}
		}
	}
	sort.Slice(p.Assets, func(i, j int) bool { return p.Assets[i].ID < p.Assets[j].ID })

	// Skill checkouts keep images at <root>/images; packs at <dir>/images.
	if _, err := os.Stat(filepath.Join(dir, "images")); err != nil {
		if _, err := os.Stat(filepath.Join(ref, "..", "..", "..", "images")); err == nil {
			p.ImageRoot = filepath.Clean(filepath.Join(ref, "..", "..", ".."))
		}
	}

	groups := map[string]*Group{}
	var order []string
	for i := range p.Styles {
		s := &p.Styles[i]
		if s.Source == "" {
			s.Source = "official"
		}
		if m := groupRe.FindStringSubmatch(s.Group); m != nil {
			s.GroupCode, s.GroupZh, s.GroupEn = m[1], strings.TrimSpace(m[2]), strings.TrimSpace(m[3])
		} else if len(s.Number) >= 2 {
			s.GroupCode = s.Number[:2]
			s.GroupZh = s.Group
		}
		if s.Image == "" {
			s.Image = fmt.Sprintf("images/individual/%s/%s.webp", s.GroupCode, s.Number)
		}
		s.Image = normImage(s.Image)
		if s.Grid == "" {
			g := fmt.Sprintf("images/individual/%s/%s_grid.webp", s.GroupCode, s.Number)
			if _, err := os.Stat(filepath.Join(p.ImageRoot, filepath.FromSlash(g))); err == nil {
				s.Grid = g
			}
		}
		s.Grid = normImage(s.Grid)
		if _, ok := groups[s.GroupCode]; !ok {
			groups[s.GroupCode] = &Group{Code: s.GroupCode, Zh: s.GroupZh, En: s.GroupEn}
			order = append(order, s.GroupCode)
		}
		groups[s.GroupCode].Count++
	}
	sort.Strings(order)
	for _, c := range order {
		p.Groups = append(p.Groups, *groups[c])
	}

	skillRoot := filepath.Dir(ref)
	for i := range p.Layouts {
		l := &p.Layouts[i]
		l.ID = strings.ToUpper(l.ID)
		l.Image = normImage(l.Image)
		if l.Source == "" {
			l.Source = "official"
		}
		if l.PromptZh == "" && l.PromptFile != "" {
			for _, cand := range []string{filepath.Join(skillRoot, l.PromptFile), filepath.Join(dir, l.PromptFile), filepath.Join(ref, l.PromptFile), filepath.Join(ref, filepath.Base(l.PromptFile))} {
				if b, err := os.ReadFile(cand); err == nil {
					l.PromptZh, l.PromptEn = splitLangs(string(b))
					break
				}
			}
		}
	}
	for i := range p.Colors {
		p.Colors[i].Image = normImage(p.Colors[i].Image)
	}
	for i := range p.Tones {
		p.Tones[i].Image = normImage(p.Tones[i].Image)
	}
	p.reindex()
	return p, nil
}

// parseSimilarity accepts {"styles":{"FA-001":[{number,score}…]}} or {"FA-001":["FA-002",…]}.
func parseSimilarity(b []byte) map[string][]string {
	out := map[string][]string{}
	var wrapped struct {
		Styles map[string][]struct {
			Number string  `json:"number"`
			Score  float64 `json:"score"`
		} `json:"styles"`
	}
	if json.Unmarshal(b, &wrapped) == nil && len(wrapped.Styles) > 0 {
		for k, list := range wrapped.Styles {
			for _, it := range list {
				out[k] = append(out[k], it.Number)
			}
		}
		return out
	}
	_ = json.Unmarshal(b, &out)
	return out
}

func splitLangs(content string) (zh, en string) {
	parts := langMarker.FindAllStringSubmatchIndex(content, -1)
	for i, m := range parts {
		lang := content[m[2]:m[3]]
		end := len(content)
		if i+1 < len(parts) {
			end = parts[i+1][0]
		}
		text := strings.TrimSpace(content[m[1]:end])
		if lang == "zh" {
			zh = text
		} else {
			en = text
		}
	}
	return
}

func (p *Pack) reindex() {
	p.styleIdx = map[string]int{}
	for i, s := range p.Styles {
		p.styleIdx[s.Number] = i
	}
	p.layoutIdx = map[string]int{}
	for i, l := range p.Layouts {
		p.layoutIdx[l.ID] = i
	}
	p.colorIdx = map[string]int{}
	for i, c := range p.Colors {
		p.colorIdx[strings.ToUpper(c.ID)] = i
	}
	p.toneIdx = map[string]int{}
	for i, t := range p.Tones {
		p.toneIdx[strings.ToUpper(t.ID)] = i
	}
}

// WithCustom returns a copy of the pack that also contains the user's styles
// and layouts, so every lookup treats them like official ones.
func (p *Pack) WithCustom(styles []Style, layouts []Layout) *Pack {
	cp := *p
	cp.Styles = append(append([]Style{}, p.Styles...), styles...)
	cp.Layouts = append(append([]Layout{}, p.Layouts...), layouts...)
	cp.reindex()
	return &cp
}

var styleIDRe = regexp.MustCompile(`^([A-Za-z]{2})[-_]?(\d+)$`)
var layoutAliases = map[string]string{"IG-036": "IP-002", "SC-023": "IP-001"}

// CanonicalStyle normalizes "fa-1", "FA_001", legacy "240" to "FA-001".
func (p *Pack) CanonicalStyle(id string) string {
	raw := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(id), "#"))
	if raw == "" {
		return ""
	}
	if isDigits(raw) {
		n := pad3(raw)
		if c, ok := p.Aliases[n]; ok {
			return c
		}
		return n
	}
	if m := styleIDRe.FindStringSubmatch(raw); m != nil {
		return strings.ToUpper(m[1]) + "-" + pad3(m[2])
	}
	return strings.ToUpper(raw)
}

func pad3(s string) string {
	s = strings.TrimLeft(s, "0")
	if s == "" {
		s = "0"
	}
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

func (p *Pack) Style(id string) (Style, bool) {
	if i, ok := p.styleIdx[id]; ok {
		return p.Styles[i], true
	}
	c := p.CanonicalStyle(id)
	if i, ok := p.styleIdx[c]; ok {
		return p.Styles[i], true
	}
	if a, ok := p.Aliases[c]; ok {
		if i, ok := p.styleIdx[a]; ok {
			return p.Styles[i], true
		}
	}
	return Style{}, false
}

func (p *Pack) Layout(id string) (Layout, bool) {
	n := strings.ToUpper(strings.TrimSpace(id))
	if a, ok := layoutAliases[n]; ok {
		n = a
	}
	if i, ok := p.layoutIdx[n]; ok {
		return p.Layouts[i], true
	}
	return Layout{}, false
}

func (p *Pack) Color(id string) (Color, bool) {
	if i, ok := p.colorIdx[strings.ToUpper(strings.TrimSpace(id))]; ok {
		return p.Colors[i], true
	}
	return Color{}, false
}

func (p *Pack) Tone(id string) (Tone, bool) {
	if i, ok := p.toneIdx[strings.ToUpper(strings.TrimSpace(id))]; ok {
		return p.Tones[i], true
	}
	return Tone{}, false
}

// ImagePath maps a pack-relative image path to a file, refusing escapes.
func (p *Pack) ImagePath(rel string) (string, bool) {
	rel = normImage(rel)
	if rel == "" || strings.Contains(rel, "..") || !strings.HasPrefix(rel, "images/") {
		return "", false
	}
	full := filepath.Join(p.ImageRoot, filepath.FromSlash(rel))
	if st, err := os.Stat(full); err != nil || st.IsDir() {
		return "", false
	}
	return full, true
}

// SimilarStyles returns precomputed neighbours, or a trait-overlap fallback.
func (p *Pack) SimilarStyles(id string, n int) []Style {
	s, ok := p.Style(id)
	if !ok {
		return nil
	}
	out := []Style{}
	if ids, ok := p.Similar[s.Number]; ok && len(ids) > 0 {
		for _, sid := range ids {
			if t, ok := p.Style(sid); ok && t.Number != s.Number {
				out = append(out, t)
			}
			if len(out) >= n {
				break
			}
		}
		return out
	}
	return p.rankByText(s.Traits+" "+s.GenerationName+" "+s.Group, n, s.Number)
}

// rankByText scores styles by character bigram overlap (works for zh and en).
func (p *Pack) rankByText(text string, n int, exclude string) []Style {
	q := grams(text)
	type sc struct {
		s     Style
		score float64
	}
	var all []sc
	for _, t := range p.Styles {
		if t.Number == exclude {
			continue
		}
		g := grams(t.Traits + " " + t.GenerationName + " " + t.Group + " " + t.Reference)
		var hit float64
		for k := range q {
			if g[k] {
				hit++
			}
		}
		if hit == 0 {
			continue
		}
		all = append(all, sc{t, hit / float64(len(g)+len(q))})
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].score > all[j].score })
	out := []Style{}
	for i := 0; i < len(all) && i < n; i++ {
		out = append(out, all[i].s)
	}
	return out
}

// SearchStyles finds styles by free text (used by "find style from image" after traits are extracted).
func (p *Pack) SearchStyles(text string, n int) []Style { return p.rankByText(text, n, "") }

func grams(s string) map[string]bool {
	s = strings.ToLower(s)
	r := []rune(s)
	out := map[string]bool{}
	for i := 0; i+1 < len(r); i++ {
		if r[i] == ' ' || r[i+1] == ' ' || isPunct(r[i]) || isPunct(r[i+1]) {
			continue
		}
		out[string(r[i:i+2])] = true
	}
	return out
}

func isPunct(r rune) bool {
	return strings.ContainsRune("，,。.；;、：:（）()「」/\\-—!！?？\"'“”‘’", r)
}
