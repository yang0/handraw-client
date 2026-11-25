package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/plugins"
	"github.com/yang0/handraw-client/internal/settings"
)

type marketViewPlugin struct {
	SourceID         string                 `json:"sourceId"`
	SourceName       string                 `json:"sourceName"`
	OfficialSource   bool                   `json:"officialSource"`
	Name             string                 `json:"name"`
	Title            string                 `json:"title"`
	Description      string                 `json:"description"`
	Icon             string                 `json:"icon,omitempty"`
	Author           string                 `json:"author,omitempty"`
	Homepage         string                 `json:"homepage,omitempty"`
	RepositoryURL    string                 `json:"repositoryUrl,omitempty"`
	Categories       []string               `json:"categories"`
	Labels           []string               `json:"labels"`
	Featured         float64                `json:"featured"`
	LatestVersion    string                 `json:"latestVersion"`
	LatestCommit     string                 `json:"latestCommit,omitempty"`
	InstallType      string                 `json:"installType"` // git | npm
	PublishTimestamp int64                  `json:"publishTimestamp"`
	Installed        bool                   `json:"installed"`
	InstalledID      string                 `json:"installedId,omitempty"`
	InstalledVersion string                 `json:"installedVersion,omitempty"`
	InstalledCommit  string                 `json:"installedCommit,omitempty"`
	Enabled          bool                   `json:"enabled"`
	UpdateAvailable  bool                   `json:"updateAvailable"`
	UpdateReason     string                 `json:"updateReason,omitempty"`
	Pricing          *plugins.MarketPricing  `json:"pricing,omitempty"`
	Delivery         *plugins.MarketDelivery `json:"delivery,omitempty"`
	Versions         []plugins.MarketVersion `json:"versions"`
}

type pluginMarketSourceStatus struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	ActiveMirror string `json:"activeMirror,omitempty"`
	ActiveURL    string `json:"activeUrl,omitempty"`
	Official     bool   `json:"official,omitempty"`
	Enabled      bool   `json:"enabled"`
	Count        int    `json:"count"`
	Error        string `json:"error,omitempty"`
}

func pluginMarketCandidateURLs(src settings.PluginMarketSource, preferredMirror string) []struct {
	mirror string
	url    string
} {
	var out []struct {
		mirror string
		url    string
	}
	seen := map[string]bool{}
	add := func(m, u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			seen[u] = true
			out = append(out, struct {
				mirror string
				url    string
			}{mirror: m, url: u})
		}
	}
	order := []string{"gitee", "github"}
	if strings.EqualFold(strings.TrimSpace(preferredMirror), "github") {
		order = []string{"github", "gitee"}
	}
	for _, m := range order {
		if src.Mirrors != nil {
			add(m, src.Mirrors[m])
		}
	}
	for m, u := range src.Mirrors {
		add(m, u)
	}
	add("", src.URL)
	return out
}

func (s *Server) getMarketCache(key string, ttl time.Duration) (json.RawMessage, bool) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	if c, ok := s.cache[key]; ok && time.Since(c.at) < ttl {
		return c.data, true
	}
	return nil, false
}

func (s *Server) setMarketCache(key string, data json.RawMessage) {
	s.cacheMu.Lock()
	s.cache[key] = cached{at: time.Now(), data: data}
	s.cacheMu.Unlock()
}

func (s *Server) fetchMarketCachedMirror(ctx context.Context, src settings.PluginMarketSource, preferredMirror string, force bool) (plugins.MarketIndex, string, string, error) {
	cands := pluginMarketCandidateURLs(src, preferredMirror)
	if len(cands) == 0 {
		return plugins.MarketIndex{}, "", "", fmt.Errorf("未配置有效的市场地址")
	}
	var lastErr error
	for _, c := range cands {
		key := "market:" + c.url
		if !force {
			if b, ok := s.getMarketCache(key, 5*time.Minute); ok {
				var idx plugins.MarketIndex
				if err := json.Unmarshal(b, &idx); err == nil && idx.Format == 1 {
					return idx, c.mirror, c.url, nil
				}
			}
		}
		idx, err := plugins.FetchMarketIndex(ctx, c.url)
		if err != nil {
			lastErr = err
			continue
		}
		if b, err := json.Marshal(idx); err == nil {
			s.setMarketCache(key, b)
		}
		return idx, c.mirror, c.url, nil
	}
	return plugins.MarketIndex{}, "", "", lastErr
}

