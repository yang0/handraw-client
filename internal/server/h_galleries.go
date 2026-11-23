package server

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/galleries"
)

// GalleryRef references a single item in any registered gallery (built-in or extension).
type GalleryRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

func (s *Server) galleryExtraDirs() []string {
	return []string{appdir.Galleries()}
}

func (s *Server) galleryList(w http.ResponseWriter, r *http.Request) (any, error) {
	list := s.Galleries.List(s.Pack(), s.galleryExtraDirs()...)
	if list == nil {
		list = []galleries.Meta{}
	}
	return map[string]any{"galleries": list}, nil
}

func (s *Server) galleryItems(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := strings.TrimSpace(r.PathValue("kind"))
	q := galleries.Query{
		Q:        r.URL.Query().Get("q"),
		Category: r.URL.Query().Get("category"),
		Source:   r.URL.Query().Get("source"),
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		q.Limit = v
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v > 0 {
		q.Offset = v
	}
	items, total, ok := s.Galleries.Items(s.Pack(), kind, q, s.galleryExtraDirs()...)
	if !ok {
		return nil, notFound("找不到画廊 " + kind)
	}
	return map[string]any{"kind": kind, "items": items, "total": total}, nil
}

func (s *Server) galleryItem(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := strings.TrimSpace(r.PathValue("kind"))
	id := strings.TrimSpace(r.PathValue("id"))
	it, ok := s.Galleries.Item(s.Pack(), kind, id, s.galleryExtraDirs()...)
	if !ok {
		return nil, notFound(fmt.Sprintf("找不到画廊资源 %s/%s", kind, id))
	}
	return map[string]any{"item": it}, nil
}

func (s *Server) galleryItemImage(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.PathValue("kind"))
	id := strings.TrimSpace(r.PathValue("id"))
	imgPath, ok := s.Galleries.ResolveImage(s.Pack(), kind, id, s.galleryExtraDirs()...)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeFile(w, r, imgPath)
}

// resolvedGalleryContext holds prompt additions, reference image paths, and
// core style/layout/color/tone IDs derived from a slice of GalleryRef.
type resolvedGalleryContext struct {
	Style      string
	Layout     string
	Color      string
	Tone       string
	PromptCues []string
	RefImages  []string
}

func (s *Server) resolveGalleryRefs(refs []GalleryRef) resolvedGalleryContext {
	var out resolvedGalleryContext
	if len(refs) == 0 || s.Galleries == nil {
		return out
	}
	pack := s.Pack()
	extra := s.galleryExtraDirs()
	metas := map[string]galleries.Meta{}
	for _, m := range s.Galleries.List(pack, extra...) {
		metas[m.ID] = m
	}
	seenRef := map[string]bool{}
	for _, ref := range refs {
		kind := strings.ToLower(strings.TrimSpace(ref.Kind))
		id := strings.TrimSpace(ref.ID)
		if kind == "" || id == "" {
			continue
		}
		switch kind {
		case "styles", "style":
			if out.Style == "" {
				out.Style = id
			}
			continue
		case "layouts", "layout":
			if out.Layout == "" {
				out.Layout = id
			}
			continue
		case "colors", "color":
			if out.Color == "" {
				out.Color = id
			}
			continue
		case "tones", "tone":
			if out.Tone == "" {
				out.Tone = id
			}
			continue
		}
		it, ok := s.Galleries.Item(pack, kind, id, extra...)
		if !ok {
			continue
		}
		meta := metas[kind]
		label := firstStr(meta.Name, kind)
		desc := firstStr(it.PromptZh, it.Traits, it.PromptEn, it.Name)
		if desc != "" {
			if it.Name != "" && !strings.Contains(desc, it.Name) {
				out.PromptCues = append(out.PromptCues, fmt.Sprintf("【%s参考：%s】%s", label, it.Name, desc))
			} else {
				out.PromptCues = append(out.PromptCues, fmt.Sprintf("【%s参考】%s", label, desc))
			}
		}
		if (meta.ID == "" || meta.SupportsRefImage) && it.ImagePath != "" && !seenRef[it.ImagePath] {
			seenRef[it.ImagePath] = true
			out.RefImages = append(out.RefImages, it.ImagePath)
		}
	}
	return out
}
