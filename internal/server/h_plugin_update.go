package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/plugins"
	"github.com/yang0/handraw-client/internal/settings"
)

const pluginUpdateCacheKey = "plugin-updates:snapshot"

type pluginCheckItem struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Status          string `json:"status"` // update | current | local | unknown
	Reason          string `json:"reason,omitempty"`
	Error           string `json:"error,omitempty"`
	CurrentVersion  string `json:"currentVersion,omitempty"`
	LatestVersion   string `json:"latestVersion,omitempty"`
	InstalledCommit string `json:"installedCommit,omitempty"`
	RemoteCommit    string `json:"remoteCommit,omitempty"`
	SourceType      string `json:"sourceType,omitempty"` // market | npm | git | local | url
	MarketSourceID  string `json:"marketSourceId,omitempty"`
	MarketURL       string `json:"marketUrl,omitempty"`
	MarketName      string `json:"marketName,omitempty"`
	Enabled         bool   `json:"enabled"`
}

type pluginCheckSnapshot struct {
	At            int64             `json:"at"`
	OutdatedCount int               `json:"outdatedCount"`
	Plugins       []pluginCheckItem `json:"plugins"`
}

func installCommitOf(c plugins.Community) string {
	if c.Install != nil {
		return strings.TrimSpace(c.Install.Commit)
	}
	return ""
}

func normalizePkgID(name string) string {
	s := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "@"))
	return strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(s)
}

func matchMarketName(c plugins.Community, marketName string) bool {
	if marketName == "" {
		return false
	}
	if strings.EqualFold(c.ID, marketName) || strings.EqualFold(c.ID, normalizePkgID(marketName)) {
		return true
	}
	if c.DSH != nil && strings.EqualFold(c.DSH.PackageName, marketName) {
		return true
	}
	if c.Install != nil && strings.EqualFold(c.Install.Package, marketName) {
		return true
	}
	return false
}

// marketPluginHasUpdate decides whether a market plugin version is genuinely
// newer than an installed community plugin (SemVer precedence + Git commit diff,
// never offering a downgrade when installed version is already newer).
func marketPluginHasUpdate(hasInst bool, inst plugins.Community, latest plugins.MarketVersion) (bool, string) {
	if !hasInst {
		return false, ""
	}
	// Never offer a downgrade if local/dev version is strictly newer than market.
	if plugins.NewerVersion(inst.Version, latest.Version) {
		return false, ""
	}
	if plugins.NewerVersion(latest.Version, inst.Version) {
		return true, "version"
	}
	if latest.Source.Type == "git" && strings.TrimSpace(latest.Source.Commit) != "" {
		instCommit := installCommitOf(inst)
		if instCommit != "" && !plugins.SameCommit(instCommit, latest.Source.Commit) {
			return true, "new_commits"
		}
	}
	return false, ""
}

func (s *Server) invalidatePluginUpdateCache() {
	s.cacheMu.Lock()
	delete(s.cache, pluginUpdateCacheKey)
	s.cacheMu.Unlock()
}

func (s *Server) cachedPluginUpdateSnapshot(ttl time.Duration) (pluginCheckSnapshot, bool) {
	if b, ok := s.getMarketCache(pluginUpdateCacheKey, ttl); ok {
		var snap pluginCheckSnapshot
		if json.Unmarshal(b, &snap) == nil {
			return snap, true
		}
	}
	return pluginCheckSnapshot{}, false
}

func (s *Server) savePluginUpdateSnapshot(snap pluginCheckSnapshot) {
	if b, err := json.Marshal(snap); err == nil {
		s.setMarketCache(pluginUpdateCacheKey, b)
	}
}

type resolvedMarketRef struct {
	Source settings.PluginMarketSource
	Plugin plugins.MarketPlugin
	Latest plugins.MarketVersion
}

func (s *Server) loadMarketIndexRefs(ctx context.Context, force bool) ([]resolvedMarketRef, map[string]string) {
	st := settings.Get()
	sources := st.PluginMarkets
	if len(sources) == 0 {
		sources = settings.DefaultPluginMarkets()
	}
	var refs []resolvedMarketRef
	errs := map[string]string{}
	for _, src := range sources {
		if !src.Enabled {
			continue
		}
		idx, err := s.fetchMarketCached(ctx, src, force)
		if err != nil {
			errs[src.ID] = err.Error()
			continue
		}
		for _, p := range idx.Plugins {
			if len(p.Versions) == 0 {
				continue
			}
			refs = append(refs, resolvedMarketRef{
				Source: src,
				Plugin: p,
				Latest: p.Versions[0],
			})
		}
	}
	return refs, errs
}

