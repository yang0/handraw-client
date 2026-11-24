// Package galleries provides an extensible, schema-open Gallery Registry for
// Handraw (#48). It unifies built-in resource pack catalogs (styles, layouts,
// colors, tones, characters, props, scenes), declarative pack/user gallery JSON
// files (e.g. hairstyles.json, poses.json), and runtime plugin-contributed
// galleries under one consistent discovery and query contract.
package galleries

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/resources"
)

var validKindRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)

type Category struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	NameEn string `json:"nameEn,omitempty"`
	Count  int    `json:"count"`
}

type Variant struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	LabelEn     string `json:"labelEn,omitempty"`
	Image       string `json:"image,omitempty"`
	Thumb       string `json:"thumb,omitempty"`
	RemoteImage string `json:"remoteImage,omitempty"`
	RemoteThumb string `json:"remoteThumb,omitempty"`
	ImageURL    string `json:"imageUrl,omitempty"`
	ThumbURL    string `json:"thumbUrl,omitempty"`
	ImagePath   string `json:"-"`
	ThumbPath   string `json:"-"`
}

type Meta struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	NameEn           string     `json:"nameEn,omitempty"`
	Description      string     `json:"description,omitempty"`
	Icon             string     `json:"icon,omitempty"`
	Source           string     `json:"source"` // official | pack | personal | third-party | plugin:<id>
	PromptRole       string     `json:"promptRole,omitempty"`
	SupportsRefImage bool       `json:"supportsRefImage"`
	Builtin          bool       `json:"builtin"`
	LocalOnly        bool       `json:"localOnly,omitempty"`
	MultiVariant     bool       `json:"multiVariant,omitempty"`
	UpstreamURL      string     `json:"upstreamUrl,omitempty"`
	Mirror           string     `json:"mirror,omitempty"`
	License          string     `json:"license,omitempty"`
	Count            int        `json:"count"`
	Categories       []Category `json:"categories,omitempty"`
}

type Item struct {
	ID           string         `json:"id"`
	Kind         string         `json:"kind"`
	Name         string         `json:"name"`
	NameEn       string         `json:"nameEn,omitempty"`
	Category     string         `json:"category,omitempty"`
	CategoryName string         `json:"categoryName,omitempty"`
	Tags         []string       `json:"tags,omitempty"`
	Traits       string         `json:"traits,omitempty"`
	PromptZh     string         `json:"promptZh,omitempty"`
	PromptEn     string         `json:"promptEn,omitempty"`
	Image        string         `json:"image,omitempty"`
	Thumb        string         `json:"thumb,omitempty"`
	RemoteImage  string         `json:"remoteImage,omitempty"`
	RemoteThumb  string         `json:"remoteThumb,omitempty"`
	ImageURL     string         `json:"imageUrl,omitempty"`
	ThumbURL     string         `json:"thumbUrl,omitempty"`
	Variants     []Variant      `json:"variants,omitempty"`
	Source       string         `json:"source,omitempty"`
	Author       string         `json:"author,omitempty"`
	Meta         map[string]any `json:"meta,omitempty"`
	ImagePath    string         `json:"-"`
	ThumbPath    string         `json:"-"`
	ImageRoot    string         `json:"-"`
}

type Query struct {
	Q        string
	Category string
	Source   string
	Series   string
	Limit    int
	Offset   int
}

// Registration describes a declarative or plugin-contributed gallery.
type Registration struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	NameEn           string `json:"nameEn,omitempty"`
	Description      string `json:"description,omitempty"`
	Icon             string `json:"icon,omitempty"`
	Source           string `json:"source,omitempty"`
	Owner            string `json:"-"` // plugin id when dynamically registered
	PromptRole       string `json:"promptRole,omitempty"`
	SupportsRefImage *bool  `json:"supportsRefImage,omitempty"`
	LocalOnly        bool   `json:"localOnly,omitempty"`
	MultiVariant     bool   `json:"multiVariant,omitempty"`
	UpstreamURL      string `json:"upstreamUrl,omitempty"`
	Mirror           string `json:"mirror,omitempty"`
	License          string `json:"license,omitempty"`
	ImageRoot        string `json:"-"`
	Items            []Item `json:"items"`
}

