package galleries

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	RuiCMirrorGitee  = "gitee"
	RuiCMirrorGitHub = "github"

	RuiCRepoGitHubURL  = "https://github.com/HRuiCcc/RuiC-PoseAtlas"
	RuiCRepoGiteeURL   = "https://gitee.com/mingtian2018/RuiC-PoseAtlas"
	RuiCRawBaseGitee   = "https://gitee.com/mingtian2018/RuiC-PoseAtlas/raw/main/"
	RuiCRawBaseGitHub  = "https://raw.githubusercontent.com/HRuiCcc/RuiC-PoseAtlas/main/"
	RuiCCacheSubdir    = "ruic-poseatlas"
	maxGalleryImgBytes = 25 << 20 // 25 MiB safety cap per image
)

// Overridable in tests so unit tests never touch the network.
var (
	ruicMirrorRawBases = map[string]string{
		RuiCMirrorGitee:  RuiCRawBaseGitee,
		RuiCMirrorGitHub: RuiCRawBaseGitHub,
	}
	ruicHTTPClient = &http.Client{Timeout: 25 * time.Second}
)

// ExternalPackStatus describes one installable third-party local-only library.
type ExternalPackStatus struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	NameEn       string `json:"nameEn"`
	Description  string `json:"description"`
	Badge        string `json:"badge"`
	DataPath     string `json:"dataPath"`
	MultiVariant bool   `json:"multiVariant,omitempty"`
	LocalOnly    bool   `json:"localOnly"`
	License      string `json:"license"`
	UpstreamURL  string `json:"upstreamUrl"`
	MirrorURL    string `json:"mirrorUrl"`
	Installed    bool   `json:"installed"`
	Mirror       string `json:"mirror,omitempty"`
	ItemCount    int    `json:"itemCount,omitempty"`
	CachedFiles  int    `json:"cachedFiles,omitempty"`
	CachedBytes  int64  `json:"cachedBytes,omitempty"`
}

var ruicPackCatalog = []ExternalPackStatus{
	{
		ID:           "ruic-poses",
		Name:         "姿态图鉴",
		NameEn:       "RuiC Poses",
		Description:  "288 组人体姿态 × 5 视角（正面/斜侧/侧面/俯视/仰视）共 1,439 张人台线稿参考，支持精确选角度入图。",
		Badge:        "288组 × 5视角",
		DataPath:     "data/poses.json",
		MultiVariant: true,
		LocalOnly:    true,
		License:      "MIT",
		UpstreamURL:  RuiCRepoGitHubURL,
		MirrorURL:    RuiCRepoGiteeURL,
	},
	{
		ID:          "ruic-costumes",
		Name:        "衣装图鉴",
		NameEn:      "RuiC Costumes",
		Description: "1,407 套无人物服饰单品图鉴 × 8 季节与风格分类，适合固定穿搭、服饰材质与廓形参考。",
		Badge:       "1,407 套服饰",
		DataPath:    "data/costumes.json",
		LocalOnly:   true,
		License:     "MIT",
		UpstreamURL: RuiCRepoGitHubURL,
		MirrorURL:   RuiCRepoGiteeURL,
	},
	{
		ID:          "ruic-faces",
		Name:        "人像图鉴",
		NameEn:      "RuiC Faces",
		Description: "1,499 张正面脸部与造型参考，按脸部/造型与 4 种发长分类，适合固定角色颜值与发型气质。",
		Badge:       "1,499 张人像",
		DataPath:    "data/faces.json",
		LocalOnly:   true,
		License:     "MIT",
		UpstreamURL: RuiCRepoGitHubURL,
		MirrorURL:   RuiCRepoGiteeURL,
	},
}

// ListExternalPacks returns the installable third-party local library catalog
// annotated with current installation state & local disk cache stats.
func ListExternalPacks(galleriesDir string) []ExternalPackStatus {
	out := make([]ExternalPackStatus, 0, len(ruicPackCatalog))
	for _, spec := range ruicPackCatalog {
		st := spec
		manifestPath := filepath.Join(galleriesDir, spec.ID+".json")
		if raw, err := os.ReadFile(manifestPath); err == nil {
			var reg Registration
			if json.Unmarshal(raw, &reg) == nil {
				st.Installed = true
				st.Mirror = firstNonEmpty(reg.Mirror, RuiCMirrorGitee)
				st.ItemCount = len(reg.Items)
			}
		}
		st.CachedFiles, st.CachedBytes = packCacheStats(galleriesDir, spec.ID)
		out = append(out, st)
	}
	return out
}

