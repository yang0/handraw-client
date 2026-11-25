package obsidian

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	ObsidianMirrorGitee  = "gitee"
	ObsidianMirrorGitHub = "github"

	obsidianMarketCacheTTL = 5 * time.Minute
)

type MarketSource struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	URL      string            `json:"url"`
	Mirrors  map[string]string `json:"mirrors,omitempty"`
	Official bool              `json:"official,omitempty"`
	Enabled  bool              `json:"enabled"`
}

type MarketLocalized struct {
	Zh string `json:"zh,omitempty"`
	En string `json:"en,omitempty"`
}

func (l MarketLocalized) Label() string {
	if s := strings.TrimSpace(l.Zh); s != "" {
		return s
	}
	return strings.TrimSpace(l.En)
}

type MarketIndexPlugin struct {
	ID              string            `json:"id"`
	Version         string            `json:"version,omitempty"`
	Name            string            `json:"name"`
	Author          string            `json:"author"`
	License         string            `json:"license,omitempty"`
	Description     string            `json:"description"`
	Repo            string            `json:"repo"`
	Homepage        string            `json:"homepage,omitempty"`
	Downloads       int64             `json:"downloads,omitempty"`
	Categories      []string          `json:"categories,omitempty"`
	Featured        bool              `json:"featured,omitempty"`
	FeaturedTag     string            `json:"featuredTag,omitempty"`
	CompatLevel     string            `json:"compatLevel,omitempty"`
	DownloadMirrors map[string]string `json:"downloadMirrors,omitempty"`
	Files           []string          `json:"files,omitempty"`
	Pricing         *MarketPricing    `json:"pricing,omitempty"`
	Delivery        *MarketDelivery   `json:"delivery,omitempty"`
}

type MarketIndex struct {
	Format      int               `json:"format"`
	Title       MarketLocalized   `json:"title,omitempty"`
	Description MarketLocalized   `json:"description,omitempty"`
	Mirrors     map[string]string `json:"mirrors,omitempty"`
	Metadata    struct {
		Categories map[string]struct {
			Title MarketLocalized `json:"title"`
		} `json:"categories,omitempty"`
	} `json:"metadata,omitempty"`
	Plugins []MarketIndexPlugin `json:"plugins"`
}

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

type MarketCategory struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type MarketCatalogResult struct {
	DefaultMirror string               `json:"defaultMirror"`
	Sources       []MarketSourceStatus `json:"sources"`
	Categories    []MarketCategory     `json:"categories"`
	Items         []CatalogItem        `json:"items"`
	Offline       bool                 `json:"offline"`
	Warning       string               `json:"warning,omitempty"`
}

type obsMarketCacheEntry struct {
	fetchedAt time.Time
	index     MarketIndex
}

var (
	obsMarketCacheMu sync.Mutex
	obsMarketCache   = map[string]obsMarketCacheEntry{}
)

func ClearMarketCache() {
	obsMarketCacheMu.Lock()
	obsMarketCache = map[string]obsMarketCacheEntry{}
	obsMarketCacheMu.Unlock()
}

func obsidianMirrorOrder(preferred string) []string {
	if strings.EqualFold(strings.TrimSpace(preferred), ObsidianMirrorGitHub) {
		return []string{ObsidianMirrorGitHub, ObsidianMirrorGitee}
	}
	return []string{ObsidianMirrorGitee, ObsidianMirrorGitHub}
}

func FetchMarketIndex(ctx context.Context, rawURL string, forceRefresh bool) (MarketIndex, error) {
	rawURL = strings.TrimSpace(rawURL)
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://") {
		return MarketIndex{}, errors.New("写作插件市场地址必须以 http:// 或 https:// 开头")
	}
	if !forceRefresh {
		obsMarketCacheMu.Lock()
		ent, ok := obsMarketCache[rawURL]
		obsMarketCacheMu.Unlock()
		if ok && time.Since(ent.fetchedAt) < obsidianMarketCacheTTL {
			return ent.index, nil
		}
	}
	b, _, err := httpGetBytes(ctx, rawURL, 8<<20, 15*time.Second)
	if err != nil {
		return MarketIndex{}, err
	}
	var idx MarketIndex
	if err := json.Unmarshal(b, &idx); err != nil {
		return MarketIndex{}, fmt.Errorf("写作插件市场索引 JSON 无效：%w", err)
	}
	if idx.Format != 1 || len(idx.Plugins) == 0 {
		return MarketIndex{}, errors.New("写作插件市场索引必须是 Format 1 且包含 plugins 条目")
	}
	obsMarketCacheMu.Lock()
	obsMarketCache[rawURL] = obsMarketCacheEntry{fetchedAt: time.Now(), index: idx}
	obsMarketCacheMu.Unlock()
	return idx, nil
}

