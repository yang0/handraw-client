package galleries

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	OfficialGalleryMarketGiteeURL  = "https://gitee.com/yang02010/handraw-galleries/raw/main/index.json"
	OfficialGalleryMarketGitHubURL = "https://raw.githubusercontent.com/yang0/handraw-galleries/main/index.json"
	OfficialGalleryMarketURL       = OfficialGalleryMarketGitHubURL
	StandardRuiCRepoGitHubURL      = "https://github.com/yang0/handraw-gallery-ruic-poseatlas"
	StandardRuiCRepoGiteeURL       = "https://gitee.com/yang02010/handraw-gallery-ruic-poseatlas"
	StandardRuiCRawBaseGitee       = "https://gitee.com/yang02010/handraw-gallery-ruic-poseatlas/raw/main/galleries/"
	StandardRuiCRawBaseGitHub      = "https://raw.githubusercontent.com/yang0/handraw-gallery-ruic-poseatlas/main/galleries/"
	maxMarketIndexBytes            = 4 << 20   // 4 MiB max for index.json
	maxGalleryJSONBytes            = 24 << 20  // 24 MiB max for a single gallery JSON
	maxGalleryZipBytes             = 150 << 20 // 150 MiB max for a zip gallery pack
	marketCacheTTL                 = 5 * time.Minute
	marketMetaFile                 = ".gallery-market-meta.json"
)

// MarketSource is one subscribed Format 1 gallery market index URL (with optional mirrors).
type MarketSource struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	URL      string            `json:"url"`
	Mirrors  map[string]string `json:"mirrors,omitempty"`
	Official bool              `json:"official,omitempty"`
	Enabled  bool              `json:"enabled"`
}

// MarketLocalized holds Chinese/English labels.
type MarketLocalized struct {
	Zh string `json:"zh,omitempty"`
	En string `json:"en,omitempty"`
}

func (l MarketLocalized) Label() string {
	return firstNonEmpty(strings.TrimSpace(l.Zh), strings.TrimSpace(l.En))
}

// MarketIndex is Format 1 of the Handraw Gallery Market index.json (#122, #123).
type MarketIndex struct {
	Format      int               `json:"format"`
	Title       MarketLocalized   `json:"title,omitempty"`
	Description MarketLocalized   `json:"description,omitempty"`
	Mirrors     map[string]string `json:"mirrors,omitempty"`
	Metadata    struct {
		Categories map[string]struct {
			Title MarketLocalized `json:"title"`
		} `json:"categories,omitempty"`
		Labels map[string]struct {
			Title MarketLocalized `json:"title"`
		} `json:"labels,omitempty"`
	} `json:"metadata,omitempty"`
	Galleries []MarketGallery `json:"galleries"`
}

// MarketGallerySource describes how the client installs one gallery plugin.
type MarketGallerySource struct {
	Type        string            `json:"type"` // ruic-poseatlas | json | zip
	URL         string            `json:"url,omitempty"`
	BaseURL     string            `json:"baseUrl,omitempty"`
	PackID      string            `json:"packId,omitempty"`
	DataPath    string            `json:"dataPath,omitempty"`
	Mirrors     map[string]string `json:"mirrors,omitempty"`
	UpstreamURL string            `json:"upstreamUrl,omitempty"`
	MirrorURL   string            `json:"mirrorUrl,omitempty"`
}

// MarketGallery is one gallery plugin entry in a Format 1 market index.json.
type MarketGallery struct {
	ID               string              `json:"id"`
	Version          string              `json:"version,omitempty"`
	Name             string              `json:"name"`
	NameEn           string              `json:"nameEn,omitempty"`
	Badge            string              `json:"badge,omitempty"`
	Description      string              `json:"description,omitempty"`
	Author           string              `json:"author,omitempty"`
	License          string              `json:"license,omitempty"`
	Homepage         string              `json:"homepage,omitempty"`
	Categories       []string            `json:"categories,omitempty"`
	Labels           []string            `json:"labels,omitempty"`
	MultiVariant     bool                `json:"multiVariant,omitempty"`
	LocalOnly        bool                `json:"localOnly,omitempty"`
	PromptRole       string              `json:"promptRole,omitempty"`
	SupportsRefImage *bool               `json:"supportsRefImage,omitempty"`
	Source           MarketGallerySource `json:"source"`
}

// MarketSourceStatus reports the live fetch state of one subscribed market source.
type MarketSourceStatus struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	ActiveMirror string `json:"activeMirror,omitempty"`
	ActiveURL    string `json:"activeUrl,omitempty"`
	Official     bool   `json:"official,omitempty"`
	Enabled      bool   `json:"enabled"`
	Count        int    `json:"count"`
	Error        string `json:"error,omitempty"`
	Fallback     bool   `json:"fallback,omitempty"`
}

// MarketPackStatus is the merged view returned to the client UI for every
// available or locally installed extension gallery plugin.
type MarketPackStatus struct {
	ID               string              `json:"id"`
	Version          string              `json:"version,omitempty"`
	InstalledVersion string              `json:"installedVersion,omitempty"`
	HasUpdate        bool                `json:"hasUpdate,omitempty"`
	Name             string              `json:"name"`
	NameEn           string              `json:"nameEn,omitempty"`
	Description      string              `json:"description,omitempty"`
	Badge            string              `json:"badge,omitempty"`
	Author           string              `json:"author,omitempty"`
	License          string              `json:"license,omitempty"`
	Homepage         string              `json:"homepage,omitempty"`
	Categories       []string            `json:"categories,omitempty"`
	Labels           []string            `json:"labels,omitempty"`
	MultiVariant     bool                `json:"multiVariant,omitempty"`
	LocalOnly        bool                `json:"localOnly"`
	PromptRole       string              `json:"promptRole,omitempty"`
	SupportsRefImage bool                `json:"supportsRefImage"`
	SourceType       string              `json:"sourceType"`
	UpstreamURL      string              `json:"upstreamUrl,omitempty"`
	MirrorURL        string              `json:"mirrorUrl,omitempty"`
	Source           MarketGallerySource `json:"source,omitempty"`
	MarketID         string              `json:"marketId,omitempty"`
	MarketName       string              `json:"marketName,omitempty"`
	MarketURL        string              `json:"marketUrl,omitempty"`
	Installed        bool                `json:"installed"`
	CustomInstall    bool                `json:"customInstall,omitempty"`
	Mirror           string              `json:"mirror,omitempty"`
	ItemCount        int                 `json:"itemCount,omitempty"`
	CachedFiles      int                 `json:"cachedFiles,omitempty"`
	CachedBytes      int64               `json:"cachedBytes,omitempty"`
}