func packCacheStats(galleriesDir, packID string) (int, int64) {
	base := filepath.Join(galleriesDir, RuiCCacheSubdir)
	var dirs []string
	switch packID {
	case "ruic-poses":
		dirs = []string{filepath.Join(base, "thumbs"), filepath.Join(base, "img")}
	case "ruic-costumes":
		dirs = []string{filepath.Join(base, "costume")}
	case "ruic-faces":
		dirs = []string{filepath.Join(base, "portrait")}
	default:
		return 0, 0
	}
	files := 0
	var bytes int64
	for _, d := range dirs {
		_ = filepath.WalkDir(d, func(_ string, de os.DirEntry, err error) error {
			if err != nil || de.IsDir() {
				return nil
			}
			if info, iErr := de.Info(); iErr == nil {
				files++
				bytes += info.Size()
			}
			return nil
		})
	}
	return files, bytes
}

// InstallExternalPack downloads the lightweight catalog JSON from Gitee mirror
// (default in China) or GitHub, converts it into a local-only Handraw gallery
// registration JSON inside galleriesDir, and returns the resulting status.
// Images are cached locally on demand so install completes in seconds without
// forcing an 800MB upfront download.
func InstallExternalPack(ctx context.Context, galleriesDir, packID, mirror string) (ExternalPackStatus, error) {
	spec, ok := findExternalPack(packID)
	if !ok {
		return ExternalPackStatus{}, fmt.Errorf("未知的扩展图库 %q", packID)
	}
	if err := os.MkdirAll(galleriesDir, 0o755); err != nil {
		return ExternalPackStatus{}, err
	}
	order := mirrorOrder(mirror)
	var (
		raw        []byte
		usedMirror string
		lastErr    error
	)
	for _, m := range order {
		base := ruicMirrorRawBases[m]
		if base == "" {
			continue
		}
		data, err := fetchBytes(ctx, base+spec.DataPath, 10<<20)
		if err == nil && len(data) > 0 {
			raw = data
			usedMirror = m
			break
		}
		lastErr = err
	}
	if len(raw) == 0 {
		if lastErr != nil {
			return ExternalPackStatus{}, fmt.Errorf("下载图库索引失败：%w", lastErr)
		}
		return ExternalPackStatus{}, fmt.Errorf("下载图库索引失败：空响应")
	}

	rawBase := ruicMirrorRawBases[usedMirror]
	var (
		reg Registration
		err error
	)
	switch spec.ID {
	case "ruic-poses":
		reg, err = convertRuiCPoses(raw, rawBase, usedMirror)
	case "ruic-costumes":
		reg, err = convertRuiCCostumes(raw, rawBase, usedMirror)
	case "ruic-faces":
		reg, err = convertRuiCFaces(raw, rawBase, usedMirror)
	default:
		return ExternalPackStatus{}, fmt.Errorf("不支持的图库类型 %q", spec.ID)
	}
	if err != nil {
		return ExternalPackStatus{}, err
	}

	encoded, err := json.Marshal(reg)
	if err != nil {
		return ExternalPackStatus{}, err
	}
	dst := filepath.Join(galleriesDir, spec.ID+".json")
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, encoded, 0o644); err != nil {
		return ExternalPackStatus{}, err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return ExternalPackStatus{}, err
	}
	_ = setPackOptedOut(galleriesDir, spec.ID, false)

	st := spec
	st.Installed = true
	st.Mirror = usedMirror
	st.ItemCount = len(reg.Items)
	st.CachedFiles, st.CachedBytes = packCacheStats(galleriesDir, spec.ID)
	return st, nil
}