func FetchMarketIndexForSource(ctx context.Context, src MarketSource, preferredMirror string, forceRefresh bool) (MarketIndex, string, string, error) {
	type cand struct {
		mirror string
		url    string
	}
	var cands []cand
	seen := map[string]bool{}
	add := func(m, u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			seen[u] = true
			cands = append(cands, cand{mirror: m, url: u})
		}
	}
	for _, m := range obsidianMirrorOrder(preferredMirror) {
		if src.Mirrors != nil {
			add(m, src.Mirrors[m])
		}
	}
	for m, u := range src.Mirrors {
		add(m, u)
	}
	add("", src.URL)
	if len(cands) == 0 {
		return MarketIndex{}, "", "", errors.New("未配置有效的写作插件市场地址")
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

// ListMarketCatalog merges Handraw's self-hosted Format 1 Obsidian markets (with
// domestic Gitee/GitHub mirror failover & compatibility labels) and optionally
// appends the full upstream Obsidian community catalog for deep search (#127).
func (m *Manager) ListMarketCatalog(ctx context.Context, sources []MarketSource, preferredMirror string, includeCommunity, forceRefresh bool) MarketCatalogResult {
	catLabels := map[string]string{
		"wechat":    "公众号与发布",
		"writing":   "写作与排版",
		"knowledge": "知识库与模板",
		"media":     "图床与白板",
	}

	var srcStatuses []MarketSourceStatus
	byID := map[string]int{}
	items := make([]CatalogItem, 0, 32)
	anyMarketOK := false

	addCurated := func(p MarketIndexPlugin, srcID, srcName string) {
		id := strings.TrimSpace(p.ID)
		if id == "" {
			return
		}
		lk := strings.ToLower(id)
		if _, exists := byID[lk]; exists {
			return
		}
		compat := strings.TrimSpace(p.CompatLevel)
		if compat == "verified" {
			compat = "full"
		}
		it := CatalogItem{
			ID:               id,
			Version:          strings.TrimSpace(p.Version),
			Name:             strings.TrimSpace(p.Name),
			Author:           strings.TrimSpace(p.Author),
			License:          strings.TrimSpace(p.License),
			Description:      strings.TrimSpace(p.Description),
			Repo:             strings.TrimSpace(p.Repo),
			Homepage:         strings.TrimSpace(p.Homepage),
			Downloads:        p.Downloads,
			Categories:       p.Categories,
			Featured:         true,
			FeaturedTag:      strings.TrimSpace(p.FeaturedTag),
			FeaturedSummary:  strings.TrimSpace(p.Description),
			CompatLevel:      compat,
			DownloadMirrors:  p.DownloadMirrors,
			Files:            p.Files,
			Pricing:          p.Pricing,
			Delivery:         p.Delivery,
			MarketSourceID:   srcID,
			MarketSourceName: srcName,
			MirroredFast:     len(p.DownloadMirrors) > 0,
		}
		byID[lk] = len(items)
		items = append(items, it)
	}

	for _, src := range sources {
		sst := MarketSourceStatus{
			ID:       src.ID,
			Name:     src.Name,
			URL:      src.URL,
			Official: src.Official,
			Enabled:  src.Enabled,
		}
		if sst.Name == "" {
			sst.Name = src.ID
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
				for _, c := range curatedPicks {
					addCurated(MarketIndexPlugin{
						ID:          c.ID,
						Name:        c.Name,
						Author:      c.Author,
						Description: c.Summary,
						Repo:        c.Repo,
						Categories:  []string{"writing"},
						Featured:    true,
						FeaturedTag: c.Tag,
						CompatLevel: "verified",
					}, src.ID, sst.Name)
				}
				sst.Count = len(curatedPicks)
			}
		} else {
			anyMarketOK = true
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
			sst.Count = len(idx.Plugins)
			for _, p := range idx.Plugins {
				addCurated(p, src.ID, sst.Name)
			}
		}
		srcStatuses = append(srcStatuses, sst)
	}

	catCounts := map[string]int{}
	catOrder := []string{}
	for _, it := range items {
		for _, c := range it.Categories {
			if _, seen := catCounts[c]; !seen {
				catOrder = append(catOrder, c)
			}
			catCounts[c]++
		}
	}
	cats := make([]MarketCategory, 0, len(catOrder))
	for _, cid := range catOrder {
		name := catLabels[cid]
		if name == "" {
			name = cid
		}
		cats = append(cats, MarketCategory{ID: cid, Name: name, Count: catCounts[cid]})
	}

	warning := ""
	offline := !anyMarketOK
	if includeCommunity {
		commItems, commOffline, commErr := m.FetchCatalog(ctx, forceRefresh)
		if commErr != nil {
			warning = "全量社区目录暂不可达，当前展示自有精选市场：" + commErr.Error()
		}
		if !commOffline {
			offline = false
		}
		for _, ci := range commItems {
			lk := strings.ToLower(ci.ID)
			if idxPos, exists := byID[lk]; exists {
				if items[idxPos].Downloads == 0 && ci.Downloads > 0 {
					items[idxPos].Downloads = ci.Downloads
				}
				continue
			}
			ci.Featured = false
			byID[lk] = len(items)
			items = append(items, ci)
		}
	}

	pref := ObsidianMirrorGitee
	if strings.EqualFold(strings.TrimSpace(preferredMirror), ObsidianMirrorGitHub) {
		pref = ObsidianMirrorGitHub
	}
	return MarketCatalogResult{
		DefaultMirror: pref,
		Sources:       srcStatuses,
		Categories:    cats,
		Items:         m.decorateCatalog(items),
		Offline:       offline,
		Warning:       warning,
	}
}