// MarketCatalogResult is returned by ListMarketPacks / GET /api/galleries/market.
type MarketCatalogResult struct {
	DefaultMirror string               `json:"defaultMirror"`
	Sources       []MarketSourceStatus `json:"sources"`
	Categories    []Category           `json:"categories"`
	Packs         []MarketPackStatus   `json:"packs"`
}

type installedPackMeta struct {
	ID          string `json:"id"`
	Version     string `json:"version,omitempty"`
	SourceType  string `json:"sourceType,omitempty"`
	SourceURL   string `json:"sourceUrl,omitempty"`
	MarketID    string `json:"marketId,omitempty"`
	MarketName  string `json:"marketName,omitempty"`
	Mirror      string `json:"mirror,omitempty"`
	InstalledAt string `json:"installedAt,omitempty"`
}

type marketCacheEntry struct {
	fetchedAt time.Time
	index     MarketIndex
}

var (
	marketCacheMu sync.Mutex
	marketCache   = map[string]marketCacheEntry{}
)

// ClearMarketCache drops the in-memory market index cache (useful in tests or manual refresh).
func ClearMarketCache() {
	marketCacheMu.Lock()
	marketCache = map[string]marketCacheEntry{}
	marketCacheMu.Unlock()
}

// BuiltinFallbackGalleries returns the curated Standard Format 1 fallback catalog
// matching yang0/handraw-galleries (and its Gitee mirror yang02010/handraw-galleries)
// so users can still discover and install standard gallery manifests if both market
// index mirrors are temporarily unreachable (#123).
func BuiltinFallbackGalleries() []MarketGallery {
	t := true
	return []MarketGallery{
		{
			ID:               "ruic-poses",
			Version:          "1.0.0",
			Name:             "姿态图鉴",
			NameEn:           "RuiC Poses",
			Badge:            "288组 × 5视角",
			Description:      "288 组人体姿态 × 5 视角（正面/斜侧/侧面/俯视/仰视）共 1,439 张人台线稿参考，支持精确选角度入图。",
			Author:           "HRuiCcc",
			License:          "MIT",
			Homepage:         RuiCRepoGitHubURL,
			Categories:       []string{"pose"},
			Labels:           []string{"official-curated", "open-source", "local-only", "multi-variant"},
			MultiVariant:     true,
			LocalOnly:        true,
			PromptRole:       "pose",
			SupportsRefImage: &t,
			Source: MarketGallerySource{
				Type: "json",
				URL:  StandardRuiCRawBaseGitHub + "ruic-poses.json",
				Mirrors: map[string]string{
					RuiCMirrorGitee:  StandardRuiCRawBaseGitee + "ruic-poses.json",
					RuiCMirrorGitHub: StandardRuiCRawBaseGitHub + "ruic-poses.json",
				},
				UpstreamURL: StandardRuiCRepoGitHubURL,
				MirrorURL:   StandardRuiCRepoGiteeURL,
			},
		},
		{
			ID:               "ruic-costumes",
			Version:          "1.0.0",
			Name:             "衣装图鉴",
			NameEn:           "RuiC Costumes",
			Badge:            "1,407 套服饰",
			Description:      "1,407 套无人物服饰单品图鉴 × 8 季节与风格分类，适合固定穿搭、服饰材质与廓形参考。",
			Author:           "HRuiCcc",
			License:          "MIT",
			Homepage:         RuiCRepoGitHubURL,
			Categories:       []string{"costume"},
			Labels:           []string{"official-curated", "open-source", "local-only"},
			LocalOnly:        true,
			PromptRole:       "costume",
			SupportsRefImage: &t,
			Source: MarketGallerySource{
				Type: "json",
				URL:  StandardRuiCRawBaseGitHub + "ruic-costumes.json",
				Mirrors: map[string]string{
					RuiCMirrorGitee:  StandardRuiCRawBaseGitee + "ruic-costumes.json",
					RuiCMirrorGitHub: StandardRuiCRawBaseGitHub + "ruic-costumes.json",
				},
				UpstreamURL: StandardRuiCRepoGitHubURL,
				MirrorURL:   StandardRuiCRepoGiteeURL,
			},
		},
		{
			ID:               "ruic-faces",
			Version:          "1.0.0",
			Name:             "人像图鉴",
			NameEn:           "RuiC Faces",
			Badge:            "1,499 张人像",
			Description:      "1,499 张正面脸部与造型参考，按脸部/造型与 4 种发长分类，适合固定角色颜值与发型气质。",
			Author:           "HRuiCcc",
			License:          "MIT",
			Homepage:         RuiCRepoGitHubURL,
			Categories:       []string{"portrait"},
			Labels:           []string{"official-curated", "open-source", "local-only"},
			LocalOnly:        true,
			PromptRole:       "face",
			SupportsRefImage: &t,
			Source: MarketGallerySource{
				Type: "json",
				URL:  StandardRuiCRawBaseGitHub + "ruic-faces.json",
				Mirrors: map[string]string{
					RuiCMirrorGitee:  StandardRuiCRawBaseGitee + "ruic-faces.json",
					RuiCMirrorGitHub: StandardRuiCRawBaseGitHub + "ruic-faces.json",
				},
				UpstreamURL: StandardRuiCRepoGitHubURL,
				MirrorURL:   StandardRuiCRepoGiteeURL,
			},
		},
	}
}