type galleryEntry struct {
	meta  Meta
	owner string
	items []Item
}

type cachedFileEntry struct {
	modTime time.Time
	size    int64
	entry   galleryEntry
}

type Registry struct {
	mu        sync.RWMutex
	dynamic   map[string]galleryEntry
	order     []string
	fileCache map[string]cachedFileEntry
	OnChange  func()
}

func New() *Registry {
	return &Registry{
		dynamic:   map[string]galleryEntry{},
		fileCache: map[string]cachedFileEntry{},
	}
}

func ValidKind(kind string) bool {
	return validKindRe.MatchString(kind)
}

func itemImageURL(kind, id string) string {
	return "/api/galleries/" + url.PathEscape(kind) + "/items/" + url.PathEscape(id) + "/image"
}

func itemVariantImageURL(kind, id, variant string, thumb bool) string {
	base := itemImageURL(kind, id)
	q := url.Values{}
	if variant != "" {
		q.Set("variant", variant)
	}
	if thumb {
		q.Set("size", "thumb")
	}
	if len(q) == 0 {
		return base
	}
	return base + "?" + q.Encode()
}

// Register adds or updates a runtime gallery (e.g., contributed by a plugin).
func (r *Registry) Register(reg Registration) error {
	kind := strings.ToLower(strings.TrimSpace(reg.ID))
	if !ValidKind(kind) {
		return fmt.Errorf("画廊标识 %q 无效（仅允许小写字母、数字、短横线、下划线）", reg.ID)
	}
	if isCoreBuiltinKind(kind) {
		return fmt.Errorf("画廊标识 %q 为系统内置画廊，不能覆盖", kind)
	}
	entry := buildEntry(kind, reg, false)
	r.mu.Lock()
	if _, exists := r.dynamic[kind]; !exists {
		r.order = append(r.order, kind)
	}
	r.dynamic[kind] = entry
	cb := r.OnChange
	r.mu.Unlock()
	if cb != nil {
		cb()
	}
	return nil
}

// Unregister removes a runtime gallery. If owner is non-empty, only removes
// galleries registered by that owner.
func (r *Registry) Unregister(kind, owner string) bool {
	kind = strings.ToLower(strings.TrimSpace(kind))
	r.mu.Lock()
	cur, ok := r.dynamic[kind]
	if !ok || (owner != "" && cur.owner != owner) {
		r.mu.Unlock()
		return false
	}
	delete(r.dynamic, kind)
	next := r.order[:0]
	for _, k := range r.order {
		if k != kind {
			next = append(next, k)
		}
	}
	r.order = next
	cb := r.OnChange
	r.mu.Unlock()
	if cb != nil {
		cb()
	}
	return true
}

// UnregisterByOwner removes all runtime galleries owned by a plugin.
func (r *Registry) UnregisterByOwner(owner string) int {
	if owner == "" {
		return 0
	}
	r.mu.Lock()
	removed := 0
	next := r.order[:0]
	for _, k := range r.order {
		if cur, ok := r.dynamic[k]; ok && cur.owner == owner {
			delete(r.dynamic, k)
			removed++
			continue
		}
		next = append(next, k)
	}
	r.order = next
	cb := r.OnChange
	r.mu.Unlock()
	if removed > 0 && cb != nil {
		cb()
	}
	return removed
}

func isCoreBuiltinKind(kind string) bool {
	switch kind {
	case "styles", "layouts", "colors", "tones", "characters", "props", "scenes":
		return true
	}
	return false
}

// List returns metadata for every available gallery: built-in pack galleries,
// declarative galleries discovered from JSON files, and runtime plugin galleries.
func (r *Registry) List(pack *resources.Pack, extraDirs ...string) []Meta {
	all := r.snapshot(pack, extraDirs...)
	out := make([]Meta, 0, len(all))
	for _, e := range all {
		out = append(out, e.meta)
	}
	return out
}