// InstallFromMirrors installs an Obsidian plugin directly from domestic/international
// mirrored release files (manifest.json + main.js + optional styles.css) and falls
// back automatically to InstallFromGitHub if mirrors fail or are absent (#127).
func (m *Manager) InstallFromMirrors(ctx context.Context, repo string, downloadMirrors map[string]string, files []string, preferredMirror string) (InstalledPlugin, error) {
	if len(downloadMirrors) > 0 {
		var bases []string
		seen := map[string]bool{}
		addBase := func(b string) {
			b = strings.TrimSpace(b)
			if b == "" {
				return
			}
			if !strings.HasSuffix(b, "/") {
				b += "/"
			}
			if !seen[b] && (strings.HasPrefix(b, "https://") || strings.HasPrefix(b, "http://")) {
				seen[b] = true
				bases = append(bases, b)
			}
		}
		for _, mk := range obsidianMirrorOrder(preferredMirror) {
			addBase(downloadMirrors[mk])
		}
		for _, b := range downloadMirrors {
			addBase(b)
		}

		wantStyles := false
		for _, f := range files {
			if strings.EqualFold(strings.TrimSpace(f), "styles.css") {
				wantStyles = true
				break
			}
		}

		for _, base := range bases {
			mfBytes, _, err1 := httpGetBytes(ctx, base+"manifest.json", 1<<20, 15*time.Second)
			if err1 != nil || len(mfBytes) == 0 {
				continue
			}
			var mf Manifest
			if json.Unmarshal(mfBytes, &mf) != nil || ValidatePluginID(mf.ID) != nil {
				continue
			}
			mainBytes, _, err2 := httpGetBytes(ctx, base+"main.js", maxPluginFileBytes, 25*time.Second)
			if err2 != nil || len(mainBytes) == 0 {
				continue
			}
			var stylesBytes []byte
			if wantStyles {
				if sb, _, err3 := httpGetBytes(ctx, base+"styles.css", 4<<20, 12*time.Second); err3 == nil && len(sb) > 0 {
					stylesBytes = sb
				}
			}
			cleanRepo, _ := ParseGitHubRepo(repo)
			srcURL := base
			if cleanRepo != "" {
				srcURL = "https://github.com/" + cleanRepo
			}
			return m.writePluginFiles(mf, mfBytes, mainBytes, stylesBytes, InstallMeta{
				SourceType: "market",
				Source:     srcURL,
				Repo:       cleanRepo,
			})
		}
	}
	if strings.TrimSpace(repo) == "" {
		return InstalledPlugin{}, errors.New("缺少有效的镜像下载地址或 GitHub 仓库")
	}
	return m.InstallFromGitHub(ctx, repo, "market")
}