// UninstallExternalPack removes the installed gallery index JSON and optionally
// purges its local disk image cache. Also records an opt-out marker so auto-install
// on startup does not re-install a pack the user explicitly removed.
func UninstallExternalPack(galleriesDir, packID string, purgeCache bool) error {
	if _, ok := findExternalPack(packID); !ok {
		return fmt.Errorf("未知的扩展图库 %q", packID)
	}
	_ = os.Remove(filepath.Join(galleriesDir, packID+".json"))
	_ = setPackOptedOut(galleriesDir, packID, true)
	if purgeCache {
		base := filepath.Join(galleriesDir, RuiCCacheSubdir)
		switch packID {
		case "ruic-poses":
			_ = os.RemoveAll(filepath.Join(base, "thumbs"))
			_ = os.RemoveAll(filepath.Join(base, "img"))
		case "ruic-costumes":
			_ = os.RemoveAll(filepath.Join(base, "costume"))
		case "ruic-faces":
			_ = os.RemoveAll(filepath.Join(base, "portrait"))
		}
	}
	return nil
}

const optOutFilename = ".packs-opted-out.json"

var optOutMu sync.Mutex

func loadOptedOutPacks(galleriesDir string) map[string]bool {
	out := map[string]bool{}
	raw, err := os.ReadFile(filepath.Join(galleriesDir, optOutFilename))
	if err != nil {
		return out
	}
	var ids []string
	if json.Unmarshal(raw, &ids) == nil {
		for _, id := range ids {
			if k := strings.ToLower(strings.TrimSpace(id)); k != "" {
				out[k] = true
			}
		}
	}
	return out
}

func setPackOptedOut(galleriesDir, packID string, optedOut bool) error {
	optOutMu.Lock()
	defer optOutMu.Unlock()
	if err := os.MkdirAll(galleriesDir, 0o755); err != nil {
		return err
	}
	m := loadOptedOutPacks(galleriesDir)
	k := strings.ToLower(strings.TrimSpace(packID))
	if optedOut {
		m[k] = true
	} else {
		delete(m, k)
	}
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	b, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(galleriesDir, optOutFilename), b, 0o644)
}

// EnsureDefaultExternalPacks installs all built-in third-party local libraries
// that are not yet installed and have not been explicitly uninstalled by the user.
// Only downloads lightweight ~1 MB JSON indices from Gitee (with GitHub fallback);
// images remain strictly on-demand and local-only.
func EnsureDefaultExternalPacks(ctx context.Context, galleriesDir string) int {
	if galleriesDir == "" {
		return 0
	}
	optedOut := loadOptedOutPacks(galleriesDir)
	var todo []string
	for _, spec := range ruicPackCatalog {
		if optedOut[spec.ID] {
			continue
		}
		if st, err := os.Stat(filepath.Join(galleriesDir, spec.ID+".json")); err == nil && !st.IsDir() && st.Size() > 0 {
			continue
		}
		todo = append(todo, spec.ID)
	}
	if len(todo) == 0 {
		return 0
	}
	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		installed int
	)
	for _, id := range todo {
		wg.Add(1)
		go func(packID string) {
			defer wg.Done()
			if _, err := InstallExternalPack(ctx, galleriesDir, packID, RuiCMirrorGitee); err == nil {
				mu.Lock()
				installed++
				mu.Unlock()
			}
		}(id)
	}
	wg.Wait()
	return installed
}

// InvalidateFileCache clears cached directory JSON snapshots (call after install/uninstall).
func (r *Registry) InvalidateFileCache() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.fileCache = map[string]cachedFileEntry{}
	cb := r.OnChange
	r.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func findExternalPack(id string) (ExternalPackStatus, bool) {
	id = strings.ToLower(strings.TrimSpace(id))
	for _, s := range ruicPackCatalog {
		if s.ID == id {
			return s, true
		}
	}
	return ExternalPackStatus{}, false
}

func mirrorOrder(preferred string) []string {
	switch strings.ToLower(strings.TrimSpace(preferred)) {
	case RuiCMirrorGitHub:
		return []string{RuiCMirrorGitHub, RuiCMirrorGitee}
	default:
		// Default to China Gitee mirror, with automatic GitHub fallback.
		return []string{RuiCMirrorGitee, RuiCMirrorGitHub}
	}
}

