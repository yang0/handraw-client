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
	Versions         []plugins.MarketVersion `json:"versions"`
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

func (s *Server) fetchMarketCached(ctx context.Context, src settings.PluginMarketSource, force bool) (plugins.MarketIndex, error) {
	key := "market:" + src.URL
	if !force {
		if b, ok := s.getMarketCache(key, 5*time.Minute); ok {
			var idx plugins.MarketIndex
			if err := json.Unmarshal(b, &idx); err == nil && idx.Format == 1 {
				return idx, nil
			}
		}
	}
	idx, err := plugins.FetchMarketIndex(ctx, src.URL)
	if err != nil {
		return idx, err
	}
	if b, err := json.Marshal(idx); err == nil {
		s.setMarketCache(key, b)
	}
	return idx, nil
}

func (s *Server) pluginMarketList(w http.ResponseWriter, r *http.Request) (any, error) {
	force := r.URL.Query().Get("refresh") == "1"
	st := settings.Get()
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

	for _, src := range sources {
		if !src.Enabled {
			continue
		}
		idx, err := s.fetchMarketCached(r.Context(), src, force)
		if err != nil {
			errs = append(errs, map[string]string{"sourceId": src.ID, "name": src.Name, "error": err.Error()})
			continue
		}
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
		"sources":    sources,
		"categories": categories,
		"labels":     labels,
		"plugins":    items,
		"errors":     errs,
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
