package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/galleries"
	"github.com/yang0/handraw-client/internal/store"
)

// RunRefMeta records the structured provenance of one reference image used during generation (#118).
// LocalPath is strictly local-only and must NEVER be transmitted to remote APIs.
type RunRefMeta struct {
	Index     int    `json:"index"`
	Source    string `json:"source"` // gallery | asset | upload | media_ref | catalog
	GalleryID string `json:"galleryId,omitempty"`
	ItemID    string `json:"itemId,omitempty"`
	Variant   string `json:"variant,omitempty"`
	Code      string `json:"code,omitempty"`
	AssetID   string `json:"assetId,omitempty"`
	MediaID   string `json:"mediaId,omitempty"`
	URL       string `json:"url,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	Label     string `json:"label,omitempty"`
	Role      string `json:"role,omitempty"`
	Note      string `json:"note,omitempty"`
	LocalPath string `json:"localPath,omitempty"`
}

// parseRuiCPathRef infers (galleryId, itemId, variant) from a legacy materialized
// RuiC-PoseAtlas local cache path so historical runs never upload open-source gallery images.
func parseRuiCPathRef(rawPath string) (galleryID, itemID, variant string, ok bool) {
	p := filepath.ToSlash(strings.TrimSpace(rawPath))
	if p == "" {
		return "", "", "", false
	}
	marker := "/" + galleries.RuiCCacheSubdir + "/"
	idx := strings.Index(strings.ToLower(p), marker)
	if idx < 0 {
		return "", "", "", false
	}
	rel := strings.TrimPrefix(p[idx+len(marker):], "/")
	parts := strings.Split(rel, "/")
	if len(parts) < 2 {
		return "", "", "", false
	}
	top := strings.ToLower(parts[0])
	base := strings.TrimSuffix(parts[len(parts)-1], filepath.Ext(parts[len(parts)-1]))
	if base == "" {
		return "", "", "", false
	}
	switch {
	case strings.Contains(top, "pose"):
		// Typical layouts: poses/<id>/<variant>.jpg or poses/<id>_<variant>.jpg
		if len(parts) >= 3 && parts[len(parts)-2] != "" && !strings.EqualFold(parts[len(parts)-2], top) {
			return "ruic-poses", parts[len(parts)-2], base, true
		}
		return "ruic-poses", base, "", true
	case strings.Contains(top, "costume") || strings.Contains(top, "cloth") || strings.Contains(top, "outfit"):
		return "ruic-costumes", base, "", true
	case strings.Contains(top, "face") || strings.Contains(top, "portrait"):
		return "ruic-faces", base, "", true
	default:
		return "", "", "", false
	}
}

// buildRunRefMeta merges explicit frontend refMeta, galleryRefs, and raw local ref paths
// into an ordered, deduplicated RunRefMeta slice persisted inside runs.Meta.refs.
func (s *Server) buildRunRefMeta(explicit []RunRefMeta, galleryRefs []GalleryRef, rawPaths []string) []RunRefMeta {
	out := make([]RunRefMeta, 0, len(explicit)+len(galleryRefs)+len(rawPaths))
	seenPath := map[string]bool{}
	seenGal := map[string]bool{}

	push := func(m RunRefMeta) {
		if len(out) >= 6 {
			return
		}
		m.Source = strings.ToLower(strings.TrimSpace(m.Source))
		m.LocalPath = strings.TrimSpace(m.LocalPath)
		if m.LocalPath != "" {
			if resolved := normalizeLocalRef(m.LocalPath); resolved != "" {
				m.LocalPath = resolved
			}
		}
		if m.Source == "" && m.GalleryID != "" && m.ItemID != "" {
			m.Source = "gallery"
		}
		if m.Source != "gallery" && m.LocalPath != "" {
			if gid, iid, v, ok := parseRuiCPathRef(m.LocalPath); ok {
				m.Source = "gallery"
				m.GalleryID = gid
				m.ItemID = iid
				if m.Variant == "" {
					m.Variant = v
				}
			}
		}
		if m.Source == "gallery" {
			gkey := strings.ToLower(m.GalleryID + "|" + m.ItemID + "|" + m.Variant)
			if m.GalleryID == "" || m.ItemID == "" || seenGal[gkey] {
				return
			}
			seenGal[gkey] = true
			if m.LocalPath != "" {
				seenPath[strings.ToLower(filepath.Clean(m.LocalPath))] = true
			}
		} else {
			if m.Source == "" {
				m.Source = "upload"
			}
			if m.LocalPath != "" {
				pk := strings.ToLower(filepath.Clean(m.LocalPath))
				if seenPath[pk] {
					return
				}
				seenPath[pk] = true
			}
		}
		m.Index = len(out) + 1
		if m.Label == "" && m.LocalPath != "" {
			m.Label = strings.TrimSuffix(filepath.Base(m.LocalPath), filepath.Ext(m.LocalPath))
		}
		out = append(out, m)
	}

	for _, em := range explicit {
		push(em)
	}
	for _, gr := range galleryRefs {
		kind := strings.ToLower(strings.TrimSpace(gr.Kind))
		if kind == "" || kind == "styles" || kind == "style" || kind == "layouts" || kind == "layout" || kind == "colors" || kind == "color" || kind == "tones" || kind == "tone" {
			continue
		}
		label := gr.ID
		if s.Galleries != nil {
			if it, ok := s.Galleries.Item(s.Pack(), kind, gr.ID, s.galleryExtraDirs()...); ok && it.Name != "" {
				label = it.Name
			}
		}
		push(RunRefMeta{
			Source:    "gallery",
			GalleryID: kind,
			ItemID:    strings.TrimSpace(gr.ID),
			Variant:   strings.TrimSpace(gr.Variant),
			Label:     label,
		})
	}
	for _, rp := range rawPaths {
		resolved := normalizeLocalRef(rp)
		if resolved == "" {
			continue
		}
		pk := strings.ToLower(filepath.Clean(resolved))
		if seenPath[pk] {
			continue
		}
		if gid, iid, v, ok := parseRuiCPathRef(resolved); ok {
			push(RunRefMeta{
				Source:    "gallery",
				GalleryID: gid,
				ItemID:    iid,
				Variant:   v,
				LocalPath: resolved,
			})
		} else {
			push(RunRefMeta{
				Source:    "upload",
				LocalPath: resolved,
			})
		}
	}
	return out
}

// extractRunRefMeta reads structured reference image metadata from run.Meta.refs.
func extractRunRefMeta(run store.Run) []RunRefMeta {
	if len(run.Meta) == 0 {
		return nil
	}
	var m struct {
		Refs []RunRefMeta `json:"refs"`
	}
	if err := json.Unmarshal(run.Meta, &m); err != nil || len(m.Refs) == 0 {
		return nil
	}
	return m.Refs
}

type resolvedRefHashItem struct {
	SHA256        string `json:"sha256"`
	MatchedSHA256 string `json:"matchedSha256"`
	Matched       bool   `json:"matched"`
	MediaID       string `json:"mediaId"`
	URL           string `json:"url"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
}