// FetchMarketIndex downloads and parses a Format 1 gallery market index.json.
func FetchMarketIndex(ctx context.Context, rawURL string, forceRefresh bool) (MarketIndex, error) {
	rawURL = strings.TrimSpace(rawURL)
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://") {
		return MarketIndex{}, errors.New("图库市场地址必须以 http:// 或 https:// 开头")
	}
	if !forceRefresh {
		marketCacheMu.Lock()
		ent, ok := marketCache[rawURL]
		marketCacheMu.Unlock()
		if ok && time.Since(ent.fetchedAt) < marketCacheTTL {
			return ent.index, nil
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return MarketIndex{}, err
	}
	req.Header.Set("User-Agent", "handraw-client")
	req.Header.Set("Accept", "application/json")
	resp, err := ruicHTTPClient.Do(req)
	if err != nil {
		return MarketIndex{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return MarketIndex{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxMarketIndexBytes))
	if err != nil {
		return MarketIndex{}, err
	}
	var idx MarketIndex
	if err := json.Unmarshal(body, &idx); err != nil {
		return MarketIndex{}, fmt.Errorf("图库市场索引 JSON 无法解析：%w", err)
	}
	if len(idx.Galleries) == 0 {
		return MarketIndex{}, errors.New("图库市场索引中不包含任何 galleries 条目")
	}
	marketCacheMu.Lock()
	marketCache[rawURL] = marketCacheEntry{fetchedAt: time.Now(), index: idx}
	marketCacheMu.Unlock()
	return idx, nil
}

type mirrorCandidate struct {
	mirror string
	url    string
}

func marketSourceCandidates(src MarketSource, preferredMirror string) []mirrorCandidate {
	var out []mirrorCandidate
	seen := map[string]bool{}
	add := func(m, u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			seen[u] = true
			out = append(out, mirrorCandidate{mirror: m, url: u})
		}
	}
	pref := strings.ToLower(strings.TrimSpace(preferredMirror))
	if pref != RuiCMirrorGitHub {
		pref = RuiCMirrorGitee
	}
	if len(src.Mirrors) > 0 {
		add(pref, src.Mirrors[pref])
		for _, k := range mirrorOrder(pref) {
			add(k, src.Mirrors[k])
		}
		for k, v := range src.Mirrors {
			add(k, v)
		}
	}
	add("", src.URL)
	return out
}

// FetchMarketIndexForSource tries the preferred mirror first (default Gitee in China)
// and falls back across other configured mirrors and the primary URL (#123).
func FetchMarketIndexForSource(ctx context.Context, src MarketSource, preferredMirror string, forceRefresh bool) (MarketIndex, string, string, error) {
	cands := marketSourceCandidates(src, preferredMirror)
	if len(cands) == 0 {
		return MarketIndex{}, "", "", errors.New("图库市场源未配置有效地址")
	}
	var lastErr error
	for _, c := range cands {
		idx, err := FetchMarketIndex(ctx, c.url, forceRefresh)
		if err == nil {
			return idx, c.mirror, c.url, nil
		}
		lastErr = err
	}
	return MarketIndex{}, "", "", lastErr
}

