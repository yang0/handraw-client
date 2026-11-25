package server

import (
	"math/rand"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/yang0/handraw-client/internal/resources"
)

func (s *Server) pack() (*resources.Pack, error) {
	p := s.Pack()
	if p == nil {
		return nil, &apiError{Status: 503, Msg: "资源包未加载"}
	}
	return p, nil
}

func (s *Server) resSummary(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	layoutCats := map[string]int{}
	for _, l := range p.Layouts {
		layoutCats[l.Category]++
	}
	colorCats := map[string]string{}
	for _, c := range p.Colors {
		colorCats[c.Category] = c.CategoryZh
	}
	toneCats := map[string]string{}
	for _, t := range p.Tones {
		toneCats[t.Category] = t.CategoryZh
	}
	snap := s.communityCatalog(r.Context(), false)
	groups := append([]resources.Group{}, p.Groups...)
	if len(snap.Styles) > 0 {
		hasUSR := false
		for i := range groups {
			if groups[i].Code == "USR" {
				groups[i].Count += len(snap.Styles)
				hasUSR = true
				break
			}
		}
		if !hasUSR {
			groups = append([]resources.Group{{
				Code:  "USR",
				Zh:    "社区共享",
				En:    "Community",
				Count: len(snap.Styles),
			}}, groups...)
		}
	}
	if len(snap.Layouts) > 0 {
		layoutCats["community"] += len(snap.Layouts)
	}
	return map[string]any{
		"version": p.Version, "groups": groups, "layoutCategories": layoutCats,
		"colorCategories": colorCats, "toneCategories": toneCats,
		"counts": map[string]int{
			"styles":  len(p.Styles) + len(snap.Styles),
			"layouts": len(p.Layouts) + len(snap.Layouts),
			"colors":  len(p.Colors),
			"tones":   len(p.Tones),
			"assets":  len(p.Assets),
		},
	}, nil
}

func match(q string, fields ...string) bool {
	if q == "" {
		return true
	}
	q = strings.ToLower(q)
	for _, f := range fields {
		if strings.Contains(strings.ToLower(f), q) {
			return true
		}
	}
	return false
}

func (s *Server) resStyles(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	group := r.URL.Query().Get("group")
	source := r.URL.Query().Get("source")
	var out []resources.Style
	snap := s.communityCatalog(r.Context(), false)
	// An exact id typed into search jumps straight to it.
	if q != "" {
		if st, ok := p.Style(q); ok && (strings.ContainsAny(q, "-_") || len(q) <= 4) {
			return map[string]any{"items": []resources.Style{st}, "total": 1}, nil
		}
		for _, st := range snap.Styles {
			if strings.EqualFold(st.Number, q) {
				return map[string]any{"items": []resources.Style{st}, "total": 1}, nil
			}
		}
	}
	seen := map[string]bool{}
	for _, st := range snap.Styles {
		if group != "" && st.GroupCode != group {
			continue
		}
		if source != "" && st.Source != source {
			continue
		}
		if !match(q, st.Number, st.GenerationName, st.NameZh, st.Description, st.Author, st.AuthorName, st.GroupZh) {
			continue
		}
		seen[strings.ToUpper(st.Number)] = true
		out = append(out, st)
	}
	for _, st := range p.Styles {
		if seen[strings.ToUpper(st.Number)] {
			continue
		}
		if group != "" && st.GroupCode != group {
			continue
		}
		if source != "" && st.Source != source {
			continue
		}
		if !match(q, st.Number, st.GenerationName, st.Reference, st.Traits, st.Group, st.NameZh) {
			continue
		}
		out = append(out, st)
	}
	if out == nil {
		out = []resources.Style{}
	}
	return map[string]any{"items": out, "total": len(out)}, nil
}

func (s *Server) resStyle(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	id := r.PathValue("id")
	if st, ok := p.Style(id); ok {
		model := r.URL.Query().Get("model")
		return map[string]any{"style": st, "decision": promptDecision(s, p, model, st)}, nil
	}
	if cst, ok := s.findCommunityStyle(r.Context(), id); ok {
		return map[string]any{
			"style": cst,
			"decision": map[string]any{
				"activation":    "网站模型云端黑盒注入",
				"siteModelOnly": true,
				"promptHidden":  true,
			},
		}, nil
	}
	return nil, notFound("找不到画风 " + id)
}

func (s *Server) resSimilar(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	n := qint(r, "n", 12)
	out := p.SimilarStyles(r.PathValue("id"), n)
	if out == nil {
		out = []resources.Style{}
	}
	return map[string]any{"items": out}, nil
}