// Items queries items from a gallery kind with optional text search, category,
// source filter, and pagination.
func (r *Registry) Items(pack *resources.Pack, kind string, q Query, extraDirs ...string) ([]Item, int, bool) {
	entry, ok := r.findEntry(pack, kind, extraDirs...)
	if !ok {
		return nil, 0, false
	}
	qStr := strings.ToLower(strings.TrimSpace(q.Q))
	cat := strings.TrimSpace(q.Category)
	src := strings.TrimSpace(q.Source)
	series := strings.TrimSpace(q.Series)

	matched := make([]Item, 0, len(entry.items))
	for _, it := range entry.items {
		if cat != "" && !strings.EqualFold(it.Category, cat) {
			continue
		}
		if src != "" && !strings.EqualFold(it.Source, src) {
			continue
		}
		if series != "" {
			itSeries, _ := it.Meta["series"].(string)
			if !strings.EqualFold(strings.TrimSpace(itSeries), series) {
				continue
			}
		}
		if qStr != "" && !itemMatches(it, qStr) {
			continue
		}
		matched = append(matched, it)
	}
	total := len(matched)
	offset := q.Offset
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return []Item{}, total, true
	}
	end := total
	if q.Limit > 0 && offset+q.Limit < end {
		end = offset + q.Limit
	}
	return matched[offset:end], total, true
}

// Item looks up a single item by gallery kind and ID.
func (r *Registry) Item(pack *resources.Pack, kind, id string, extraDirs ...string) (Item, bool) {
	entry, ok := r.findEntry(pack, kind, extraDirs...)
	if !ok {
		return Item{}, false
	}
	want := strings.TrimSpace(id)
	for _, it := range entry.items {
		if strings.EqualFold(it.ID, want) {
			return it, true
		}
	}
	return Item{}, false
}

// ImageTarget describes where a gallery item's image lives locally (or should
// be cached on disk) and what upstream URL(s) can supply it on demand.
type ImageTarget struct {
	LocalPath  string   // non-empty if already present on disk
	CachePath  string   // verified target path inside gallery ImageRoot for on-demand caching
	RemoteURLs []string // ordered upstream URLs (e.g., Gitee mirror -> GitHub fallback)
}

// ResolveImage returns a verified local file path for a gallery item's image.
func (r *Registry) ResolveImage(pack *resources.Pack, kind, id string, extraDirs ...string) (string, bool) {
	t, ok := r.ResolveImageTarget(pack, kind, id, "", false, extraDirs...)
	if !ok || t.LocalPath == "" {
		return "", false
	}
	return t.LocalPath, true
}