// preparePublishRefSpecs builds the remote publish refSpecs payload:
//   - Open-source galleries (RuiC-PoseAtlas) emit pure coordinates (0 bytes uploaded).
//   - Catalog refs emit pure codes (0 bytes uploaded).
//   - Normal local reference images are compressed (<=1024px WebP/JPEG, EXIF stripped),
//     preflight-checked via POST /api/media/resolve-refs, and sent as 0-byte media_ref
//     pointers whenever the server already holds the exact image.
func (s *Server) preparePublishRefSpecs(
	ctx context.Context,
	refs []RunRefMeta,
	encodedByPath map[string]string,
) ([]map[string]any, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	type localCandidate struct {
		specIdx   int
		meta      RunRefMeta
		dataURL   string
		compSHA   string
		rawSHA    string
		resolved  *resolvedRefHashItem
	}
	specs := make([]map[string]any, 0, len(refs))
	var candidates []*localCandidate

	for i, ref := range refs {
		if len(specs) >= 6 {
			break
		}
		idx := ref.Index
		if idx <= 0 {
			idx = i + 1
		}
		src := strings.ToLower(strings.TrimSpace(ref.Source))
		if src != "gallery" && ref.LocalPath != "" {
			if gid, iid, v, ok := parseRuiCPathRef(ref.LocalPath); ok {
				src = "gallery"
				ref.GalleryID = gid
				ref.ItemID = iid
				if ref.Variant == "" {
					ref.Variant = v
				}
			}
		}

		switch src {
		case "gallery":
			if ref.GalleryID == "" || ref.ItemID == "" {
				continue
			}
			item := map[string]any{
				"index":     idx,
				"source":    "gallery",
				"galleryId": ref.GalleryID,
				"itemId":    ref.ItemID,
				"label":     firstStr(ref.Label, ref.ItemID),
			}
			if ref.Variant != "" {
				item["variant"] = ref.Variant
			}
			if ref.Role != "" {
				item["role"] = ref.Role
			}
			specs = append(specs, item)

		case "catalog":
			if ref.Code == "" {
				continue
			}
			item := map[string]any{
				"index":  idx,
				"source": "catalog",
				"code":   ref.Code,
				"label":  firstStr(ref.Label, ref.Code),
			}
			if ref.Role != "" {
				item["role"] = ref.Role
			}
			specs = append(specs, item)

		case "media_ref":
			if ref.MediaID == "" && ref.URL == "" && ref.SHA256 == "" {
				continue
			}
			item := map[string]any{
				"index":  idx,
				"source": "media_ref",
				"label":  firstStr(ref.Label, fmt.Sprintf("参考图 %d", idx)),
			}
			if ref.MediaID != "" {
				item["mediaId"] = ref.MediaID
			}
			if ref.URL != "" {
				item["url"] = ref.URL
			}
			if ref.SHA256 != "" {
				item["sha256"] = ref.SHA256
			}
			if ref.Role != "" {
				item["role"] = ref.Role
			}
			specs = append(specs, item)

		default:
			lp := strings.TrimSpace(ref.LocalPath)
			if lp == "" {
				continue
			}
			if resolved := normalizeLocalRef(lp); resolved != "" {
				lp = resolved
			}
			rawOrig, err := os.ReadFile(lp)
			if err != nil {
				// Skip missing local temp reference file instead of hard-crashing if already cleaned up.
				continue
			}
			rawSum := sha256.Sum256(rawOrig)
			rawSHA := hex.EncodeToString(rawSum[:])

			encHint := ""
			if encodedByPath != nil {
				encHint = encodedByPath[ref.LocalPath]
				if encHint == "" {
					encHint = encodedByPath[lp]
				}
			}
			dataURL, _, err := shareImage(store.Image{Path: lp}, encHint)
			if err != nil {
				return nil, fmt.Errorf("压缩参考图 %s 失败：%w", filepath.Base(lp), err)
			}
			comma := strings.Index(dataURL, ",")
			if comma <= 0 {
				continue
			}
			compBytes, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
			if err != nil {
				continue
			}
			compSum := sha256.Sum256(compBytes)
			compSHA := hex.EncodeToString(compSum[:])

			placeholder := map[string]any{
				"index": idx,
				"label": firstStr(ref.Label, strings.TrimSuffix(filepath.Base(lp), filepath.Ext(lp)), fmt.Sprintf("参考图 %d", idx)),
			}
			if ref.Role != "" {
				placeholder["role"] = ref.Role
			}
			specIdx := len(specs)
			specs = append(specs, placeholder)
			candidates = append(candidates, &localCandidate{
				specIdx: specIdx,
				meta:    ref,
				dataURL: dataURL,
				compSHA: compSHA,
				rawSHA:  rawSHA,
			})
		}
	}

	// Preflight check against server media_assets / media_public_grants to skip redundant uploads (#118).
	if len(candidates) > 0 && s.Site != nil && s.Site.LoggedIn() {
		hashes := make([]map[string]string, 0, len(candidates))
		for _, c := range candidates {
			hashes = append(hashes, map[string]string{
				"sha256":    c.compSHA,
				"rawSha256": c.rawSHA,
			})
		}
		if rawResp, err := s.Site.Send(ctx, http.MethodPost, "/api/media/resolve-refs", map[string]any{"hashes": hashes}); err == nil {
			var res struct {
				Results []resolvedRefHashItem `json:"results"`
			}
			if json.Unmarshal(rawResp, &res) == nil {
				for i, c := range candidates {
					if i < len(res.Results) && res.Results[i].Matched && (res.Results[i].MediaID != "" || res.Results[i].URL != "") {
						hit := res.Results[i]
						c.resolved = &hit
					}
				}
			}
		}
	}

	for _, c := range candidates {
		spec := specs[c.specIdx]
		if c.resolved != nil {
			spec["source"] = "media_ref"
			spec["mediaId"] = c.resolved.MediaID
			spec["url"] = c.resolved.URL
			spec["sha256"] = firstStr(c.resolved.MatchedSHA256, c.compSHA)
		} else {
			spec["source"] = "upload"
			spec["sha256"] = c.compSHA
			spec["rawSha256"] = c.rawSHA
			spec["dataUrl"] = c.dataURL
		}
	}
	return specs, nil
}