func (s *Server) fetchMarketCached(ctx context.Context, src settings.PluginMarketSource, force bool) (plugins.MarketIndex, error) {
	st := settings.Get()
	idx, _, _, err := s.fetchMarketCachedMirror(ctx, src, st.PreferredMarketMirror, force)
	return idx, err
}

func (s *Server) pluginMarketList(w http.ResponseWriter, r *http.Request) (any, error) {
	force := r.URL.Query().Get("refresh") == "1"
	st := settings.Get()
	mirror := firstStr(strings.TrimSpace(r.URL.Query().Get("mirror")), st.PreferredMarketMirror, "gitee")
	sources := st.PluginMarkets
	if len(sources) == 0 {
		sources = settings.DefaultPluginMarkets()
	}

	installedByName := map[string]plugins.Community{}
	for _, c := range s.Plugins.ListCommunity(s.enabledPlugins()) {
		installedByName[c.ID] = c
		if c.DSH != nil && c.DSH.PackageName != "" {
			installedByName[c.DSH.PackageName] = c
		}
	}

	categories := map[string]string{}
	labels := map[string]string{}
	var items []marketViewPlugin
	var errs []map[string]string
	var sourceStatuses []pluginMarketSourceStatus

	for _, src := range sources {
		sst := pluginMarketSourceStatus{
			ID:       src.ID,
			Name:     src.Name,
			URL:      src.URL,
			Official: src.Official,
			Enabled:  src.Enabled,
		}
		if !src.Enabled {
			sourceStatuses = append(sourceStatuses, sst)
			continue
		}
		idx, activeMirror, activeURL, err := s.fetchMarketCachedMirror(r.Context(), src, mirror, force)
		if err != nil {
			sst.Error = err.Error()
			sourceStatuses = append(sourceStatuses, sst)
			errs = append(errs, map[string]string{"sourceId": src.ID, "name": src.Name, "error": err.Error()})
			continue
		}
		sst.ActiveMirror = activeMirror
		sst.ActiveURL = activeURL
		sst.Count = len(idx.Plugins)
		sourceStatuses = append(sourceStatuses, sst)
		for k, v := range idx.Metadata.Categories {
			if _, ok := categories[k]; !ok {
				categories[k] = v.Title.Pick("zh", "zh-CN", "en")
			}
		}
		for k, v := range idx.Metadata.Labels {
			if _, ok := labels[k]; !ok {
				labels[k] = v.Title.Pick("zh", "zh-CN", "en")
			}
		}
		for _, p := range idx.Plugins {
			if len(p.Versions) == 0 {
				continue
			}
			latest := p.Versions[0]
			inst, hasInst := installedByName[p.Name]
			if !hasInst {
				if c, ok := installedByName[strings.ToLower(strings.ReplaceAll(strings.TrimPrefix(p.Name, "@"), "/", "-"))]; ok {
					inst, hasInst = c, true
				}
			}
			title := p.Title.Pick("zh", "zh-CN", "en")
			if title == "" {
				title = p.Name
			}
			desc := p.Description.Pick("zh", "zh-CN", "en")
			cats := p.Metadata.Categories
			if cats == nil {
				cats = []string{}
			}
			lbls := p.Metadata.Labels
			if lbls == nil {
				lbls = []string{}
			}
			repoURL := ""
			if p.Repository != nil {
				repoURL = strings.TrimSpace(p.Repository.URL)
			}
			instCommit := ""
			if hasInst && inst.Install != nil {
				instCommit = inst.Install.Commit
			}
			updateAvail, updateReason := marketPluginHasUpdate(hasInst, inst, latest)
			items = append(items, marketViewPlugin{
				SourceID:         src.ID,
				SourceName:       src.Name,
				OfficialSource:   src.Official,
				Name:             p.Name,
				Title:            title,
				Description:      desc,
				Icon:             p.Icon,
				Author:           p.Author,
				Homepage:         p.Homepage,
				RepositoryURL:    repoURL,
				Categories:       cats,
				Labels:           lbls,
				Featured:         p.Metadata.SortKeys["featured"],
				LatestVersion:    latest.Version,
				LatestCommit:     plugins.ShortCommit(latest.Source.Commit),
				InstallType:      latest.Source.Type,
				PublishTimestamp: latest.PublishTimestamp,
				Installed:        hasInst,
				InstalledID:      inst.ID,
				InstalledVersion: inst.Version,
				InstalledCommit:  plugins.ShortCommit(instCommit),
				Enabled:          hasInst && inst.Enabled,
				UpdateAvailable:  updateAvail,
				UpdateReason:     updateReason,
				Pricing:          p.Pricing,
				Delivery:         p.Delivery,
				Versions:         p.Versions,
			})
		}
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].OfficialSource != items[j].OfficialSource {
			return items[i].OfficialSource
		}
		if items[i].Featured != items[j].Featured {
			return items[i].Featured > items[j].Featured
		}
		return items[i].Name < items[j].Name
	})

	if items == nil {
		items = []marketViewPlugin{}
	}
	if errs == nil {
		errs = []map[string]string{}
	}
	return map[string]any{
		"defaultMirror": mirror,
		"sources":       sourceStatuses,
		"categories":    categories,
		"labels":        labels,
		"plugins":       items,
		"errors":        errs,
	}, nil
}