// ResolveImageTarget resolves an item (and optional variant key + thumb/full)
// to an existing local file or an on-demand cache target + upstream remote URLs.
func (r *Registry) ResolveImageTarget(pack *resources.Pack, kind, id, variantKey string, wantThumb bool, extraDirs ...string) (ImageTarget, bool) {
	it, ok := r.Item(pack, kind, id, extraDirs...)
	if !ok {
		return ImageTarget{}, false
	}

	relLocal := it.Image
	existingPath := it.ImagePath
	primaryRemote := it.RemoteImage
	fallbackRemote := it.RemoteThumb
	if wantThumb {
		if it.Thumb != "" {
			relLocal = it.Thumb
		}
		if it.ThumbPath != "" {
			existingPath = it.ThumbPath
		}
		if it.RemoteThumb != "" {
			primaryRemote = it.RemoteThumb
			fallbackRemote = it.RemoteImage
		}
	}

	if len(it.Variants) > 0 {
		var chosen *Variant
		vWant := strings.TrimSpace(variantKey)
		if vWant != "" {
			for i := range it.Variants {
				if strings.EqualFold(it.Variants[i].Key, vWant) {
					chosen = &it.Variants[i]
					break
				}
			}
		}
		if chosen == nil {
			chosen = &it.Variants[0]
		}
		if wantThumb {
			relLocal = firstNonEmpty(chosen.Thumb, chosen.Image, relLocal)
			existingPath = firstNonEmpty(chosen.ThumbPath, chosen.ImagePath)
			primaryRemote = firstNonEmpty(chosen.RemoteThumb, chosen.RemoteImage)
			fallbackRemote = chosen.RemoteImage
		} else {
			relLocal = firstNonEmpty(chosen.Image, chosen.Thumb, relLocal)
			existingPath = firstNonEmpty(chosen.ImagePath, chosen.ThumbPath)
			primaryRemote = firstNonEmpty(chosen.RemoteImage, chosen.RemoteThumb)
			fallbackRemote = chosen.RemoteThumb
		}
	}

	var out ImageTarget
	if existingPath != "" {
		if st, err := os.Stat(existingPath); err == nil && !st.IsDir() {
			out.LocalPath = existingPath
		}
	}
	if out.LocalPath == "" && it.ImageRoot != "" && relLocal != "" {
		if p := resolveSafeTarget(it.ImageRoot, relLocal); p != "" {
			out.CachePath = p
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				out.LocalPath = p
			}
		}
	}

	addRemote := func(u string) {
		u = strings.TrimSpace(u)
		if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			return
		}
		for _, prev := range out.RemoteURLs {
			if prev == u {
				return
			}
		}
		out.RemoteURLs = append(out.RemoteURLs, u)
	}
	addRemote(primaryRemote)
	for _, alt := range mirrorFallbacks(primaryRemote) {
		addRemote(alt)
	}
	addRemote(fallbackRemote)
	for _, alt := range mirrorFallbacks(fallbackRemote) {
		addRemote(alt)
	}

	if out.LocalPath == "" && len(out.RemoteURLs) == 0 {
		return ImageTarget{}, false
	}
	return out, true
}

func (r *Registry) findEntry(pack *resources.Pack, kind string, extraDirs ...string) (galleryEntry, bool) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	for _, e := range r.snapshot(pack, extraDirs...) {
		if e.meta.ID == kind {
			return e, true
		}
	}
	return galleryEntry{}, false
}

func (r *Registry) snapshot(pack *resources.Pack, extraDirs ...string) []galleryEntry {
	var out []galleryEntry
	seen := map[string]int{}
	add := func(e galleryEntry) {
		if idx, ok := seen[e.meta.ID]; ok {
			// Merge items for same gallery kind from additional directories (e.g. personal additions).
			merged := mergeEntries(out[idx], e)
			out[idx] = merged
			return
		}
		seen[e.meta.ID] = len(out)
		out = append(out, e)
	}

	// 1. Built-in galleries derived from the loaded resource pack.
	if pack != nil {
		for _, e := range builtinEntries(pack) {
			add(e)
		}
		// 2. Declarative extension galleries in <packDir>/references/galleries/*.json.
		packGalDir := filepath.Join(pack.Dir, "references", "galleries")
		for _, e := range r.loadDirGalleries(packGalDir, pack.ImageRoot, "official") {
			add(e)
		}
	}

	// 3. Extra local gallery directories (e.g., <userDataDir>/galleries/*.json).
	for _, dir := range extraDirs {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		for _, e := range r.loadDirGalleries(dir, dir, "personal") {
			add(e)
		}
	}

	// 4. Runtime plugin-registered galleries.
	r.mu.RLock()
	for _, k := range r.order {
		if e, ok := r.dynamic[k]; ok {
			add(e)
		}
	}
	r.mu.RUnlock()

	return out
}

func mergeEntries(base, extra galleryEntry) galleryEntry {
	existing := map[string]bool{}
	for _, it := range base.items {
		existing[strings.ToLower(it.ID)] = true
	}
	items := append([]Item{}, base.items...)
	for _, it := range extra.items {
		if !existing[strings.ToLower(it.ID)] {
			items = append(items, it)
			existing[strings.ToLower(it.ID)] = true
		}
	}
	base.items = items
	base.meta.Count = len(items)
	base.meta.Categories = computeCategories(items)
	return base
}