// ListMarketPacks merges all enabled gallery market sources with local install
// state and any locally installed standalone gallery JSON packs.
func ListMarketPacks(ctx context.Context, galleriesDir string, sources []MarketSource, preferredMirror string, forceRefresh bool) MarketCatalogResult {
	metaMap := readAllInstallMeta(galleriesDir)
	catLabels := map[string]string{
		"pose":      "人体姿态",
		"costume":   "服装穿搭",
		"portrait":  "人像与造型",
		"scene":     "场景与道具",
		"style":     "风格与色彩",
		"character": "角色设定",
		"layout":    "构图与版式",
		"custom":    "本地安装",
	}

	var srcStatuses []MarketSourceStatus
	byID := map[string]*MarketPackStatus{}
	order := []string{}

	addEntry := func(g MarketGallery, mID, mName, mURL string) {
		id := strings.ToLower(strings.TrimSpace(g.ID))
		if !ValidKind(id) || isCoreBuiltinKind(id) {
			return
		}
		if _, exists := byID[id]; exists {
			return
		}
		supportsRef := g.SupportsRefImage == nil || *g.SupportsRefImage
		srcType := strings.ToLower(strings.TrimSpace(g.Source.Type))
		if srcType == "" {
			if strings.HasSuffix(strings.ToLower(g.Source.URL), ".zip") {
				srcType = "zip"
			} else {
				srcType = "json"
			}
		}
		st := &MarketPackStatus{
			ID:               id,
			Version:          strings.TrimSpace(g.Version),
			Name:             firstNonEmpty(strings.TrimSpace(g.Name), id),
			NameEn:           strings.TrimSpace(g.NameEn),
			Description:      strings.TrimSpace(g.Description),
			Badge:            strings.TrimSpace(g.Badge),
			Author:           strings.TrimSpace(g.Author),
			License:          strings.TrimSpace(g.License),
			Homepage:         strings.TrimSpace(g.Homepage),
			Categories:       g.Categories,
			Labels:           g.Labels,
			MultiVariant:     g.MultiVariant,
			LocalOnly:        true,
			PromptRole:       strings.TrimSpace(g.PromptRole),
			SupportsRefImage: supportsRef,
			SourceType:       srcType,
			UpstreamURL:      firstNonEmpty(strings.TrimSpace(g.Source.UpstreamURL), strings.TrimSpace(g.Homepage)),
			MirrorURL:        strings.TrimSpace(g.Source.MirrorURL),
			Source:           g.Source,
			MarketID:         mID,
			MarketName:       mName,
			MarketURL:        mURL,
		}
		byID[id] = st
		order = append(order, id)
	}

	for _, src := range sources {
		sst := MarketSourceStatus{
			ID:       src.ID,
			Name:     firstNonEmpty(src.Name, src.ID),
			URL:      src.URL,
			Official: src.Official,
			Enabled:  src.Enabled,
		}
		if !src.Enabled {
			srcStatuses = append(srcStatuses, sst)
			continue
		}
		idx, activeMirror, activeURL, err := FetchMarketIndexForSource(ctx, src, preferredMirror, forceRefresh)
		if err != nil {
			sst.Error = err.Error()
			if src.Official {
				sst.Fallback = true
				fb := BuiltinFallbackGalleries()
				sst.Count = len(fb)
				for _, g := range fb {
					addEntry(g, src.ID, sst.Name, src.URL)
				}
			}
		} else {
			sst.ActiveMirror = activeMirror
			sst.ActiveURL = activeURL
			if title := idx.Title.Label(); title != "" && !src.Official {
				sst.Name = title
			}
			for ck, cv := range idx.Metadata.Categories {
				if lbl := cv.Title.Label(); lbl != "" {
					catLabels[ck] = lbl
				}
			}
			sst.Count = len(idx.Galleries)
			for _, g := range idx.Galleries {
				addEntry(g, src.ID, sst.Name, firstNonEmpty(activeURL, src.URL))
			}
		}
		srcStatuses = append(srcStatuses, sst)
	}

	// Scan locally installed gallery JSON files in galleriesDir and merge install state.
	if entries, err := os.ReadDir(galleriesDir); err == nil {
		for _, de := range entries {
			if de.IsDir() || !strings.HasSuffix(strings.ToLower(de.Name()), ".json") || strings.HasPrefix(de.Name(), ".") {
				continue
			}
			raw, rerr := os.ReadFile(filepath.Join(galleriesDir, de.Name()))
			if rerr != nil {
				continue
			}
			var reg Registration
			if json.Unmarshal(raw, &reg) != nil {
				continue
			}
			id := strings.ToLower(strings.TrimSpace(firstNonEmpty(reg.ID, strings.TrimSuffix(de.Name(), filepath.Ext(de.Name())))))
			if !ValidKind(id) || isCoreBuiltinKind(id) {
				continue
			}
			st, exists := byID[id]
			if !exists {
				im := metaMap[id]
				supportsRef := reg.SupportsRefImage == nil || *reg.SupportsRefImage
				st = &MarketPackStatus{
					ID:               id,
					Version:          im.Version,
					Name:             firstNonEmpty(strings.TrimSpace(reg.Name), id),
					NameEn:           strings.TrimSpace(reg.NameEn),
					Description:      strings.TrimSpace(reg.Description),
					Badge:            fmt.Sprintf("%d 条素材", len(reg.Items)),
					License:          strings.TrimSpace(reg.License),
					Categories:       []string{"custom"},
					MultiVariant:     reg.MultiVariant,
					LocalOnly:        true,
					PromptRole:       strings.TrimSpace(reg.PromptRole),
					SupportsRefImage: supportsRef,
					SourceType:       firstNonEmpty(im.SourceType, "json"),
					UpstreamURL:      firstNonEmpty(strings.TrimSpace(reg.UpstreamURL), im.SourceURL),
					MarketName:       firstNonEmpty(im.MarketName, "本地/链接安装"),
					CustomInstall:    true,
				}
				byID[id] = st
				order = append(order, id)
			}
			st.Installed = true
			st.ItemCount = len(reg.Items)
			if im, ok := metaMap[id]; ok {
				st.InstalledVersion = im.Version
				st.Mirror = firstNonEmpty(im.Mirror, reg.Mirror)
				if st.Version != "" && im.Version != "" && st.Version != im.Version {
					st.HasUpdate = true
				}
			} else {
				st.Mirror = firstNonEmpty(reg.Mirror, RuiCMirrorGitee)
			}
			st.CachedFiles, st.CachedBytes = genericPackCacheStats(galleriesDir, id)
		}
	}

	packs := make([]MarketPackStatus, 0, len(order))
	catCounts := map[string]int{}
	catOrder := []string{}
	for _, id := range order {
		st := byID[id]
		if !st.Installed {
			st.CachedFiles, st.CachedBytes = genericPackCacheStats(galleriesDir, id)
		}
		packs = append(packs, *st)
		for _, c := range st.Categories {
			if _, seen := catCounts[c]; !seen {
				catOrder = append(catOrder, c)
			}
			catCounts[c]++
		}
	}
	cats := make([]Category, 0, len(catOrder))
	for _, cid := range catOrder {
		cats = append(cats, Category{
			ID:    cid,
			Name:  firstNonEmpty(catLabels[cid], cid),
			Count: catCounts[cid],
		})
	}
	return MarketCatalogResult{
		DefaultMirror: RuiCMirrorGitee,
		Sources:       srcStatuses,
		Categories:    cats,
		Packs:         packs,
	}
}

