package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/galleries"
	"github.com/yang0/handraw-client/internal/profile"
	"github.com/yang0/handraw-client/internal/resources"
)

const maxPluginGalleryImageBytes = 12 << 20 // 12 MiB safety cap for base64 plugin image replies

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

func isPersonalAssetsKind(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "assets", "asset", "my-assets":
		return true
	}
	return false
}

func (s *Server) resolvePersonalAssetFile(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if filepath.IsAbs(raw) {
		if st, err := os.Stat(raw); err == nil && !st.IsDir() {
			return raw
		}
		return ""
	}
	if p := s.Pack(); p != nil {
		if full, ok := p.ImagePath(raw); ok {
			return full
		}
	}
	return ""
}

// personalAssetsGallery projects the user's custom asset library (SQLite assets
// + Skill tuku assets + custom categories) into the unified gallery contract (#117).
func (s *Server) personalAssetsGallery() (galleries.Meta, []galleries.Item) {
	catLabels := map[string]string{}
	if s.DB != nil {
		allCats, _ := s.listAssetCategories()
		for _, c := range allCats {
			catLabels[c.Key] = c.Label
		}
	} else {
		for _, c := range builtinAssetCategories {
			catLabels[c.Key] = c.Label
		}
	}

	var items []galleries.Item
	seen := map[string]bool{}

	appendAsset := func(id, kind, name, nameEn, image, source string, tags []string) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		catKey := firstStr(strings.TrimSpace(kind), "other")
		catName := firstStr(catLabels[catKey], catKey)
		imgPath := s.resolvePersonalAssetFile(image)
		it := galleries.Item{
			ID:           id,
			Kind:         "assets",
			Name:         firstStr(strings.TrimSpace(name), strings.TrimSpace(nameEn), id),
			NameEn:       strings.TrimSpace(nameEn),
			Category:     catKey,
			CategoryName: catName,
			Tags:         tags,
			Image:        image,
			Source:       firstStr(source, "local"),
			ImagePath:    imgPath,
		}
		if imgPath != "" {
			it.ImageURL = galleries.ItemImageURL("assets", id)
			it.ThumbURL = it.ImageURL
		}
		items = append(items, it)
	}

	if s.DB != nil {
		if docs, err := s.DB.ListDocs("asset", false); err == nil {
			for _, d := range docs {
				var a resources.Asset
				if json.Unmarshal(d.Data, &a) != nil {
					continue
				}
				var raw map[string]any
				src := "local"
				if json.Unmarshal(d.Data, &raw) == nil {
					if v, ok := raw["source"].(string); ok && strings.TrimSpace(v) != "" {
						src = strings.TrimSpace(v)
					}
				}
				appendAsset(firstStr(a.ID, d.ID), a.Kind, firstStr(a.Name, d.Name), a.NameEn, a.Image, src, a.Tags)
			}
		}
	}
	for _, tk := range profile.ListTukuAssets() {
		appendAsset(tk.ID, tk.Kind, tk.Name, tk.NameEn, tk.FilePath, "skill", nil)
	}
	if items == nil {
		items = []galleries.Item{}
	}

	meta := galleries.Meta{
		ID:               "assets",
		Name:             "自建图库",
		NameEn:           "My Assets",
		Description:      "用户自建与本地导入的参考图素材库",
		Source:           "personal",
		PromptRole:       "asset",
		SupportsRefImage: true,
		Builtin:          true,
		LocalOnly:        true,
		Count:            len(items),
		Categories:       galleries.ComputeCategories(items),
	}
	return meta, items
}

func (s *Server) allGalleriesList() []galleries.Meta {
	list := s.Galleries.List(s.Pack(), s.galleryExtraDirs()...)
	if list == nil {
		list = []galleries.Meta{}
	}
	assetsMeta, _ := s.personalAssetsGallery()
	// Insert "assets" right after the core 4 (styles/layouts/colors/tones) when present.
	insertAt := len(list)
	for i, m := range list {
		if m.ID == "tones" {
			insertAt = i + 1
			break
		}
	}
	out := make([]galleries.Meta, 0, len(list)+1)
	out = append(out, list[:insertAt]...)
	out = append(out, assetsMeta)
	out = append(out, list[insertAt:]...)
	return out
}

func (s *Server) queryGalleryItems(kind string, q galleries.Query) ([]galleries.Item, int, bool) {
	if isPersonalAssetsKind(kind) {
		_, all := s.personalAssetsGallery()
		items, total := galleries.FilterItems(all, q)
		return items, total, true
	}
	return s.Galleries.Items(s.Pack(), kind, q, s.galleryExtraDirs()...)
}

func (s *Server) lookupGalleryItem(kind, id string) (galleries.Item, bool) {
	if isPersonalAssetsKind(kind) {
		_, all := s.personalAssetsGallery()
		want := strings.TrimSpace(id)
		for _, it := range all {
			if strings.EqualFold(it.ID, want) {
				return it, true
			}
		}
		return galleries.Item{}, false
	}
	return s.Galleries.Item(s.Pack(), kind, id, s.galleryExtraDirs()...)
}