func findMarketRefForPlugin(c plugins.Community, refs []resolvedMarketRef) *resolvedMarketRef {
	// Prefer exact market URL match when known.
	if c.Install != nil && c.Install.MarketURL != "" {
		for i := range refs {
			if strings.EqualFold(strings.TrimSpace(refs[i].Source.URL), strings.TrimSpace(c.Install.MarketURL)) &&
				matchMarketName(c, refs[i].Plugin.Name) {
				return &refs[i]
			}
		}
	}
	for i := range refs {
		if matchMarketName(c, refs[i].Plugin.Name) {
			return &refs[i]
		}
	}
	return nil
}

// checkPluginUpdates evaluates every installed community plugin against its
// authoritative source (market index -> npm registry -> git remote HEAD).
// When force is false, only fast cached market data is consulted so UI boot stays instant.
func (s *Server) checkPluginUpdates(ctx context.Context, force bool) pluginCheckSnapshot {
	installed := s.Plugins.ListCommunity(s.enabledPlugins())
	refs, marketErrs := s.loadMarketIndexRefs(ctx, force)

	items := make([]pluginCheckItem, len(installed))
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup

	for i, c := range installed {
		wg.Add(1)
		go func(idx int, c plugins.Community) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			item := pluginCheckItem{
				ID:              c.ID,
				Name:            c.Name,
				CurrentVersion:  c.Version,
				InstalledCommit: plugins.ShortCommit(installCommitOf(c)),
				Enabled:         c.Enabled,
			}
			if c.Install != nil {
				item.SourceType = c.Install.Type
				item.MarketSourceID = c.Install.MarketSource
				item.MarketURL = c.Install.MarketURL
			}

			// 1. Local/linked folder plugins never auto-check remote registries.
			if c.Install != nil && c.Install.Type == "local" {
				item.Status = "local"
				item.Reason = "local_folder"
				items[idx] = item
				return
			}

			// 2. Check against subscribed market indices first.
			if ref := findMarketRefForPlugin(c, refs); ref != nil {
				item.SourceType = "market"
				item.MarketSourceID = ref.Source.ID
				item.MarketURL = ref.Source.URL
				item.MarketName = ref.Plugin.Name
				item.LatestVersion = ref.Latest.Version
				if ref.Latest.Source.Type == "git" && ref.Latest.Source.Commit != "" {
					item.RemoteCommit = plugins.ShortCommit(ref.Latest.Source.Commit)
				}
				if hasUp, reason := marketPluginHasUpdate(true, c, ref.Latest); hasUp {
					item.Status = "update"
					item.Reason = reason
				} else {
					item.Status = "current"
				}
				items[idx] = item
				return
			}

			// If this was a market plugin whose market source failed to load, surface the error.
			if c.Install != nil && c.Install.Type == "market" && len(marketErrs) > 0 {
				var firstErr string
				for _, e := range marketErrs {
					firstErr = e
					break
				}
				item.Status = "unknown"
				item.Error = firstErr
				items[idx] = item
				return
			}

			// 3. Direct npm install check (only query network on force check).
			if c.Install != nil && c.Install.Type == "npm" && c.Install.Package != "" {
				if !force {
					item.Status = "current"
					items[idx] = item
					return
				}
				latestVer, err := plugins.ResolveNPMLatestVersion(ctx, c.Install.Package, c.Install.Registry)
				if err != nil {
					item.Status = "unknown"
					item.Error = err.Error()
				} else {
					item.LatestVersion = latestVer
					if plugins.NewerVersion(latestVer, c.Version) {
						item.Status = "update"
						item.Reason = "version"
					} else {
						item.Status = "current"
					}
				}
				items[idx] = item
				return
			}

			// 4. Direct git install check (compare installed commit vs remote HEAD).
			if c.Install != nil && c.Install.Type == "git" && c.Install.RepoURL != "" {
				if !force {
					item.Status = "current"
					items[idx] = item
					return
				}
				head, err := plugins.ResolveGitHeadCommit(ctx, c.Install.RepoURL)
				if err != nil {
					item.Status = "unknown"
					item.Error = err.Error()
				} else {
					item.RemoteCommit = plugins.ShortCommit(head)
					instCommit := installCommitOf(c)
					if instCommit != "" && !plugins.SameCommit(instCommit, head) {
						item.Status = "update"
						item.Reason = "new_commits"
					} else {
						item.Status = "current"
					}
				}
				items[idx] = item
				return
			}

			item.Status = "unknown"
			item.Reason = "unsupported_source"
			items[idx] = item
		}(i, c)
	}
	wg.Wait()

	outdated := 0
	for _, it := range items {
		if it.Status == "update" {
			outdated++
		}
	}
	snap := pluginCheckSnapshot{
		At:            time.Now().UnixMilli(),
		OutdatedCount: outdated,
		Plugins:       items,
	}
	s.savePluginUpdateSnapshot(snap)
	return snap
}