func genericPackCacheStats(galleriesDir, packID string) (int, int64) {
	files := 0
	var totalBytes int64
	if _, ok := findExternalPack(packID); ok {
		lf, lb := packCacheStats(galleriesDir, packID)
		files += lf
		totalBytes += lb
	}
	for _, d := range []string{
		filepath.Join(galleriesDir, "cache", packID),
		filepath.Join(galleriesDir, packID),
	} {
		_ = filepath.WalkDir(d, func(_ string, de os.DirEntry, err error) error {
			if err != nil || de.IsDir() {
				return nil
			}
			if info, ierr := de.Info(); ierr == nil {
				files++
				totalBytes += info.Size()
			}
			return nil
		})
	}
	return files, totalBytes
}

// InstallMarketPack installs or updates one gallery entry from a MarketPackStatus.
func InstallMarketPack(ctx context.Context, galleriesDir string, pack MarketPackStatus, mirror string) (MarketPackStatus, error) {
	if err := os.MkdirAll(galleriesDir, 0o755); err != nil {
		return MarketPackStatus{}, err
	}
	mirror = strings.ToLower(strings.TrimSpace(mirror))
	if mirror != RuiCMirrorGitHub {
		mirror = RuiCMirrorGitee
	}

	switch strings.ToLower(strings.TrimSpace(pack.SourceType)) {
	case "ruic-poseatlas":
		pid := firstNonEmpty(pack.Source.PackID, pack.ID)
		st, err := InstallExternalPack(ctx, galleriesDir, pid, mirror)
		if err != nil {
			return MarketPackStatus{}, err
		}
		saveInstallMeta(galleriesDir, installedPackMeta{
			ID:          st.ID,
			Version:     firstNonEmpty(pack.Version, "1.0.0"),
			SourceType:  "ruic-poseatlas",
			SourceURL:   pack.UpstreamURL,
			MarketID:    pack.MarketID,
			MarketName:  pack.MarketName,
			Mirror:      st.Mirror,
			InstalledAt: time.Now().UTC().Format(time.RFC3339),
		})
		out := pack
		out.Installed = true
		out.InstalledVersion = firstNonEmpty(pack.Version, "1.0.0")
		out.HasUpdate = false
		out.ItemCount = st.ItemCount
		out.Mirror = st.Mirror
		out.CachedFiles = st.CachedFiles
		out.CachedBytes = st.CachedBytes
		return out, nil

	case "zip":
		urls := candidateSourceURLs(pack.Source, mirror)
		if len(urls) == 0 {
			return MarketPackStatus{}, errors.New("图库条目缺少有效的 ZIP 下载地址")
		}
		return installZipFromURLs(ctx, galleriesDir, urls, pack, mirror)

	default: // "json"
		urls := candidateSourceURLs(pack.Source, mirror)
		if len(urls) == 0 {
			return MarketPackStatus{}, errors.New("图库条目缺少有效的 JSON 下载地址")
		}
		return installJSONFromURLs(ctx, galleriesDir, urls, pack, mirror)
	}
}

// InstallGalleryFromURL installs any third-party gallery plugin directly from a
// JSON or ZIP URL without needing a market index.
func InstallGalleryFromURL(ctx context.Context, galleriesDir, rawURL, idHint, mirror string) (MarketPackStatus, error) {
	rawURL = strings.TrimSpace(rawURL)
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://") {
		return MarketPackStatus{}, errors.New("图库链接必须以 http:// 或 https:// 开头")
	}
	if err := os.MkdirAll(galleriesDir, 0o755); err != nil {
		return MarketPackStatus{}, err
	}
	data, ct, err := downloadBytes(ctx, rawURL, maxGalleryZipBytes)
	if err != nil {
		return MarketPackStatus{}, fmt.Errorf("下载图库失败：%w", err)
	}
	pack := MarketPackStatus{
		ID:          strings.ToLower(strings.TrimSpace(idHint)),
		LocalOnly:   true,
		UpstreamURL: rawURL,
		MarketName:  "链接直装",
		Source:      MarketGallerySource{URL: rawURL},
	}
	isZip := strings.HasSuffix(strings.ToLower(strings.Split(rawURL, "?")[0]), ".zip") ||
		strings.Contains(strings.ToLower(ct), "zip") ||
		(len(data) >= 4 && data[0] == 'P' && data[1] == 'K' && data[2] == 3 && data[3] == 4)
	if isZip {
		pack.SourceType = "zip"
		pack.Source.Type = "zip"
		return installZipBytes(galleriesDir, data, rawURL, pack, mirror)
	}
	if len(data) > maxGalleryJSONBytes {
		return MarketPackStatus{}, errors.New("图库 JSON 体积超过上限（24 MB）")
	}
	pack.SourceType = "json"
	pack.Source.Type = "json"
	return installJSONBytes(galleriesDir, data, rawURL, pack, mirror)
}

// UninstallAnyPack uninstalls any standard JSON/ZIP or legacy extension gallery
// plugin cleanly, removing its manifest, unpacked directory, and local caches.
func UninstallAnyPack(galleriesDir, packID string, purgeCache bool) error {
	id := strings.ToLower(strings.TrimSpace(packID))
	if !ValidKind(id) || isCoreBuiltinKind(id) {
		return fmt.Errorf("无法卸载内置或无效图库 %q", packID)
	}
	if _, ok := findExternalPack(id); ok {
		_ = UninstallExternalPack(galleriesDir, id, purgeCache)
	}
	manifestPath := filepath.Join(galleriesDir, id+".json")
	if err := os.Remove(manifestPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	// Remove unpacked zip directory if present.
	_ = os.RemoveAll(filepath.Join(galleriesDir, id))
	if purgeCache {
		_ = os.RemoveAll(filepath.Join(galleriesDir, "cache", id))
	}
	deleteInstallMeta(galleriesDir, id)
	return nil
}

func candidateSourceURLs(src MarketGallerySource, mirror string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			seen[u] = true
			out = append(out, u)
		}
	}
	if mirror != "" && src.Mirrors != nil {
		add(src.Mirrors[mirror])
	}
	add(src.URL)
	for _, k := range []string{RuiCMirrorGitee, RuiCMirrorGitHub} {
		if src.Mirrors != nil {
			add(src.Mirrors[k])
		}
	}
	for _, v := range src.Mirrors {
		add(v)
	}
	return out
}