// ---------- On-Demand Local Disk Image Cache (with singleflight dedup) ----------

type inflightFetch struct {
	done chan struct{}
	path string
	err  error
}

var (
	inflightMu  sync.Mutex
	inflightMap = map[string]*inflightFetch{}
)

// EnsureCachedImage guarantees the image described by target exists on disk
// (serving immediately if already cached, otherwise downloading once from
// RemoteURLs into CachePath atomically).
func EnsureCachedImage(ctx context.Context, target ImageTarget) (string, error) {
	if target.LocalPath != "" {
		if st, err := os.Stat(target.LocalPath); err == nil && !st.IsDir() && st.Size() > 0 {
			return target.LocalPath, nil
		}
	}
	if target.CachePath == "" || len(target.RemoteURLs) == 0 {
		return "", ErrNotFound
	}
	if st, err := os.Stat(target.CachePath); err == nil && !st.IsDir() && st.Size() > 0 {
		return target.CachePath, nil
	}

	inflightMu.Lock()
	if cur, ok := inflightMap[target.CachePath]; ok {
		inflightMu.Unlock()
		select {
		case <-cur.done:
			return cur.path, cur.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	call := &inflightFetch{done: make(chan struct{})}
	inflightMap[target.CachePath] = call
	inflightMu.Unlock()

	defer func() {
		inflightMu.Lock()
		delete(inflightMap, target.CachePath)
		inflightMu.Unlock()
		close(call.done)
	}()

	var (
		data    []byte
		lastErr error
	)
	for _, u := range target.RemoteURLs {
		b, err := fetchImageBytes(ctx, u)
		if err == nil && len(b) > 0 {
			data = b
			break
		}
		lastErr = err
	}
	if len(data) == 0 {
		if lastErr == nil {
			lastErr = ErrNotFound
		}
		call.err = lastErr
		return "", lastErr
	}

	if err := os.MkdirAll(filepath.Dir(target.CachePath), 0o755); err != nil {
		call.err = err
		return "", err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", target.CachePath, time.Now().UnixNano())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		call.err = err
		return "", err
	}
	if err := os.Rename(tmp, target.CachePath); err != nil {
		_ = os.Remove(tmp)
		// Another writer may have won the race.
		if st, sErr := os.Stat(target.CachePath); sErr == nil && !st.IsDir() && st.Size() > 0 {
			call.path = target.CachePath
			return target.CachePath, nil
		}
		call.err = err
		return "", err
	}
	call.path = target.CachePath
	return target.CachePath, nil
}

func fetchBytes(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Handraw-Client/1.0")
	resp, err := ruicHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, rawURL)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func fetchImageBytes(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Handraw-Client/1.0")
	resp, err := ruicHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "text/html") {
		return nil, fmt.Errorf("unexpected HTML response")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxGalleryImgBytes))
	if err != nil {
		return nil, err
	}
	if len(data) < 16 {
		return nil, fmt.Errorf("image too small")
	}
	return data, nil
}

// ---------- Converters for RuiC-PoseAtlas data/*.json ----------