func builtinEntries(p *resources.Pack) []galleryEntry {
	var out []galleryEntry

	// styles
	styles := make([]Item, 0, len(p.Styles))
	for _, s := range p.Styles {
		name := firstNonEmpty(s.NameZh, s.GenerationName, s.Number)
		imgPath := resolvePackImage(p, s.Image)
		it := Item{
			ID:           s.Number,
			Kind:         "styles",
			Name:         name,
			NameEn:       s.GenerationName,
			Category:     s.GroupCode,
			CategoryName: firstNonEmpty(s.GroupZh, s.Group, s.GroupCode),
			Tags:         s.Tags,
			Traits:       s.Traits,
			PromptZh:     s.Traits,
			PromptEn:     s.TraitsEn,
			Image:        s.Image,
			Source:       firstNonEmpty(s.Source, "official"),
			Author:       s.Author,
			ImagePath:    imgPath,
			Meta: map[string]any{
				"reference": s.Reference,
				"group":     s.Group,
				"groupEn":   s.GroupEn,
				"license":   s.License,
			},
		}
		if imgPath != "" {
			it.ImageURL = itemImageURL("styles", it.ID)
			it.ThumbURL = it.ImageURL
		}
		styles = append(styles, it)
	}
	out = append(out, galleryEntry{
		meta: Meta{
			ID: "styles", Name: "画风", NameEn: "Styles", Description: "手绘与插画视觉风格",
			Source: "official", PromptRole: "style", SupportsRefImage: true, Builtin: true,
			Count: len(styles), Categories: computeCategories(styles),
		},
		items: styles,
	})

	// layouts
	layouts := make([]Item, 0, len(p.Layouts))
	layoutCatNames := map[string]string{
		"social-card": "社媒卡片", "infographic": "信息图", "comic-storyboard": "漫画分镜",
		"ip-character": "角色设计", "ecommerce": "电商图型",
	}
	for _, l := range p.Layouts {
		imgPath := resolvePackImage(p, l.Image)
		it := Item{
			ID:           l.ID,
			Kind:         "layouts",
			Name:         firstNonEmpty(l.Name, l.ID),
			NameEn:       l.NameEn,
			Category:     l.Category,
			CategoryName: firstNonEmpty(layoutCatNames[l.Category], l.Category),
			Tags:         l.Keywords,
			PromptZh:     l.PromptZh,
			PromptEn:     l.PromptEn,
			Image:        l.Image,
			Source:       firstNonEmpty(l.Source, "official"),
			ImagePath:    imgPath,
		}
		if imgPath != "" {
			it.ImageURL = itemImageURL("layouts", it.ID)
			it.ThumbURL = it.ImageURL
		}
		layouts = append(layouts, it)
	}
	out = append(out, galleryEntry{
		meta: Meta{
			ID: "layouts", Name: "图型", NameEn: "Layouts", Description: "版式与构图图型",
			Source: "official", PromptRole: "layout", SupportsRefImage: true, Builtin: true,
			Count: len(layouts), Categories: computeCategories(layouts),
		},
		items: layouts,
	})

	// colors
	colors := make([]Item, 0, len(p.Colors))
	for _, c := range p.Colors {
		imgPath := resolvePackImage(p, c.Image)
		it := Item{
			ID:           c.ID,
			Kind:         "colors",
			Name:         firstNonEmpty(c.NameZh, c.NameEn, c.ID),
			NameEn:       c.NameEn,
			Category:     c.Category,
			CategoryName: firstNonEmpty(c.CategoryZh, c.Category),
			Traits:       c.QuoteZh,
			PromptZh:     c.PromptZh,
			PromptEn:     c.PromptEn,
			Image:        c.Image,
			Source:       "official",
			ImagePath:    imgPath,
			Meta: map[string]any{
				"hex":     c.Hex,
				"quoteEn": c.QuoteEn,
			},
		}
		if imgPath != "" {
			it.ImageURL = itemImageURL("colors", it.ID)
			it.ThumbURL = it.ImageURL
		}
		colors = append(colors, it)
	}
	out = append(out, galleryEntry{
		meta: Meta{
			ID: "colors", Name: "主题色", NameEn: "Colors", Description: "经典单色主题色库",
			Source: "official", PromptRole: "color", SupportsRefImage: false, Builtin: true,
			Count: len(colors), Categories: computeCategories(colors),
		},
		items: colors,
	})

	// tones
	tones := make([]Item, 0, len(p.Tones))
	for _, t := range p.Tones {
		imgPath := resolvePackImage(p, t.Image)
		it := Item{
			ID:           t.ID,
			Kind:         "tones",
			Name:         firstNonEmpty(t.NameZh, t.NameEn, t.ID),
			NameEn:       t.NameEn,
			Category:     t.Category,
			CategoryName: firstNonEmpty(t.CategoryZh, t.Category),
			Traits:       t.DescZh,
			PromptZh:     t.DescZh,
			PromptEn:     t.DescEn,
			Image:        t.Image,
			Source:       "official",
			ImagePath:    imgPath,
		}
		if imgPath != "" {
			it.ImageURL = itemImageURL("tones", it.ID)
			it.ThumbURL = it.ImageURL
		}
		tones = append(tones, it)
	}
	out = append(out, galleryEntry{
		meta: Meta{
			ID: "tones", Name: "影调", NameEn: "Tones", Description: "画面光影与影调氛围",
			Source: "official", PromptRole: "tone", SupportsRefImage: false, Builtin: true,
			Count: len(tones), Categories: computeCategories(tones),
		},
		items: tones,
	})

	// assets split into characters / props / scenes if present
	assetGroups := map[string][]Item{"characters": {}, "props": {}, "scenes": {}}
	for _, a := range p.Assets {
		kind := "characters"
		switch strings.ToLower(a.Kind) {
		case "prop", "props":
			kind = "props"
		case "scene", "scenes":
			kind = "scenes"
		}
		imgPath := resolvePackImage(p, a.Image)
		it := Item{
			ID:        a.ID,
			Kind:      kind,
			Name:      firstNonEmpty(a.Name, a.NameEn, a.ID),
			NameEn:    a.NameEn,
			Category:  a.Kind,
			Tags:      a.Tags,
			Image:     a.Image,
			Source:    "official",
			ImagePath: imgPath,
		}
		if imgPath != "" {
			it.ImageURL = itemImageURL(kind, it.ID)
			it.ThumbURL = it.ImageURL
		}
		assetGroups[kind] = append(assetGroups[kind], it)
	}
	for _, spec := range []struct {
		id, name, nameEn string
	}{
		{"characters", "角色", "Characters"},
		{"props", "道具", "Props"},
		{"scenes", "场景", "Scenes"},
	} {
		items := assetGroups[spec.id]
		out = append(out, galleryEntry{
			meta: Meta{
				ID: spec.id, Name: spec.name, NameEn: spec.nameEn,
				Source: "official", PromptRole: "asset", SupportsRefImage: true, Builtin: true,
				Count: len(items), Categories: computeCategories(items),
			},
			items: items,
		})
	}
	return out
}