// inspirationsMaterializeRefs downloads/resolves an unlocked community inspiration's refSpecs
// into local files ready for Studio "做同款" (RuiC galleries materialize via local mirror;
// media_ref URLs cache under appdir.Cache()/remix-refs/).
func (s *Server) inspirationsMaterializeRefs(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		RefSpecs []RunRefMeta `json:"refSpecs"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.RefSpecs) == 0 {
		return map[string]any{"ok": true, "refs": []RunRefMeta{}, "paths": []string{}, "warnings": []string{}}, nil
	}

	cacheDir := filepath.Join(appdir.Cache(), "remix-refs")
	_ = os.MkdirAll(cacheDir, 0o755)

	resolved := make([]RunRefMeta, 0, len(body.RefSpecs))
	paths := make([]string, 0, len(body.RefSpecs))
	var warnings []string

	for i, rf := range body.RefSpecs {
		if len(resolved) >= 6 {
			break
		}
		idx := rf.Index
		if idx <= 0 {
			idx = i + 1
		}
		src := strings.ToLower(strings.TrimSpace(rf.Source))
		switch src {
		case "gallery":
			if rf.GalleryID == "" || rf.ItemID == "" {
				continue
			}
			if s.Galleries == nil {
				warnings = append(warnings, fmt.Sprintf("图 %d（%s）暂不可用", idx, firstStr(rf.Label, rf.GalleryID)))
				continue
			}
			target, ok := s.Galleries.ResolveImageTarget(s.Pack(), rf.GalleryID, rf.ItemID, rf.Variant, false, s.galleryExtraDirs()...)
			if !ok {
				warnings = append(warnings, fmt.Sprintf("图 %d 需要先安装开源图鉴「%s」", idx, rf.GalleryID))
				continue
			}
			gctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
			imgPath, err := galleries.EnsureCachedImage(gctx, target)
			cancel()
			if err != nil || imgPath == "" {
				warnings = append(warnings, fmt.Sprintf("下载图 %d（%s）失败", idx, firstStr(rf.Label, rf.ItemID)))
				continue
			}
			rf.Index = len(resolved) + 1
			rf.LocalPath = imgPath
			resolved = append(resolved, rf)
			paths = append(paths, imgPath)

		case "media_ref", "upload":
			rawURL := strings.TrimSpace(rf.URL)
			if rawURL == "" {
				continue
			}
			fullURL := rawURL
			if strings.HasPrefix(rawURL, "/") && s.Site != nil {
				fullURL = strings.TrimRight(s.Site.Base(), "/") + rawURL
			}
			if !strings.HasPrefix(fullURL, "http://") && !strings.HasPrefix(fullURL, "https://") {
				continue
			}
			sum := sha256.Sum256([]byte(fullURL))
			ext := filepath.Ext(strings.SplitN(rawURL, "?", 2)[0])
			if ext == "" || len(ext) > 6 {
				ext = ".webp"
			}
			dst := filepath.Join(cacheDir, hex.EncodeToString(sum[:])[:20]+ext)
			if st, err := os.Stat(dst); err != nil || st.Size() == 0 {
				req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, fullURL, nil)
				if err != nil {
					warnings = append(warnings, fmt.Sprintf("无法拉取参考图 %d", idx))
					continue
				}
				client := &http.Client{Timeout: 25 * time.Second}
				resp, err := client.Do(req)
				if err != nil || resp.StatusCode >= 400 {
					if resp != nil {
						resp.Body.Close()
					}
					warnings = append(warnings, fmt.Sprintf("下载参考图 %d 失败", idx))
					continue
				}
				data, rErr := io.ReadAll(io.LimitReader(resp.Body, 15<<20))
				resp.Body.Close()
				if rErr != nil || len(data) == 0 {
					warnings = append(warnings, fmt.Sprintf("读取参考图 %d 失败", idx))
					continue
				}
				if wErr := os.WriteFile(dst, data, 0o644); wErr != nil {
					warnings = append(warnings, fmt.Sprintf("缓存参考图 %d 失败", idx))
					continue
				}
			}
			rf.Index = len(resolved) + 1
			rf.LocalPath = dst
			resolved = append(resolved, rf)
			paths = append(paths, dst)
		}
	}

	return map[string]any{
		"ok":       true,
		"refs":     resolved,
		"paths":    paths,
		"warnings": warnings,
	}, nil
}