func downloadBytes(ctx context.Context, rawURL string, limit int64) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "handraw-client")
	resp, err := ruicHTTPClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(b)) > limit {
		return nil, "", fmt.Errorf("文件体积超过上限（%d MB）", limit>>20)
	}
	return b, resp.Header.Get("Content-Type"), nil
}

func installJSONFromURLs(ctx context.Context, galleriesDir string, urls []string, pack MarketPackStatus, mirror string) (MarketPackStatus, error) {
	var lastErr error
	for _, u := range urls {
		data, _, err := downloadBytes(ctx, u, maxGalleryJSONBytes)
		if err != nil {
			lastErr = err
			continue
		}
		return installJSONBytes(galleriesDir, data, u, pack, mirror)
	}
	if lastErr != nil {
		return MarketPackStatus{}, fmt.Errorf("下载图库 JSON 失败：%w", lastErr)
	}
	return MarketPackStatus{}, errors.New("下载图库 JSON 失败")
}

func installJSONBytes(galleriesDir string, data []byte, sourceURL string, pack MarketPackStatus, mirror string) (MarketPackStatus, error) {
	var reg Registration
	if err := json.Unmarshal(data, &reg); err != nil {
		return MarketPackStatus{}, fmt.Errorf("图库 JSON 无法解析：%w", err)
	}
	id := strings.ToLower(strings.TrimSpace(firstNonEmpty(pack.ID, reg.ID)))
	if id == "" {
		// Derive safe ID from URL filename if omitted.
		if parsed, err := url.Parse(sourceURL); err == nil {
			base := strings.TrimSuffix(path.Base(parsed.Path), path.Ext(parsed.Path))
			id = strings.ToLower(strings.ReplaceAll(base, " ", "-"))
		}
	}
	if !ValidKind(id) {
		return MarketPackStatus{}, fmt.Errorf("图库标识 %q 无效（仅允许小写字母、数字、短横线、下划线）", id)
	}
	if isCoreBuiltinKind(id) {
		return MarketPackStatus{}, fmt.Errorf("图库标识 %q 为系统内置画廊，不能覆盖", id)
	}
	if reg.Format == 0 {
		reg.Format = 1
	}
	reg.ID = id
	reg.Version = firstNonEmpty(strings.TrimSpace(reg.Version), strings.TrimSpace(pack.Version), "1.0.0")
	reg.Name = firstNonEmpty(strings.TrimSpace(reg.Name), strings.TrimSpace(pack.Name), id)
	reg.NameEn = firstNonEmpty(strings.TrimSpace(reg.NameEn), strings.TrimSpace(pack.NameEn))
	reg.Description = firstNonEmpty(strings.TrimSpace(reg.Description), strings.TrimSpace(pack.Description))
	reg.Author = firstNonEmpty(strings.TrimSpace(reg.Author), strings.TrimSpace(pack.Author))
	reg.License = firstNonEmpty(strings.TrimSpace(reg.License), strings.TrimSpace(pack.License))
	reg.PromptRole = firstNonEmpty(strings.TrimSpace(reg.PromptRole), strings.TrimSpace(pack.PromptRole))
	reg.UpstreamURL = firstNonEmpty(strings.TrimSpace(reg.UpstreamURL), strings.TrimSpace(pack.UpstreamURL), sourceURL)
	reg.LocalOnly = true
	if reg.Source == "" {
		reg.Source = "third-party"
	}
	if mirror != "" {
		reg.Mirror = mirror
	}

	baseURL := pickGalleryImageBaseURL(reg, pack.Source, sourceURL, mirror)
	for i := range reg.Items {
		it := &reg.Items[i]
		rawImgKey := strings.TrimSpace(it.RemoteImage)
		rawThumbKey := strings.TrimSpace(it.RemoteThumb)
		it.RemoteImage = resolveRemoteURL(baseURL, it.RemoteImage)
		it.RemoteThumb = resolveRemoteURL(baseURL, it.RemoteThumb)
		if it.RemoteImage != "" && strings.TrimSpace(it.Image) == "" {
			it.Image = cacheRelPath(id, it.ID, "full", firstNonEmpty(rawImgKey, it.RemoteImage))
		}
		if it.RemoteThumb != "" && strings.TrimSpace(it.Thumb) == "" {
			it.Thumb = cacheRelPath(id, it.ID, "thumb", firstNonEmpty(rawThumbKey, it.RemoteThumb))
		}
		for j := range it.Variants {
			v := &it.Variants[j]
			vImgKey := strings.TrimSpace(v.RemoteImage)
			vThumbKey := strings.TrimSpace(v.RemoteThumb)
			v.RemoteImage = resolveRemoteURL(baseURL, v.RemoteImage)
			v.RemoteThumb = resolveRemoteURL(baseURL, v.RemoteThumb)
			if v.RemoteImage != "" && strings.TrimSpace(v.Image) == "" {
				v.Image = cacheRelPath(id, it.ID+"_"+v.Key, "full", firstNonEmpty(vImgKey, v.RemoteImage))
			}
			if v.RemoteThumb != "" && strings.TrimSpace(v.Thumb) == "" {
				v.Thumb = cacheRelPath(id, it.ID+"_"+v.Key, "thumb", firstNonEmpty(vThumbKey, v.RemoteThumb))
			}
		}
	}

	encoded, err := json.Marshal(reg)
	if err != nil {
		return MarketPackStatus{}, err
	}
	if err := writeAtomicFile(filepath.Join(galleriesDir, id+".json"), encoded); err != nil {
		return MarketPackStatus{}, err
	}

	ver := firstNonEmpty(strings.TrimSpace(reg.Version), strings.TrimSpace(pack.Version), "1.0.0")
	saveInstallMeta(galleriesDir, installedPackMeta{
		ID:          id,
		Version:     ver,
		SourceType:  "json",
		SourceURL:   sourceURL,
		MarketID:    pack.MarketID,
		MarketName:  firstNonEmpty(pack.MarketName, "链接直装"),
		Mirror:      mirror,
		InstalledAt: time.Now().UTC().Format(time.RFC3339),
	})

	out := pack
	out.ID = id
	out.Name = reg.Name
	out.NameEn = reg.NameEn
	out.Description = reg.Description
	out.License = reg.License
	out.Installed = true
	out.InstalledVersion = ver
	out.HasUpdate = false
	out.ItemCount = len(reg.Items)
	out.Mirror = mirror
	out.CachedFiles, out.CachedBytes = genericPackCacheStats(galleriesDir, id)
	return out, nil
}