func convertRuiCPoses(raw []byte, rawBase, mirror string) (Registration, error) {
	var doc struct {
		Angles []struct {
			Key   string            `json:"key"`
			Names map[string]string `json:"names"`
		} `json:"angles"`
		Series []struct {
			Key   string            `json:"key"`
			Names map[string]string `json:"names"`
			Short map[string]string `json:"short"`
		} `json:"series"`
		Poses []struct {
			ID       string            `json:"id"`
			Series   string            `json:"series"`
			Category string            `json:"category"`
			No       string            `json:"no"`
			Names    map[string]string `json:"names"`
			Variants []struct {
				Angle string `json:"angle"`
				Thumb string `json:"thumb"`
				Full  string `json:"full"`
			} `json:"variants"`
		} `json:"poses"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Registration{}, fmt.Errorf("解析 poses.json 失败：%w", err)
	}

	angleLabelZh := map[string]string{
		"front": "正面", "diagonal": "斜侧", "side": "侧面", "high": "俯视", "low": "仰视",
	}
	angleLabelEn := map[string]string{
		"front": "Front", "diagonal": "Three-quarter", "side": "Side", "high": "High angle", "low": "Low angle",
	}
	for _, a := range doc.Angles {
		if zh := strings.TrimSpace(a.Names["zh"]); zh != "" {
			angleLabelZh[a.Key] = zh
		}
		if en := strings.TrimSpace(a.Names["en"]); en != "" {
			angleLabelEn[a.Key] = en
		}
	}
	// Canonical 5-angle order for predictable left-to-right chips.
	angleOrder := map[string]int{"front": 0, "diagonal": 1, "side": 2, "high": 3, "low": 4}

	seriesName := map[string]string{}
	seriesShort := map[string]string{}
	for _, s := range doc.Series {
		seriesName[s.Key] = firstNonEmpty(s.Names["zh"], s.Short["zh"], s.Key)
		seriesShort[s.Key] = firstNonEmpty(s.Short["zh"], s.Names["zh"], s.Key)
	}

	supportsRef := true
	items := make([]Item, 0, len(doc.Poses))
	for _, p := range doc.Poses {
		if strings.TrimSpace(p.ID) == "" || len(p.Variants) == 0 {
			continue
		}
		nameZh := firstNonEmpty(p.Names["zh"], p.Names["en"], p.ID)
		nameEn := strings.TrimSpace(p.Names["en"])
		sShort := firstNonEmpty(seriesShort[p.Series], p.Series)
		sFull := firstNonEmpty(seriesName[p.Series], sShort)
		cat := firstNonEmpty(p.Category, "其他")

		vars := make([]Variant, 0, len(p.Variants))
		for _, v := range p.Variants {
			k := strings.TrimSpace(v.Angle)
			if k == "" {
				continue
			}
			relThumb := strings.TrimLeft(v.Thumb, "/")
			relFull := strings.TrimLeft(v.Full, "/")
			vars = append(vars, Variant{
				Key:         k,
				Label:       firstNonEmpty(angleLabelZh[k], k),
				LabelEn:     firstNonEmpty(angleLabelEn[k], k),
				Thumb:       RuiCCacheSubdir + "/" + relThumb,
				Image:       RuiCCacheSubdir + "/" + relFull,
				RemoteThumb: rawBase + relThumb,
				RemoteImage: rawBase + relFull,
			})
		}
		// Sort variants into canonical [front, diagonal, side, high, low] order.
		for i := 0; i < len(vars); i++ {
			for j := i + 1; j < len(vars); j++ {
				oi, oki := angleOrder[vars[i].Key]
				if !oki {
					oi = 99
				}
				oj, okj := angleOrder[vars[j].Key]
				if !okj {
					oj = 99
				}
				if oj < oi {
					vars[i], vars[j] = vars[j], vars[i]
				}
			}
		}
		if len(vars) == 0 {
			continue
		}
		tags := []string{sShort, cat}
		if p.No != "" {
			tags = append(tags, p.No)
		}
		items = append(items, Item{
			ID:           p.ID,
			Name:         nameZh,
			NameEn:       nameEn,
			Category:     cat,
			CategoryName: cat,
			Tags:         tags,
			Traits:       fmt.Sprintf("%s · %s · %d视角", sShort, cat, len(vars)),
			PromptZh:     fmt.Sprintf("参考人物姿态：%s（%s，%s）", nameZh, sFull, cat),
			PromptEn:     nameEn,
			Thumb:        vars[0].Thumb,
			Image:        vars[0].Image,
			RemoteThumb:  vars[0].RemoteThumb,
			RemoteImage:  vars[0].RemoteImage,
			Variants:     vars,
			Source:       "third-party",
			Author:       "RuiC-PoseAtlas (MIT)",
			Meta: map[string]any{
				"series":      p.Series,
				"seriesName":  sFull,
				"seriesShort": sShort,
				"no":          p.No,
				"localOnly":   true,
			},
		})
	}

	return Registration{
		ID:               "ruic-poses",
		Name:             "姿态图鉴",
		NameEn:           "RuiC Poses",
		Description:      "RuiC-PoseAtlas 姿态参考（288 组 × 5 视角线稿 · 仅本机缓存，不同步至网站）",
		Icon:             "🧍",
		Source:           "third-party",
		PromptRole:       "pose",
		SupportsRefImage: &supportsRef,
		LocalOnly:        true,
		MultiVariant:     true,
		UpstreamURL:      RuiCRepoGitHubURL,
		Mirror:           mirror,
		License:          "MIT",
		Items:            items,
	}, nil
}

func convertRuiCCostumes(raw []byte, rawBase, mirror string) (Registration, error) {
	var doc struct {
		Categories []struct {
			Key   string            `json:"key"`
			Names map[string]string `json:"names"`
		} `json:"categories"`
		Groups []struct {
			Key   string            `json:"key"`
			Names map[string]string `json:"names"`
		} `json:"groups"`
		Costumes []struct {
			ID    string   `json:"id"`
			Cat   string   `json:"cat"`
			Group string   `json:"group"`
			Color string   `json:"color"`
			Main  string   `json:"main"`
			Tags  []string `json:"tags"`
			Thumb string   `json:"thumb"`
			Image string   `json:"image"`
		} `json:"costumes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Registration{}, fmt.Errorf("解析 costumes.json 失败：%w", err)
	}
	catName := map[string]string{}
	for _, c := range doc.Categories {
		catName[c.Key] = firstNonEmpty(c.Names["zh"], c.Names["en"], c.Key)
	}
	grpName := map[string]string{}
	for _, g := range doc.Groups {
		grpName[g.Key] = firstNonEmpty(g.Names["zh"], g.Names["en"], g.Key)
	}

	supportsRef := true
	items := make([]Item, 0, len(doc.Costumes))
	for _, c := range doc.Costumes {
		if strings.TrimSpace(c.ID) == "" {
			continue
		}
		cZh := firstNonEmpty(catName[c.Cat], c.Cat, "其他")
		gZh := firstNonEmpty(grpName[c.Group], c.Group, "服饰")
		relThumb := strings.TrimLeft(c.Thumb, "/")
		relImg := strings.TrimLeft(c.Image, "/")
		tags := []string{cZh, gZh}
		if c.Color != "" {
			tags = append(tags, c.Color)
		}
		if c.Main != "" {
			tags = append(tags, c.Main)
		}
		for _, t := range c.Tags {
			if len(tags) >= 8 {
				break
			}
			if t = strings.TrimSpace(t); t != "" {
				tags = append(tags, t)
			}
		}
		traitsParts := []string{cZh, gZh}
		if c.Color != "" {
			traitsParts = append(traitsParts, c.Color)
		}
		if c.Main != "" {
			traitsParts = append(traitsParts, c.Main)
		}
		items = append(items, Item{
			ID:           c.ID,
			Name:         fmt.Sprintf("%s · %s", gZh, c.ID),
			Category:     firstNonEmpty(c.Cat, "other"),
			CategoryName: cZh,
			Tags:         tags,
			Traits:       strings.Join(traitsParts, " · "),
			PromptZh:     fmt.Sprintf("参考服装穿搭：%s（%s，%s）", gZh, cZh, strings.Join(c.Tags, ", ")),
			PromptEn:     strings.Join(c.Tags, ", "),
			Thumb:        RuiCCacheSubdir + "/" + relThumb,
			Image:        RuiCCacheSubdir + "/" + relImg,
			RemoteThumb:  rawBase + relThumb,
			RemoteImage:  rawBase + relImg,
			Source:       "third-party",
			Author:       "RuiC-PoseAtlas (MIT)",
			Meta: map[string]any{
				"group":     c.Group,
				"groupName": gZh,
				"color":     c.Color,
				"main":      c.Main,
				"localOnly": true,
			},
		})
	}

	return Registration{
		ID:               "ruic-costumes",
		Name:             "衣装图鉴",
		NameEn:           "RuiC Costumes",
		Description:      "RuiC-PoseAtlas 衣装参考（1,407 套无人物服饰 · 仅本机缓存，不同步至网站）",
		Icon:             "👗",
		Source:           "third-party",
		PromptRole:       "costume",
		SupportsRefImage: &supportsRef,
		LocalOnly:        true,
		UpstreamURL:      RuiCRepoGitHubURL,
		Mirror:           mirror,
		License:          "MIT",
		Items:            items,
	}, nil
}