func (s *Server) pluginMarketAddSource(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		URL  string `json:"url"`
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	u := strings.TrimSpace(body.URL)
	if u == "" {
		return nil, bad("请填写插件市场 index.json 地址")
	}
	idx, err := plugins.FetchMarketIndex(r.Context(), u)
	if err != nil {
		return nil, bad(err.Error())
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = idx.Title.Pick("zh", "zh-CN", "en")
	}
	if name == "" {
		name = "自定义插件市场"
	}
	id := fmt.Sprintf("custom-%d", time.Now().UnixMilli())
	st, err := settings.Update(func(st *settings.Settings) error {
		for _, cur := range st.PluginMarkets {
			if strings.EqualFold(strings.TrimSpace(cur.URL), u) {
				return fmt.Errorf("该市场源已存在")
			}
		}
		st.PluginMarkets = append(st.PluginMarkets, settings.PluginMarketSource{
			ID:      id,
			Name:    name,
			URL:     u,
			Enabled: true,
		})
		return nil
	})
	if err != nil {
		return nil, bad(err.Error())
	}
	if b, err := json.Marshal(idx); err == nil {
		s.setMarketCache("market:"+u, b)
	}
	return map[string]any{"sources": st.PluginMarkets}, nil
}

func (s *Server) pluginMarketRemoveSource(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return nil, bad("缺少市场源 ID")
	}
	st, err := settings.Update(func(st *settings.Settings) error {
		var next []settings.PluginMarketSource
		found := false
		for _, cur := range st.PluginMarkets {
			if cur.ID == id {
				if cur.Official {
					return fmt.Errorf("官方默认插件市场源不能删除")
				}
				found = true
				continue
			}
			next = append(next, cur)
		}
		if !found {
			return fmt.Errorf("未找到市场源 %s", id)
		}
		st.PluginMarkets = next
		return nil
	})
	if err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"sources": st.PluginMarkets}, nil
}