func (r *Registry) loadDirGalleries(dir, imageRoot, defaultSource string) []galleryEntry {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []galleryEntry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		fullPath := filepath.Join(dir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		if r != nil {
			r.mu.RLock()
			cached, ok := r.fileCache[fullPath]
			r.mu.RUnlock()
			if ok && cached.size == info.Size() && cached.modTime.Equal(info.ModTime()) {
				out = append(out, cached.entry)
				continue
			}
		}
		raw, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}
		var reg Registration
		if err := json.Unmarshal(raw, &reg); err != nil {
			continue
		}
		if reg.ID == "" {
			reg.ID = strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		}
		kind := strings.ToLower(strings.TrimSpace(reg.ID))
		if !ValidKind(kind) {
			continue
		}
		if reg.Source == "" {
			reg.Source = defaultSource
		}
		reg.ImageRoot = imageRoot
		built := buildEntry(kind, reg, false)
		if r != nil {
			r.mu.Lock()
			if r.fileCache == nil {
				r.fileCache = map[string]cachedFileEntry{}
			}
			r.fileCache[fullPath] = cachedFileEntry{modTime: info.ModTime(), size: info.Size(), entry: built}
			r.mu.Unlock()
		}
		out = append(out, built)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].meta.ID < out[j].meta.ID })
	return out
}