func (s *Server) pluginUpdatesSummary(w http.ResponseWriter, r *http.Request) (any, error) {
	if snap, ok := s.cachedPluginUpdateSnapshot(30 * time.Minute); ok {
		return map[string]any{
			"count":     snap.OutdatedCount,
			"checkedAt": snap.At,
			"plugins":   snap.Plugins,
		}, nil
	}
	// Fast non-forced pass using cached market index (or quick fetch if never loaded).
	snap := s.checkPluginUpdates(r.Context(), false)
	return map[string]any{
		"count":     snap.OutdatedCount,
		"checkedAt": snap.At,
		"plugins":   snap.Plugins,
	}, nil
}

func (s *Server) pluginCheckUpdates(w http.ResponseWriter, r *http.Request) (any, error) {
	snap := s.checkPluginUpdates(r.Context(), true)
	return map[string]any{
		"at":            snap.At,
		"outdatedCount": snap.OutdatedCount,
		"plugins":       snap.Plugins,
	}, nil
}

// updateInstalledPlugin upgrades one installed plugin in-place (without touching
// the DSH sidecar lifecycle — callers manage Stop/Sync around single or batch runs).
func (s *Server) updateInstalledPlugin(ctx context.Context, c plugins.Community, refs []resolvedMarketRef) (plugins.Community, error) {
	if c.Install != nil && c.Install.Type == "local" {
		return c, errors.New("本地目录链接插件请直接在本地更新代码")
	}
	prevVer := c.Version
	prevCommit := plugins.ShortCommit(installCommitOf(c))
	if s.Galleries != nil {
		s.Galleries.UnregisterByOwner(c.ID)
	}

	var updated plugins.Community
	var err error
	if ref := findMarketRefForPlugin(c, refs); ref != nil {
		updated, err = s.Plugins.InstallFromMarketVersion(ctx, ref.Plugin.Name, ref.Latest, ref.Source.URL)
		if err == nil && updated.Install != nil {
			meta := *updated.Install
			meta.MarketSource = ref.Source.ID
			meta.UpdatedAt = time.Now().UnixMilli()
			meta.UpdatedFrom = firstStr(prevVer, prevCommit)
			meta.UpdatedTo = firstStr(updated.Version, ref.Latest.Version, plugins.ShortCommit(meta.Commit))
			_ = s.Plugins.SaveInstallMeta(updated.ID, meta)
			updated.Install = &meta
		}
	} else if c.Install != nil && c.Install.Type == "npm" && c.Install.Package != "" {
		updated, err = s.Plugins.InstallNPM(ctx, c.Install.Package, "latest", c.Install.Registry, firstStr(c.Install.Source, "npm:"+c.Install.Package))
		if err == nil && updated.Install != nil {
			meta := *updated.Install
			meta.UpdatedAt = time.Now().UnixMilli()
			meta.UpdatedFrom = prevVer
			meta.UpdatedTo = updated.Version
			_ = s.Plugins.SaveInstallMeta(updated.ID, meta)
			updated.Install = &meta
		}
	} else if c.Install != nil && c.Install.Type == "git" && c.Install.RepoURL != "" {
		updated, err = s.Plugins.InstallGit(ctx, c.Install.RepoURL, "HEAD", c.Install.Subdir, firstStr(c.Install.Source, c.Install.RepoURL))
		if err == nil && updated.Install != nil {
			meta := *updated.Install
			meta.UpdatedAt = time.Now().UnixMilli()
			meta.UpdatedFrom = firstStr(prevVer, prevCommit)
			meta.UpdatedTo = firstStr(updated.Version, plugins.ShortCommit(meta.Commit))
			_ = s.Plugins.SaveInstallMeta(updated.ID, meta)
			updated.Install = &meta
		}
	} else {
		return c, errors.New("该插件缺少可追踪的更新来源，请通过市场或原始来源重新安装")
	}
	if err != nil {
		return c, err
	}
	updated.Enabled = c.Enabled
	return updated, nil
}

