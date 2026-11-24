package server

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/galleries"
)

// GalleryRef references a single item (and optional variant, e.g. pose angle)
// in any registered gallery (built-in or extension).
type GalleryRef struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Variant string `json:"variant,omitempty"`
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
		Series:   r.URL.Query().Get("series"),
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
	variant := strings.TrimSpace(r.URL.Query().Get("variant"))
	wantThumb := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("size")), "thumb")

	target, ok := s.Galleries.ResolveImageTarget(s.Pack(), kind, id, variant, wantThumb, s.galleryExtraDirs()...)
	if !ok {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	imgPath, err := galleries.EnsureCachedImage(ctx, target)
	if err != nil || imgPath == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, imgPath)
}

// galleryItemMaterialize downloads/caches the full-resolution local file for a
// gallery item (and optional pose angle variant) so Studio/Chat can pass it
// directly as a local-only reference image without syncing to any cloud account.
func (s *Server) galleryItemMaterialize(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := strings.TrimSpace(r.PathValue("kind"))
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Variant string `json:"variant"`
	}
	_ = decode(r, &body)
	variant := firstStr(strings.TrimSpace(body.Variant), strings.TrimSpace(r.URL.Query().Get("variant")))

	it, ok := s.Galleries.Item(s.Pack(), kind, id, s.galleryExtraDirs()...)
	if !ok {
		return nil, notFound(fmt.Sprintf("找不到画廊资源 %s/%s", kind, id))
	}
	target, ok := s.Galleries.ResolveImageTarget(s.Pack(), kind, id, variant, false, s.galleryExtraDirs()...)
	if !ok {
		return nil, bad("该资源没有可用的参考图片")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	imgPath, err := galleries.EnsureCachedImage(ctx, target)
	if err != nil || imgPath == "" {
		return nil, bad("下载参考图失败，请检查网络或切换镜像源后重试：" + err.Error())
	}

	variantLabel := ""
	resolvedVariant := variant
	if len(it.Variants) > 0 {
		chosen := it.Variants[0]
		if variant != "" {
			for _, v := range it.Variants {
				if strings.EqualFold(v.Key, variant) {
					chosen = v
					break
				}
			}
		}
		resolvedVariant = chosen.Key
		variantLabel = chosen.Label
	}
	displayName := it.Name
	if variantLabel != "" {
		displayName = fmt.Sprintf("%s · %s", it.Name, variantLabel)
	}
	return map[string]any{
		"ok":           true,
		"kind":         kind,
		"id":           it.ID,
		"variant":      resolvedVariant,
		"variantLabel": variantLabel,
		"name":         displayName,
		"path":         imgPath,
		"localOnly":    true,
	}, nil
}

// galleryPacksList lists installable third-party local-only libraries (e.g. RuiC-PoseAtlas).
func (s *Server) galleryPacksList(w http.ResponseWriter, r *http.Request) (any, error) {
	return map[string]any{
		"ok":            true,
		"defaultMirror": galleries.RuiCMirrorGitee,
		"packs":         galleries.ListExternalPacks(appdir.Galleries()),
	}, nil
}

// galleryPacksInstall installs one or more RuiC-PoseAtlas libraries locally
// from the user's preferred mirror (Gitee by default in China, GitHub fallback).
func (s *Server) galleryPacksInstall(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		ID     string   `json:"id"`
		IDs    []string `json:"ids"`
		Mirror string   `json:"mirror"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	ids := body.IDs
	if strings.TrimSpace(body.ID) != "" {
		ids = append(ids, strings.TrimSpace(body.ID))
	}
	if len(ids) == 0 {
		ids = []string{"ruic-poses", "ruic-costumes", "ruic-faces"}
	}
	mirror := firstStr(strings.TrimSpace(body.Mirror), galleries.RuiCMirrorGitee)

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	var installed []galleries.ExternalPackStatus
	var errs []string
	for _, id := range ids {
		st, err := galleries.InstallExternalPack(ctx, appdir.Galleries(), id, mirror)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", id, err))
			continue
		}
		installed = append(installed, st)
	}
	s.Galleries.InvalidateFileCache()
	s.Emit("galleries", map[string]any{"updated": true})

	if len(installed) == 0 && len(errs) > 0 {
		return nil, bad("安装图库失败：" + strings.Join(errs, "；"))
	}
	return map[string]any{
		"ok":        true,
		"installed": installed,
		"errors":    errs,
		"packs":     galleries.ListExternalPacks(appdir.Galleries()),
	}, nil
}

func (s *Server) galleryPackUninstall(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		PurgeCache *bool `json:"purgeCache"`
	}
	_ = decode(r, &body)
	purge := body.PurgeCache == nil || *body.PurgeCache
	if err := galleries.UninstallExternalPack(appdir.Galleries(), id, purge); err != nil {
		return nil, bad(err.Error())
	}
	s.Galleries.InvalidateFileCache()
	s.Emit("galleries", map[string]any{"updated": true})
	return map[string]any{
		"ok":    true,
		"packs": galleries.ListExternalPacks(appdir.Galleries()),
	}, nil
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

func (s *Server) resolveGalleryRefs(ctx context.Context, refs []GalleryRef) resolvedGalleryContext {
	var out resolvedGalleryContext
	if len(refs) == 0 || s.Galleries == nil {
		return out
	}
	if ctx == nil {
		ctx = context.Background()
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
		variant := strings.TrimSpace(ref.Variant)
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
		variantLabel := ""
		if len(it.Variants) > 0 {
			chosen := it.Variants[0]
			if variant != "" {
				for _, v := range it.Variants {
					if strings.EqualFold(v.Key, variant) {
						chosen = v
						break
					}
				}
			}
			variant = chosen.Key
			variantLabel = chosen.Label
		}
		desc := firstStr(it.PromptZh, it.Traits, it.PromptEn, it.Name)
		if desc != "" {
			titlePart := it.Name
			if variantLabel != "" {
				titlePart = fmt.Sprintf("%s · %s视角", titlePart, variantLabel)
			}
			if titlePart != "" && !strings.Contains(desc, titlePart) {
				out.PromptCues = append(out.PromptCues, fmt.Sprintf("【%s参考：%s】%s", label, titlePart, desc))
			} else {
				out.PromptCues = append(out.PromptCues, fmt.Sprintf("【%s参考】%s", label, desc))
			}
		}
		if meta.ID == "" || meta.SupportsRefImage {
			imgPath := it.ImagePath
			if target, ok := s.Galleries.ResolveImageTarget(pack, kind, id, variant, false, extra...); ok {
				fctx, cancel := context.WithTimeout(ctx, 25*time.Second)
				if p, err := galleries.EnsureCachedImage(fctx, target); err == nil && p != "" {
					imgPath = p
				}
				cancel()
			}
			if imgPath != "" && !seenRef[imgPath] {
				seenRef[imgPath] = true
				out.RefImages = append(out.RefImages, imgPath)
			}
		}
	}
	return out
}