func buildEntry(kind string, reg Registration, builtin bool) galleryEntry {
	supportsRef := true
	if reg.SupportsRefImage != nil {
		supportsRef = *reg.SupportsRefImage
	}
	src := firstNonEmpty(reg.Source, "official")
	if reg.Owner != "" && reg.Source == "" {
		src = "plugin:" + reg.Owner
	}
	hasAnyVariants := reg.MultiVariant
	items := make([]Item, 0, len(reg.Items))
	for _, raw := range reg.Items {
		it := raw
		it.ID = strings.TrimSpace(it.ID)
		if it.ID == "" {
			continue
		}
		it.Kind = kind
		it.ImageRoot = reg.ImageRoot
		if it.Name == "" {
			it.Name = firstNonEmpty(it.NameEn, it.ID)
		}
		if it.Source == "" {
			it.Source = src
		}
		if it.ImagePath == "" && it.Image != "" {
			it.ImagePath = resolveSafeImage(reg.ImageRoot, it.Image)
		}
		if it.ThumbPath == "" && it.Thumb != "" {
			it.ThumbPath = resolveSafeImage(reg.ImageRoot, it.Thumb)
		}
		if len(it.Variants) > 0 {
			hasAnyVariants = true
			vars := make([]Variant, 0, len(it.Variants))
			for _, v := range it.Variants {
				v.Key = strings.TrimSpace(v.Key)
				if v.Key == "" {
					continue
				}
				if v.Label == "" {
					v.Label = firstNonEmpty(v.LabelEn, v.Key)
				}
				if v.ImagePath == "" && v.Image != "" {
					v.ImagePath = resolveSafeImage(reg.ImageRoot, v.Image)
				}
				if v.ThumbPath == "" && v.Thumb != "" {
					v.ThumbPath = resolveSafeImage(reg.ImageRoot, v.Thumb)
				}
				if v.ImagePath != "" || v.RemoteImage != "" || v.ThumbPath != "" || v.RemoteThumb != "" {
					v.ImageURL = itemVariantImageURL(kind, it.ID, v.Key, false)
					v.ThumbURL = itemVariantImageURL(kind, it.ID, v.Key, true)
				}
				vars = append(vars, v)
			}
			it.Variants = vars
			if len(vars) > 0 {
				if it.ImageURL == "" {
					it.ImageURL = vars[0].ImageURL
				}
				if it.ThumbURL == "" {
					it.ThumbURL = vars[0].ThumbURL
				}
				if it.ImagePath == "" {
					it.ImagePath = vars[0].ImagePath
				}
			}
		} else {
			if it.ImagePath != "" || it.RemoteImage != "" || it.ThumbPath != "" || it.RemoteThumb != "" {
				it.ImageURL = itemImageURL(kind, it.ID)
				if it.Thumb != "" || it.RemoteThumb != "" {
					it.ThumbURL = itemVariantImageURL(kind, it.ID, "", true)
				} else {
					it.ThumbURL = it.ImageURL
				}
			}
		}
		items = append(items, it)
	}
	return galleryEntry{
		owner: reg.Owner,
		meta: Meta{
			ID:               kind,
			Name:             firstNonEmpty(reg.Name, kind),
			NameEn:           reg.NameEn,
			Description:      reg.Description,
			Icon:             reg.Icon,
			Source:           src,
			PromptRole:       firstNonEmpty(reg.PromptRole, "custom"),
			SupportsRefImage: supportsRef,
			Builtin:          builtin,
			LocalOnly:        reg.LocalOnly,
			MultiVariant:     hasAnyVariants,
			UpstreamURL:      reg.UpstreamURL,
			Mirror:           reg.Mirror,
			License:          reg.License,
			Count:            len(items),
			Categories:       computeCategories(items),
		},
		items: items,
	}
}