func (s *Server) pluginUpdateOne(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return nil, bad("缺少插件 ID")
	}
	var target *plugins.Community
	for _, c := range s.Plugins.ListCommunity(s.enabledPlugins()) {
		if c.ID == id {
			cp := c
			target = &cp
			break
		}
	}
	if target == nil {
		return nil, notFound("找不到已安装的插件：" + id)
	}

	refs, _ := s.loadMarketIndexRefs(r.Context(), true)
	wasDSHEnabled := target.Kind == "dsh" && target.Enabled
	if wasDSHEnabled && s.DSH != nil {
		s.DSH.Stop()
	}

	updated, err := s.updateInstalledPlugin(r.Context(), *target, refs)
	if wasDSHEnabled && s.DSH != nil {
		if syncErr := s.SyncDSH(r.Context()); syncErr != nil && err == nil {
			return nil, bad("插件已更新，但重启 DSH 运行时失败：" + syncErr.Error())
		}
	}
	if err != nil {
		return nil, bad(err.Error())
	}

	s.invalidatePluginUpdateCache()
	snap := s.checkPluginUpdates(r.Context(), false)
	s.Emit("plugins", s.Plugins.States())
	return map[string]any{
		"plugin":  updated,
		"updates": snap,
	}, nil
}

func (s *Server) pluginUpdateAll(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		IDs []string `json:"ids"`
	}
	_ = decode(r, &body)
	wantIDs := map[string]bool{}
	for _, id := range body.IDs {
		if id = strings.TrimSpace(id); id != "" {
			wantIDs[id] = true
		}
	}

	snap := s.checkPluginUpdates(r.Context(), true)
	installedMap := map[string]plugins.Community{}
	for _, c := range s.Plugins.ListCommunity(s.enabledPlugins()) {
		installedMap[c.ID] = c
	}

	var queue []plugins.Community
	needStopDSH := false
	for _, it := range snap.Plugins {
		if len(wantIDs) > 0 {
			if !wantIDs[it.ID] {
				continue
			}
		} else if it.Status != "update" {
			continue
		}
		if c, ok := installedMap[it.ID]; ok {
			queue = append(queue, c)
			if c.Kind == "dsh" && c.Enabled {
				needStopDSH = true
			}
		}
	}
	if len(queue) == 0 {
		return map[string]any{
			"updated": []any{},
			"failed":  []any{},
			"updates": snap,
		}, nil
	}

	refs, _ := s.loadMarketIndexRefs(r.Context(), false)
	if needStopDSH && s.DSH != nil {
		s.DSH.Stop()
	}

	updated := make([]map[string]any, 0, len(queue))
	failed := make([]map[string]any, 0)
	for _, c := range queue {
		u, err := s.updateInstalledPlugin(r.Context(), c, refs)
		if err != nil {
			failed = append(failed, map[string]any{
				"id":    c.ID,
				"name":  c.Name,
				"error": err.Error(),
			})
			continue
		}
		updated = append(updated, map[string]any{
			"id":      u.ID,
			"name":    u.Name,
			"version": u.Version,
		})
	}

	if needStopDSH && s.DSH != nil {
		if syncErr := s.SyncDSH(r.Context()); syncErr != nil {
			failed = append(failed, map[string]any{
				"id":    "dsh-runtime",
				"name":  "DSH 运行时",
				"error": fmt.Sprintf("重启 DSH 运行时失败：%v", syncErr),
			})
		}
	}

	s.invalidatePluginUpdateCache()
	nextSnap := s.checkPluginUpdates(r.Context(), false)
	s.Emit("plugins", s.Plugins.States())
	return map[string]any{
		"updated": updated,
		"failed":  failed,
		"updates": nextSnap,
	}, nil
}