func installZipFromURLs(ctx context.Context, galleriesDir string, urls []string, pack MarketPackStatus, mirror string) (MarketPackStatus, error) {
	var lastErr error
	for _, u := range urls {
		data, _, err := downloadBytes(ctx, u, maxGalleryZipBytes)
		if err != nil {
			lastErr = err
			continue
		}
		return installZipBytes(galleriesDir, data, u, pack, mirror)
	}
	if lastErr != nil {
		return MarketPackStatus{}, fmt.Errorf("下载图库 ZIP 失败：%w", lastErr)
	}
	return MarketPackStatus{}, errors.New("下载图库 ZIP 失败")
}

func installZipBytes(galleriesDir string, data []byte, sourceURL string, pack MarketPackStatus, mirror string) (MarketPackStatus, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return MarketPackStatus{}, fmt.Errorf("ZIP 压缩包无法解析：%w", err)
	}

	// Find gallery.json (or <id>.json / single top-level json) inside the zip.
	var manifestEntry *zip.File
	var stripPrefix string
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		clean := path.Clean(strings.ReplaceAll(f.Name, "\\", "/"))
		if strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			return MarketPackStatus{}, errors.New("ZIP 包含不安全路径，已拒绝安装")
		}
		base := strings.ToLower(path.Base(clean))
		depth := strings.Count(clean, "/")
		if depth <= 1 && (base == "gallery.json" || (pack.ID != "" && base == strings.ToLower(pack.ID)+".json")) {
			manifestEntry = f
			if depth == 1 {
				stripPrefix = path.Dir(clean) + "/"
			}
			break
		}
	}
	if manifestEntry == nil {
		return MarketPackStatus{}, errors.New("ZIP 包内未找到 gallery.json 清单文件")
	}

	rc, err := manifestEntry.Open()
	if err != nil {
		return MarketPackStatus{}, err
	}
	manifestBytes, err := io.ReadAll(io.LimitReader(rc, maxGalleryJSONBytes))
	_ = rc.Close()
	if err != nil {
		return MarketPackStatus{}, err
	}

	var reg Registration
	if err := json.Unmarshal(manifestBytes, &reg); err != nil {
		return MarketPackStatus{}, fmt.Errorf("gallery.json 解析失败：%w", err)
	}
	id := strings.ToLower(strings.TrimSpace(firstNonEmpty(pack.ID, reg.ID)))
	if !ValidKind(id) {
		return MarketPackStatus{}, fmt.Errorf("图库标识 %q 无效", id)
	}
	if isCoreBuiltinKind(id) {
		return MarketPackStatus{}, fmt.Errorf("图库标识 %q 为系统内置画廊，不能覆盖", id)
	}

	destDir := filepath.Join(galleriesDir, id)
	_ = os.RemoveAll(destDir)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return MarketPackStatus{}, err
	}

	var totalUnpacked int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		clean := path.Clean(strings.ReplaceAll(f.Name, "\\", "/"))
		if strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			_ = os.RemoveAll(destDir)
			return MarketPackStatus{}, errors.New("ZIP 包含不安全路径")
		}
		rel := clean
		if stripPrefix != "" {
			if !strings.HasPrefix(clean, stripPrefix) {
				continue
			}
			rel = strings.TrimPrefix(clean, stripPrefix)
		}
		if rel == "" || rel == "." || strings.Contains(rel, "..") {
			continue
		}
		targetPath := filepath.Join(destDir, filepath.FromSlash(rel))
		if !isWithin(destDir, targetPath) {
			_ = os.RemoveAll(destDir)
			return MarketPackStatus{}, errors.New("ZIP 包含越界路径")
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			_ = os.RemoveAll(destDir)
			return MarketPackStatus{}, err
		}
		in, err := f.Open()
		if err != nil {
			_ = os.RemoveAll(destDir)
			return MarketPackStatus{}, err
		}
		outF, err := os.Create(targetPath)
		if err != nil {
			_ = in.Close()
			_ = os.RemoveAll(destDir)
			return MarketPackStatus{}, err
		}
		n, err := io.Copy(outF, io.LimitReader(in, maxGalleryImgBytes+1))
		_ = outF.Close()
		_ = in.Close()
		if err != nil || n > maxGalleryImgBytes {
			_ = os.RemoveAll(destDir)
			return MarketPackStatus{}, errors.New("ZIP 内单文件过大或写入失败")
		}
		totalUnpacked += n
		if totalUnpacked > maxGalleryZipBytes*2 {
			_ = os.RemoveAll(destDir)
			return MarketPackStatus{}, errors.New("ZIP 解压总大小超过安全上限")
		}
	}

	prefixRel := func(rel string) string {
		rel = strings.TrimSpace(strings.TrimPrefix(strings.ReplaceAll(rel, "\\", "/"), "./"))
		if rel == "" || filepath.IsAbs(rel) || strings.HasPrefix(rel, id+"/") {
			return rel
		}
		return id + "/" + rel
	}

	reg.ID = id
	reg.Name = firstNonEmpty(strings.TrimSpace(reg.Name), strings.TrimSpace(pack.Name), id)
	reg.NameEn = firstNonEmpty(strings.TrimSpace(reg.NameEn), strings.TrimSpace(pack.NameEn))
	reg.Description = firstNonEmpty(strings.TrimSpace(reg.Description), strings.TrimSpace(pack.Description))
	reg.License = firstNonEmpty(strings.TrimSpace(reg.License), strings.TrimSpace(pack.License))
	reg.UpstreamURL = firstNonEmpty(strings.TrimSpace(reg.UpstreamURL), strings.TrimSpace(pack.UpstreamURL), sourceURL)
	reg.LocalOnly = true
	if reg.Source == "" {
		reg.Source = "third-party"
	}
	for i := range reg.Items {
		reg.Items[i].Image = prefixRel(reg.Items[i].Image)
		reg.Items[i].Thumb = prefixRel(reg.Items[i].Thumb)
		for j := range reg.Items[i].Variants {
			reg.Items[i].Variants[j].Image = prefixRel(reg.Items[i].Variants[j].Image)
			reg.Items[i].Variants[j].Thumb = prefixRel(reg.Items[i].Variants[j].Thumb)
		}
	}

	encoded, err := json.Marshal(reg)
	if err != nil {
		return MarketPackStatus{}, err
	}
	if err := writeAtomicFile(filepath.Join(galleriesDir, id+".json"), encoded); err != nil {
		return MarketPackStatus{}, err
	}

	ver := firstNonEmpty(strings.TrimSpace(pack.Version), "1.0.0")
	saveInstallMeta(galleriesDir, installedPackMeta{
		ID:          id,
		Version:     ver,
		SourceType:  "zip",
		SourceURL:   sourceURL,
		MarketID:    pack.MarketID,
		MarketName:  firstNonEmpty(pack.MarketName, "链接直装"),
		Mirror:      mirror,
		InstalledAt: time.Now().UTC().Format(time.RFC3339),
	})

	out := pack
	out.ID = id
	out.Name = reg.Name
	out.NameEn = reg.NameEn
	out.Description = reg.Description
	out.License = reg.License
	out.Installed = true
	out.InstalledVersion = ver
	out.HasUpdate = false
	out.ItemCount = len(reg.Items)
	out.Mirror = mirror
	out.CachedFiles, out.CachedBytes = genericPackCacheStats(galleriesDir, id)
	return out, nil
}