func resolvePackImage(p *resources.Pack, rel string) string {
	if p == nil || rel == "" {
		return ""
	}
	if filepath.IsAbs(rel) {
		if _, err := os.Stat(rel); err == nil {
			return rel
		}
		return ""
	}
	if full, ok := p.ImagePath(rel); ok {
		return full
	}
	return ""
}

func resolveSafeImage(root, rel string) string {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return ""
	}
	if root == "" {
		return ""
	}
	if filepath.IsAbs(rel) {
		cleanRoot, err1 := filepath.Abs(root)
		cleanRel, err2 := filepath.Abs(rel)
		if err1 != nil || err2 != nil {
			return ""
		}
		if !isWithin(cleanRoot, cleanRel) {
			return ""
		}
		if st, err := os.Stat(cleanRel); err == nil && !st.IsDir() {
			return cleanRel
		}
		return ""
	}
	if strings.Contains(rel, "..") {
		return ""
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return ""
	}
	candidate := filepath.Join(cleanRoot, filepath.FromSlash(rel))
	if !isWithin(cleanRoot, candidate) {
		return ""
	}
	if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
		return candidate
	}
	return ""
}

// resolveSafeTarget resolves a relative path inside root without requiring the
// file to exist yet (used as the on-demand cache target path).
func resolveSafeTarget(root, rel string) string {
	rel = strings.TrimSpace(rel)
	if rel == "" || root == "" || filepath.IsAbs(rel) || strings.Contains(rel, "..") {
		return ""
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return ""
	}
	candidate := filepath.Join(cleanRoot, filepath.FromSlash(rel))
	if !isWithin(cleanRoot, candidate) {
		return ""
	}
	return candidate
}

// mirrorFallbacks maps between Gitee mirror and GitHub raw URLs for RuiC-PoseAtlas
// so on-demand image caching automatically falls back if one mirror is unreachable.
func mirrorFallbacks(rawURL string) []string {
	const (
		giteePrefix  = "https://gitee.com/mingtian2018/RuiC-PoseAtlas/raw/main/"
		githubPrefix = "https://raw.githubusercontent.com/HRuiCcc/RuiC-PoseAtlas/main/"
	)
	if strings.HasPrefix(rawURL, giteePrefix) {
		return []string{githubPrefix + strings.TrimPrefix(rawURL, giteePrefix)}
	}
	if strings.HasPrefix(rawURL, githubPrefix) {
		return []string{giteePrefix + strings.TrimPrefix(rawURL, githubPrefix)}
	}
	return nil
}

func isWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func computeCategories(items []Item) []Category {
	order := []string{}
	byID := map[string]*Category{}
	for _, it := range items {
		id := strings.TrimSpace(it.Category)
		if id == "" {
			continue
		}
		c, ok := byID[id]
		if !ok {
			c = &Category{ID: id, Name: firstNonEmpty(it.CategoryName, id)}
			byID[id] = c
			order = append(order, id)
		}
		c.Count++
	}
	out := make([]Category, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out
}

func itemMatches(it Item, q string) bool {
	for _, field := range []string{it.ID, it.Name, it.NameEn, it.Category, it.CategoryName, it.Traits, it.PromptZh, it.PromptEn, it.Author} {
		if strings.Contains(strings.ToLower(field), q) {
			return true
		}
	}
	for _, tag := range it.Tags {
		if strings.Contains(strings.ToLower(tag), q) {
			return true
		}
	}
	return false
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

var ErrNotFound = errors.New("not found")