func (s *Server) pluginMarketInstall(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		SourceID string `json:"sourceId"`
		Name     string `json:"name"`
		Version  string `json:"version"`
		Enable   bool   `json:"enable"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		return nil, bad("缺少插件名称")
	}
	st := settings.Get()
	var targetSrc *settings.PluginMarketSource
	for i := range st.PluginMarkets {
		if body.SourceID == "" || st.PluginMarkets[i].ID == body.SourceID {
			targetSrc = &st.PluginMarkets[i]
			break
		}
	}
	if targetSrc == nil {
		return nil, notFound("找不到指定的插件市场源")
	}
	idx, err := s.fetchMarketCached(r.Context(), *targetSrc, false)
	if err != nil {
		return nil, bad(err.Error())
	}
	var targetPlugin *plugins.MarketPlugin
	for i := range idx.Plugins {
		if idx.Plugins[i].Name == name {
			targetPlugin = &idx.Plugins[i]
			break
		}
	}
	if targetPlugin == nil || len(targetPlugin.Versions) == 0 {
		return nil, notFound("市场中未找到插件 " + name)
	}
	chosen := targetPlugin.Versions[0]
	if strings.TrimSpace(body.Version) != "" {
		found := false
		for _, v := range targetPlugin.Versions {
			if v.Version == strings.TrimSpace(body.Version) {
				chosen = v
				found = true
				break
			}
		}
		if !found {
			return nil, notFound("未找到版本 " + body.Version)
		}
	}
	// Check if upgrading an existing plugin so we safely stop DSH sidecar on Windows
	// and preserve enabled state & upgrade audit metadata.
	var prevInst *plugins.Community
	for _, existing := range s.Plugins.ListCommunity(s.enabledPlugins()) {
		if matchMarketName(existing, targetPlugin.Name) {
			cp := existing
			prevInst = &cp
			break
		}
	}
	wasEnabled := prevInst != nil && prevInst.Enabled
	if prevInst != nil {
		if prevInst.Kind == "dsh" && prevInst.Enabled && s.DSH != nil {
			s.DSH.Stop()
		}
		if s.Galleries != nil {
			s.Galleries.UnregisterByOwner(prevInst.ID)
		}
	}

	c, err := s.Plugins.InstallFromMarketVersion(r.Context(), targetPlugin.Name, chosen, targetSrc.URL)
	if err != nil {
		if wasEnabled && s.DSH != nil {
			_ = s.SyncDSH(r.Context())
		}
		return nil, bad(err.Error())
	}
	if c.Install != nil {
		meta := *c.Install
		meta.MarketSource = targetSrc.ID
		if prevInst != nil {
			meta.UpdatedAt = time.Now().UnixMilli()
			meta.UpdatedFrom = firstStr(prevInst.Version, plugins.ShortCommit(installCommitOf(*prevInst)))
			meta.UpdatedTo = firstStr(c.Version, chosen.Version, plugins.ShortCommit(meta.Commit))
		}
		_ = s.Plugins.SaveInstallMeta(c.ID, meta)
		c.Install = &meta
	}
	s.invalidatePluginUpdateCache()
	shouldEnable := body.Enable || wasEnabled
	if shouldEnable && !(c.Kind == "dsh" && c.DSH != nil && c.DSH.Compat == "unsupported") {
		_, _ = settings.Update(func(st *settings.Settings) error {
			if st.Plugins == nil {
				st.Plugins = map[string]bool{}
			}
			st.Plugins["community:"+c.ID] = true
			return nil
		})
		c.Enabled = true
		if c.Kind == "dsh" && s.DSH != nil {
			if err := s.SyncDSH(r.Context()); err != nil {
				_, _ = settings.Update(func(st *settings.Settings) error {
					st.Plugins["community:"+c.ID] = false
					return nil
				})
				c.Enabled = false
				return nil, bad("插件已安装，但启用失败：" + err.Error())
			}
		}
	}
	s.Emit("plugins", s.Plugins.States())
	return map[string]any{"plugin": c}, nil
}

// marketIcon serves remote plugin market icons (fixing GitHub Raw's text/plain
// Content-Type for .svg files so Chromium WebView renders them properly).
func (s *Server) marketIcon(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://127.0.0.1") && !strings.HasPrefix(rawURL, "http://localhost") {
		http.NotFound(w, r)
		return
	}
	cacheKey := "market-icon:" + rawURL
	var body []byte
	if b, ok := s.getMarketCache(cacheKey, 30*time.Minute); ok {
		body = b
	} else {
		req, err := http.NewRequestWithContext(r.Context(), "GET", rawURL, nil)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		req.Header.Set("User-Agent", "handraw-client")
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil || resp.StatusCode != 200 {
			if resp != nil {
				resp.Body.Close()
			}
			http.NotFound(w, r)
			return
		}
		body, err = io.ReadAll(io.LimitReader(resp.Body, 256<<10))
		resp.Body.Close()
		if err != nil || len(body) == 0 {
			http.NotFound(w, r)
			return
		}
		s.setMarketCache(cacheKey, body)
	}
	trimmed := strings.TrimSpace(string(body))
	ct := http.DetectContentType(body)
	if strings.HasPrefix(trimmed, "<svg") || strings.Contains(trimmed[:min(len(trimmed), 256)], "<svg") {
		ct = "image/svg+xml; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(body)
}