func pickGalleryImageBaseURL(reg Registration, src MarketGallerySource, sourceURL, mirror string) string {
	if len(reg.ImageMirrors) > 0 {
		for _, k := range mirrorOrder(mirror) {
			if u := strings.TrimSpace(reg.ImageMirrors[k]); u != "" {
				return u
			}
		}
		for _, u := range reg.ImageMirrors {
			if u = strings.TrimSpace(u); u != "" {
				return u
			}
		}
	}
	return firstNonEmpty(strings.TrimSpace(reg.ImageBaseURL), strings.TrimSpace(src.BaseURL), dirOfURL(sourceURL))
}

func dirOfURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	u.RawQuery = ""
	u.Fragment = ""
	dir := path.Dir(u.Path)
	if !strings.HasSuffix(dir, "/") {
		dir += "/"
	}
	u.Path = dir
	return u.String()
}

func resolveRemoteURL(baseURL, raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "https://") || strings.HasPrefix(raw, "http://") {
		return raw
	}
	if baseURL == "" {
		return raw
	}
	b, err := url.Parse(baseURL)
	if err != nil {
		return raw
	}
	rel, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return b.ResolveReference(rel).String()
}

func cacheRelPath(packID, itemKey, suffix, remoteURL string) string {
	ext := ".webp"
	if u, err := url.Parse(remoteURL); err == nil {
		e := strings.ToLower(path.Ext(u.Path))
		switch e {
		case ".png", ".jpg", ".jpeg", ".webp", ".gif":
			ext = e
		}
	}
	sum := sha256.Sum256([]byte(itemKey + "|" + suffix + "|" + remoteURL))
	return path.Join("cache", packID, hex.EncodeToString(sum[:8])+"_"+suffix+ext)
}

func writeAtomicFile(target string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

func readAllInstallMeta(galleriesDir string) map[string]installedPackMeta {
	out := map[string]installedPackMeta{}
	b, err := os.ReadFile(filepath.Join(galleriesDir, marketMetaFile))
	if err != nil {
		return out
	}
	_ = json.Unmarshal(b, &out)
	return out
}

func saveInstallMeta(galleriesDir string, m installedPackMeta) {
	all := readAllInstallMeta(galleriesDir)
	all[m.ID] = m
	if b, err := json.MarshalIndent(all, "", "  "); err == nil {
		_ = writeAtomicFile(filepath.Join(galleriesDir, marketMetaFile), b)
	}
}

func deleteInstallMeta(galleriesDir, id string) {
	all := readAllInstallMeta(galleriesDir)
	if _, ok := all[id]; !ok {
		return
	}
	delete(all, id)
	if b, err := json.MarshalIndent(all, "", "  "); err == nil {
		_ = writeAtomicFile(filepath.Join(galleriesDir, marketMetaFile), b)
	}
}