func (s *Server) resLayouts(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	cat := r.URL.Query().Get("category")
	out := []resources.Layout{}
	snap := s.communityCatalog(r.Context(), false)
	seen := map[string]bool{}
	for _, l := range snap.Layouts {
		if cat != "" && l.Category != cat {
			continue
		}
		if !match(q, l.ID, l.Name, l.Description, l.Author, l.AuthorName) {
			continue
		}
		seen[strings.ToUpper(l.ID)] = true
		out = append(out, l)
	}
	for _, l := range p.Layouts {
		if seen[strings.ToUpper(l.ID)] {
			continue
		}
		if cat != "" && l.Category != cat {
			continue
		}
		if !match(q, append([]string{l.ID, l.Name, l.NameEn, l.PromptZh}, l.Keywords...)...) {
			continue
		}
		out = append(out, l)
	}
	return map[string]any{"items": out, "total": len(out)}, nil
}

func (s *Server) resColors(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query().Get("q")
	out := []resources.Color{}
	for _, c := range p.Colors {
		if match(q, c.ID, c.NameZh, c.NameEn, c.CategoryZh, c.QuoteZh) {
			out = append(out, c)
		}
	}
	return map[string]any{"items": out, "total": len(out)}, nil
}

func (s *Server) resTones(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query().Get("q")
	out := []resources.Tone{}
	for _, t := range p.Tones {
		if match(q, t.ID, t.NameZh, t.NameEn, t.DescZh, t.CategoryZh) {
			out = append(out, t)
		}
	}
	return map[string]any{"items": out, "total": len(out)}, nil
}

func (s *Server) resAssets(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	kind := r.URL.Query().Get("kind")
	out := []resources.Asset{}
	for _, a := range p.Assets {
		if kind == "" || a.Kind == kind {
			out = append(out, a)
		}
	}
	docs, _ := s.DB.ListDocs("asset", false)
	for _, d := range docs {
		var a resources.Asset
		if jsonUnmarshal(d.Data, &a) == nil && (kind == "" || a.Kind == kind) {
			out = append(out, a)
		}
	}
	return map[string]any{"items": out, "total": len(out)}, nil
}

// resRandom is the style dice: random style × layout × color, honoring locks.
func (s *Server) resRandom(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	out := map[string]any{}
	if v := q.Get("style"); v != "" {
		if st, ok := p.Style(v); ok {
			out["style"] = st
		}
	} else if len(p.Styles) > 0 {
		out["style"] = p.Styles[rand.Intn(len(p.Styles))]
	}
	if v := q.Get("layout"); v != "" {
		if l, ok := p.Layout(v); ok {
			out["layout"] = l
		}
	} else if q.Get("noLayout") == "" && len(p.Layouts) > 0 && rand.Intn(3) > 0 {
		out["layout"] = p.Layouts[rand.Intn(len(p.Layouts))]
	}
	if v := q.Get("color"); v != "" {
		if c, ok := p.Color(v); ok {
			out["color"] = c
		}
	} else if len(p.Colors) > 0 {
		out["color"] = p.Colors[rand.Intn(len(p.Colors))]
	}
	return out, nil
}

func (s *Server) filePack(w http.ResponseWriter, r *http.Request) {
	p := resources.Current()
	if p == nil {
		http.NotFound(w, r)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/files/pack/")
	full, ok := p.ImagePath(rel)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=604800")
	http.ServeFile(w, r, full)
}

func (s *Server) fileLocal(w http.ResponseWriter, r *http.Request) {
	s.serveLocal(w, r, r.URL.Query().Get("p"))
}

func (s *Server) filePlugin(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rel := strings.TrimPrefix(r.URL.Path, "/files/plugin/"+id+"/")
	st := s.Plugins.ListCommunity(s.enabledPlugins())
	enabled := false
	for _, c := range st {
		if c.ID == id && c.Enabled {
			enabled = true
		}
	}
	if !enabled {
		http.Error(w, "plugin disabled", http.StatusForbidden)
		return
	}
	full, ok := s.Plugins.FilePath(id, rel)
	if !ok {
		http.NotFound(w, r)
		return
	}
	// Plugin pages run in a sandboxed iframe with no access to the API.
	w.Header().Set("Content-Security-Policy", "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'")
	if strings.EqualFold(filepath.Ext(full), ".html") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	http.ServeFile(w, r, full)
}

func sortStyles(list []resources.Style) {
	sort.Slice(list, func(i, j int) bool { return list[i].Number < list[j].Number })
}