func convertRuiCFaces(raw []byte, rawBase, mirror string) (Registration, error) {
	var doc struct {
		Sections []struct {
			Key   string            `json:"key"`
			Names map[string]string `json:"names"`
		} `json:"sections"`
		Hairs []struct {
			Key   string            `json:"key"`
			Names map[string]string `json:"names"`
		} `json:"hairs"`
		Images []struct {
			ID          string `json:"id"`
			Sec         string `json:"sec"`
			Hair        string `json:"hair"`
			Style       string `json:"style"`
			Thumb       string `json:"thumb"`
			Full        string `json:"full"`
			ThumbRemote string `json:"thumb_remote"`
			FullRemote  string `json:"full_remote"`
		} `json:"images"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Registration{}, fmt.Errorf("解析 faces.json 失败：%w", err)
	}
	secName := map[string]string{"face": "脸部", "styling": "造型"}
	for _, s := range doc.Sections {
		secName[s.Key] = firstNonEmpty(s.Names["zh"], s.Names["en"], s.Key)
	}
	hairName := map[string]string{"short": "短发", "medium": "中发", "semilong": "中长发", "long": "长发"}
	for _, h := range doc.Hairs {
		hairName[h.Key] = firstNonEmpty(h.Names["zh"], h.Names["en"], h.Key)
	}

	supportsRef := true
	items := make([]Item, 0, len(doc.Images))
	for _, f := range doc.Images {
		if strings.TrimSpace(f.ID) == "" {
			continue
		}
		secKey := firstNonEmpty(f.Sec, "face")
		hairKey := firstNonEmpty(f.Hair, "short")
		sZh := firstNonEmpty(secName[secKey], secKey)
		hZh := firstNonEmpty(hairName[hairKey], hairKey)
		catKey := secKey + "_" + hairKey
		catLabel := sZh + " · " + hZh
		relThumb := strings.TrimLeft(f.Thumb, "/")
		relFull := strings.TrimLeft(firstNonEmpty(f.Full, f.Thumb), "/")
		// Thumbs live directly in Gitee/GitHub repo; full_remote lives on external CDN,
		// so ResolveImageTarget falls back to Gitee thumb automatically if full_remote is blocked.
		remoteThumb := rawBase + relThumb
		remoteFull := firstNonEmpty(strings.TrimSpace(f.FullRemote), remoteThumb)

		tags := []string{sZh, hZh}
		if strings.TrimSpace(f.Style) != "" {
			tags = append(tags, strings.TrimSpace(f.Style))
		}
		items = append(items, Item{
			ID:           f.ID,
			Name:         fmt.Sprintf("%s · %s", catLabel, f.ID[:minInt(6, len(f.ID))]),
			Category:     catKey,
			CategoryName: catLabel,
			Tags:         tags,
			Traits:       catLabel,
			PromptZh:     fmt.Sprintf("参考人物面部与发型气质（%s）", catLabel),
			Thumb:        RuiCCacheSubdir + "/" + relThumb,
			Image:        RuiCCacheSubdir + "/" + relFull,
			RemoteThumb:  remoteThumb,
			RemoteImage:  remoteFull,
			Source:       "third-party",
			Author:       "RuiC-PoseAtlas (MIT)",
			Meta: map[string]any{
				"section":   secKey,
				"hair":      hairKey,
				"localOnly": true,
			},
		})
	}

	return Registration{
		ID:               "ruic-faces",
		Name:             "人像图鉴",
		NameEn:           "RuiC Faces",
		Description:      "RuiC-PoseAtlas 人像参考（1,499 张脸部与造型参考 · 仅本机缓存，不同步至网站）",
		Icon:             "🙂",
		Source:           "third-party",
		PromptRole:       "face",
		SupportsRefImage: &supportsRef,
		LocalOnly:        true,
		UpstreamURL:      RuiCRepoGitHubURL,
		Mirror:           mirror,
		License:          "MIT",
		Items:            items,
	}, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