func (s *Server) resolveGalleryImageTarget(kind, id, variant string, wantThumb bool) (galleries.ImageTarget, bool) {
	if isPersonalAssetsKind(kind) {
		it, ok := s.lookupGalleryItem(kind, id)
		if !ok || it.ImagePath == "" {
			return galleries.ImageTarget{}, false
		}
		return galleries.ImageTarget{LocalPath: it.ImagePath}, true
	}
	return s.Galleries.ResolveImageTarget(s.Pack(), kind, id, variant, wantThumb, s.galleryExtraDirs()...)
}

func detectImageMIME(imgPath string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(imgPath))
	if ext != "" {
		if mt := mime.TypeByExtension(ext); mt != "" {
			if idx := strings.Index(mt, ";"); idx > 0 {
				mt = strings.TrimSpace(mt[:idx])
			}
			if strings.HasPrefix(mt, "image/") {
				return mt
			}
		}
	}
	if len(data) > 0 {
		if mt := http.DetectContentType(data); strings.HasPrefix(mt, "image/") {
			return mt
		}
	}
	return "application/octet-stream"
}

func (s *Server) readGalleryImageDataURL(ctx context.Context, kind, id, variant, size string) (map[string]any, error) {
	kind = strings.TrimSpace(kind)
	id = strings.TrimSpace(id)
	variant = strings.TrimSpace(variant)
	if kind == "" || id == "" {
		return nil, bad("缺少画廊类型或资源 ID")
	}
	wantThumb := strings.EqualFold(strings.TrimSpace(size), "thumb")
	target, ok := s.resolveGalleryImageTarget(kind, id, variant, wantThumb)
	if !ok {
		return nil, notFound(fmt.Sprintf("找不到画廊图片 %s/%s", kind, id))
	}
	tctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	imgPath, err := galleries.EnsureCachedImage(tctx, target)
	if err != nil || imgPath == "" {
		if err != nil {
			return nil, bad("获取画廊图片失败：" + err.Error())
		}
		return nil, notFound(fmt.Sprintf("找不到画廊图片 %s/%s", kind, id))
	}
	st, err := os.Stat(imgPath)
	if err != nil || st.IsDir() {
		return nil, notFound(fmt.Sprintf("找不到画廊图片 %s/%s", kind, id))
	}
	if st.Size() > maxPluginGalleryImageBytes {
		return nil, bad("图片体积超过插件接口上限（12 MB）")
	}
	data, err := os.ReadFile(imgPath)
	if err != nil {
		return nil, bad("读取画廊图片失败：" + err.Error())
	}
	mimeType := detectImageMIME(imgPath, data)
	sizeOut := "full"
	if wantThumb {
		sizeOut = "thumb"
	}
	return map[string]any{
		"kind":       kind,
		"id":         id,
		"variant":    variant,
		"size":       sizeOut,
		"mimeType":   mimeType,
		"dataUrl":    "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data),
		"byteLength": len(data),
	}, nil
}

func (s *Server) materializeGalleryItem(ctx context.Context, kind, id, variant string) (map[string]any, error) {
	kind = strings.TrimSpace(kind)
	id = strings.TrimSpace(id)
	variant = strings.TrimSpace(variant)
	it, ok := s.lookupGalleryItem(kind, id)
	if !ok {
		return nil, notFound(fmt.Sprintf("找不到画廊资源 %s/%s", kind, id))
	}
	target, ok := s.resolveGalleryImageTarget(kind, id, variant, false)
	if !ok {
		return nil, bad("该资源没有可用的参考图片")
	}
	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	imgPath, err := galleries.EnsureCachedImage(tctx, target)
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
		"kind":         it.Kind,
		"id":           it.ID,
		"variant":      resolvedVariant,
		"variantLabel": variantLabel,
		"name":         displayName,
		"path":         imgPath,
		"localOnly":    true,
	}, nil
}

func (s *Server) galleryList(w http.ResponseWriter, r *http.Request) (any, error) {
	return map[string]any{"galleries": s.allGalleriesList()}, nil
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
	items, total, ok := s.queryGalleryItems(kind, q)
	if !ok {
		return nil, notFound("找不到画廊 " + kind)
	}
	return map[string]any{"kind": kind, "items": items, "total": total}, nil
}

func (s *Server) galleryItem(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := strings.TrimSpace(r.PathValue("kind"))
	id := strings.TrimSpace(r.PathValue("id"))
	it, ok := s.lookupGalleryItem(kind, id)
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

	target, ok := s.resolveGalleryImageTarget(kind, id, variant, wantThumb)
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
	return s.materializeGalleryItem(r.Context(), kind, id, variant)
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
	metas := map[string]galleries.Meta{}
	for _, m := range s.allGalleriesList() {
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
		it, ok := s.lookupGalleryItem(kind, id)
		if !ok {
			continue
		}
		metaKey := kind
		if isPersonalAssetsKind(kind) {
			metaKey = "assets"
		}
		meta := metas[metaKey]
		label := firstStr(meta.Name, metaKey)
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
			if target, ok := s.resolveGalleryImageTarget(kind, id, variant, false); ok {
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
