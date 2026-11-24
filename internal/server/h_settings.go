package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/galleries"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/plugins"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/skills"
)

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) (any, error) {
	clipTok := settings.EnsureClipToken()
	st := settings.Get()
	type provView struct {
		settings.Provider
		HasKey bool `json:"hasKey"`
	}
	provs := make([]provView, 0, len(st.Providers))
	for _, p := range st.Providers {
		provs = append(provs, provView{Provider: p, HasKey: secrets.Has(secrets.ProviderKey(p.ID))})
	}
	clipEp := ""
	if s.Addr() != "" {
		clipEp = strings.TrimRight(s.Addr(), "/") + "/api/inspirations/clip"
	}
	return map[string]any{
		"settings":     st,
		"providers":    provs,
		"dataDir":      appdir.Root(),
		"clipToken":    clipTok,
		"clipEndpoint": clipEp,
	}, nil
}

func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		SiteBase                   *string `json:"siteBase"`
		WorksDir                   *string `json:"worksDir"`
		Theme                      *string `json:"theme"`
		AutoSyncResources          *bool   `json:"autoSyncResources"`
		KeepSiteGenerationsPrivate *bool   `json:"keepSiteGenerationsPrivate"`
		AutoCheckUpdate            *bool   `json:"autoCheckUpdate"`
		CostLimitCents             *int    `json:"costLimitCents"`
		DefaultModel               *string `json:"defaultModel"`
		DefaultTextModel           *string `json:"defaultTextModel"`
		DefaultVisionModel         *string `json:"defaultVisionModel"`
		QuickShotHotkey            *string `json:"quickShotHotkey"`
		QuickShotEnabled           *bool   `json:"quickShotEnabled"`
		MinimizeToTray             *bool   `json:"minimizeToTray"`
		LastRecipeID               *string `json:"lastRecipeId"`
		Onboarded                  *bool   `json:"onboarded"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	var hotkeyChanged bool
	var nextHotkey string
	updated, err := settings.Update(func(st *settings.Settings) error {
		if body.SiteBase != nil {
			st.SiteBase = strings.TrimRight(strings.TrimSpace(*body.SiteBase), "/")
		}
		if body.WorksDir != nil && strings.TrimSpace(*body.WorksDir) != "" {
			if err := os.MkdirAll(*body.WorksDir, 0o755); err != nil {
				return fmt.Errorf("作品目录不可写：%w", err)
			}
			st.WorksDir = *body.WorksDir
		}
		if body.Theme != nil {
			st.Theme = *body.Theme
		}
		if body.AutoSyncResources != nil {
			st.AutoSyncResources = *body.AutoSyncResources
		}
		if body.KeepSiteGenerationsPrivate != nil {
			st.KeepSiteGenerationsPrivate = *body.KeepSiteGenerationsPrivate
		}
		if body.AutoCheckUpdate != nil {
			st.AutoCheckUpdate = *body.AutoCheckUpdate
		}
		if body.CostLimitCents != nil && *body.CostLimitCents >= 0 {
			st.CostLimitCents = *body.CostLimitCents
		}
		if body.DefaultModel != nil {
			st.DefaultModel = *body.DefaultModel
		}
		if body.DefaultTextModel != nil {
			st.DefaultTextModel = strings.TrimSpace(*body.DefaultTextModel)
		}
		if body.DefaultVisionModel != nil {
			st.DefaultVisionModel = strings.TrimSpace(*body.DefaultVisionModel)
		}
		if body.QuickShotHotkey != nil && *body.QuickShotHotkey != st.QuickShotHotkey {
			st.QuickShotHotkey = *body.QuickShotHotkey
			hotkeyChanged = true
			nextHotkey = *body.QuickShotHotkey
		}
		if body.QuickShotEnabled != nil {
			st.QuickShotEnabled = *body.QuickShotEnabled
			hotkeyChanged = true
			nextHotkey = st.QuickShotHotkey
			if !*body.QuickShotEnabled {
				nextHotkey = ""
			}
		}
		if body.MinimizeToTray != nil {
			st.MinimizeToTray = *body.MinimizeToTray
		}
		if body.LastRecipeID != nil {
			st.LastRecipeID = *body.LastRecipeID
		}
		if body.Onboarded != nil {
			st.Onboarded = *body.Onboarded
		}
		return nil
	})
	if err != nil {
		return nil, bad(err.Error())
	}
	if hotkeyChanged {
		_ = s.Host.SetHotkey(nextHotkey)
	}
	s.Emit("settings", updated)
	return s.getSettings(w, r)
}

func (s *Server) providerPut(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		settings.Provider
		APIKey string `json:"apiKey"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.BaseURL) == "" {
		return nil, bad("接口名称和地址不能为空")
	}
	if body.ID == "" {
		body.ID = jobs.NewID("prov")
	}
	if body.Kind == "" {
		body.Kind = "openai"
	}
	if body.Purpose == "" {
		body.Purpose = "text"
	}
	if body.Models == nil {
		body.Models = []settings.Model{}
	}
	if strings.TrimSpace(body.APIKey) != "" {
		if err := secrets.Set(secrets.ProviderKey(body.ID), strings.TrimSpace(body.APIKey)); err != nil {
			return nil, fmt.Errorf("保存密钥失败：%w", err)
		}
	}
	_, err := settings.Update(func(st *settings.Settings) error {
		for i := range st.Providers {
			if st.Providers[i].ID == body.ID {
				st.Providers[i] = body.Provider
				return nil
			}
		}
		st.Providers = append(st.Providers, body.Provider)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.getSettings(w, r)
}

func (s *Server) providerDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	_ = secrets.Delete(secrets.ProviderKey(id))
	_, err := settings.Update(func(st *settings.Settings) error {
		out := st.Providers[:0]
		for _, p := range st.Providers {
			if p.ID != id {
				out = append(out, p)
			}
		}
		st.Providers = out
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.getSettings(w, r)
}

func findProvider(id string) (settings.Provider, bool) {
	for _, p := range settings.Get().Providers {
		if p.ID == id {
			return p, true
		}
	}
	return settings.Provider{}, false
}

func (s *Server) providerModels(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	var body struct {
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey"`
	}
	_ = decode(r, &body)
	p, ok := findProvider(id)
	if !ok {
		if strings.TrimSpace(body.BaseURL) == "" {
			return nil, notFound("找不到接口 " + id)
		}
		p = settings.Provider{
			Kind:    "openai",
			BaseURL: strings.TrimSpace(body.BaseURL),
		}
	} else if strings.TrimSpace(body.BaseURL) != "" {
		p.BaseURL = strings.TrimSpace(body.BaseURL)
	}
	apiKey := strings.TrimSpace(body.APIKey)
	if apiKey == "" && ok {
		apiKey, _ = secrets.Get(secrets.ProviderKey(p.ID))
	}
	models, err := providers.ListModelsWithKey(r.Context(), p, apiKey)
	if err != nil {
		return nil, err
	}
	return map[string]any{"models": models}, nil
}

func (s *Server) providerTest(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	p, ok := findProvider(id)
	if !ok {
		return nil, notFound("找不到接口 " + id)
	}
	var body struct {
		Model  string `json:"model"`
		Vision bool   `json:"vision"`
	}
	_ = decode(r, &body)
	t0 := time.Now()
	if body.Model == "" && !body.Vision {
		models, err := providers.ListModels(r.Context(), p)
		ms := time.Since(t0).Milliseconds()
		if err != nil {
			return map[string]any{"ok": false, "latencyMs": ms, "error": err.Error()}, nil
		}
		return map[string]any{"ok": true, "latencyMs": ms, "modelsCount": len(models)}, nil
	}
	if p.Purpose == "text" || p.Purpose == "vision" {
		modelID := strings.TrimSpace(body.Model)
		if modelID == "" && len(p.Models) > 0 {
			modelID = p.Models[0].ID
			if body.Vision {
				for _, m := range p.Models {
					if m.CanVision || providers.LooksVision(m.ID) {
						modelID = m.ID
						break
					}
				}
			}
		}
		if modelID == "" {
			return map[string]any{"ok": false, "latencyMs": 0, "error": "请先添加或选择要测试的模型"}, nil
		}
		var msgs []providers.ChatMessage
		if body.Vision {
			// Minimal 1x1 PNG for multimodal vision endpoint verification.
			const tinyPNGDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
			msgs = []providers.ChatMessage{{
				Role: "user",
				Content: []any{
					map[string]any{"type": "text", "text": "Reply OK"},
					map[string]any{"type": "image_url", "image_url": map[string]any{"url": tinyPNGDataURL}},
				},
			}}
		} else {
			msgs = []providers.ChatMessage{{Role: "user", Content: "ping"}}
		}
		reply, err := providers.Chat(r.Context(), p, modelID, msgs, false)
		ms := time.Since(t0).Milliseconds()
		if err != nil {
			return map[string]any{"ok": false, "latencyMs": ms, "error": err.Error()}, nil
		}
		return map[string]any{"ok": true, "latencyMs": ms, "reply": reply, "model": modelID, "vision": body.Vision}, nil
	}
	imgs, err := providers.GenerateImage(r.Context(), p, providers.ImageRequest{
		Model:  body.Model,
		Prompt: "minimalist single ink dot on warm paper",
		Size:   "1024x1024",
		N:      1,
	})
	ms := time.Since(t0).Milliseconds()
	if err != nil {
		return map[string]any{"ok": false, "latencyMs": ms, "error": err.Error()}, nil
	}
	return map[string]any{"ok": true, "latencyMs": ms, "imagesCount": len(imgs)}, nil
}

// ---------- plugins ----------

func (s *Server) pluginList(w http.ResponseWriter, r *http.Request) (any, error) {
	out := map[string]any{
		"builtin":          s.Plugins.States(),
		"community":        s.Plugins.ListCommunity(s.enabledPlugins()),
		"knownPermissions": plugins.KnownPermissions,
	}
	if snap, ok := s.cachedPluginUpdateSnapshot(30 * time.Minute); ok {
		out["updates"] = snap
	}
	if s.DSH != nil {
		out["dshStatus"] = s.DSH.Status()
	}
	return out, nil
}

func (s *Server) pluginPatch(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	var body struct {
		Enabled *bool          `json:"enabled"`
		Config  map[string]any `json:"config"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	isCommunity := strings.HasPrefix(id, "community:")
	if isCommunity && body.Enabled != nil && *body.Enabled {
		cid := strings.TrimPrefix(id, "community:")
		if c, err := s.Plugins.Community(cid); err == nil && c.Kind == "dsh" && c.DSH != nil && c.DSH.Compat == "unsupported" {
			return nil, bad("该 DSH 插件暂不支持在手绘风中直接运行：" + strings.Join(c.DSH.CompatReasons, "；"))
		}
	}
	if !isCommunity && body.Enabled != nil && !*body.Enabled {
		if err := s.Plugins.CanDisable(id); err != nil {
			return nil, conflict(err.Error())
		}
	}
	var validated map[string]any
	if !isCommunity && body.Config != nil {
		var err error
		validated, err = s.Plugins.ValidateConfig(id, body.Config)
		if err != nil {
			return nil, bad(err.Error())
		}
	}
	st, err := settings.Update(func(st *settings.Settings) error {
		if st.Plugins == nil {
			st.Plugins = map[string]bool{}
		}
		if st.PluginConfig == nil {
			st.PluginConfig = map[string]any{}
		}
		if body.Enabled != nil {
			st.Plugins[id] = *body.Enabled
		}
		if validated != nil {
			st.PluginConfig[id] = validated
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if isCommunity && body.Enabled != nil && !*body.Enabled && s.Galleries != nil {
		s.Galleries.UnregisterByOwner(strings.TrimPrefix(id, "community:"))
	}
	s.Plugins.Reconcile(st.Plugins, st.PluginConfig)
	if isCommunity && s.DSH != nil {
		if err := s.SyncDSH(r.Context()); err != nil {
			// Roll back enabling on startup failure so UI reflects real state.
			if body.Enabled != nil && *body.Enabled {
				_, _ = settings.Update(func(st *settings.Settings) error {
					st.Plugins[id] = false
					return nil
				})
				_ = s.SyncDSH(r.Context())
			}
			return nil, bad(err.Error())
		}
	}
	s.Emit("plugins", s.Plugins.States())
	return s.pluginList(w, r)
}

func (s *Server) pluginInstall(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Source string `json:"source"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	c, err := s.Plugins.Install(r.Context(), body.Source)
	if err != nil {
		return nil, bad(err.Error())
	}
	s.invalidatePluginUpdateCache()
	return map[string]any{"plugin": c}, nil
}

func (s *Server) pluginRemove(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	if err := s.Plugins.Remove(id); err != nil {
		return nil, bad(err.Error())
	}
	s.invalidatePluginUpdateCache()
	if s.Galleries != nil {
		s.Galleries.UnregisterByOwner(id)
	}
	_, _ = settings.Update(func(st *settings.Settings) error {
		delete(st.Plugins, "community:"+id)
		return nil
	})
	if s.DSH != nil {
		_ = s.SyncDSH(r.Context())
	}
	s.Emit("plugins", s.Plugins.States())
	return okv, nil
}

// pluginCall executes a declared host capability on behalf of a sandboxed community plugin.
func (s *Server) pluginCall(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	if !s.enabledPlugins()["community:"+id] {
		return nil, &apiError{Status: 403, Msg: "插件未启用", Code: "plugin_disabled"}
	}
	c, err := s.Plugins.Community(id)
	if err != nil {
		return nil, notFound(err.Error())
	}
	var body struct {
		Action string          `json:"action"`
		Args   json.RawMessage `json:"args"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	need := func(perm string) error {
		if !c.Has(perm) {
			return &apiError{Status: 403, Msg: "插件未声明权限：" + perm, Code: "permission_denied"}
		}
		return nil
	}
	needAny := func(perms ...string) error {
		for _, p := range perms {
			if c.Has(p) {
				return nil
			}
		}
		return &apiError{Status: 403, Msg: "插件未声明权限：" + strings.Join(perms, " / "), Code: "permission_denied"}
	}
	switch body.Action {
	case "resources.summary":
		if err := needAny("resources:read", "galleries:read"); err != nil {
			return nil, err
		}
		return s.resSummary(w, r)
	case "galleries.list":
		if err := needAny("galleries:read", "resources:read"); err != nil {
			return nil, err
		}
		return s.galleryList(w, r)
	case "galleries.items":
		if err := needAny("galleries:read", "resources:read"); err != nil {
			return nil, err
		}
		var a struct {
			Kind     string `json:"kind"`
			Q        string `json:"q"`
			Category string `json:"category"`
			Source   string `json:"source"`
			Limit    int    `json:"limit"`
			Offset   int    `json:"offset"`
		}
		if err := json.Unmarshal(body.Args, &a); err != nil {
			return nil, bad("参数无效")
		}
		items, total, ok := s.Galleries.Items(s.Pack(), a.Kind, galleries.Query{
			Q: a.Q, Category: a.Category, Source: a.Source, Limit: a.Limit, Offset: a.Offset,
		}, s.galleryExtraDirs()...)
		if !ok {
			return nil, notFound("找不到画廊 " + a.Kind)
		}
		return map[string]any{"kind": a.Kind, "items": items, "total": total}, nil
	case "galleries.item":
		if err := needAny("galleries:read", "resources:read"); err != nil {
			return nil, err
		}
		var a struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(body.Args, &a); err != nil {
			return nil, bad("参数无效")
		}
		it, ok := s.Galleries.Item(s.Pack(), a.Kind, a.ID, s.galleryExtraDirs()...)
		if !ok {
			return nil, notFound(fmt.Sprintf("找不到画廊资源 %s/%s", a.Kind, a.ID))
		}
		return map[string]any{"item": it}, nil
	case "galleries.register":
		if err := need("galleries:register"); err != nil {
			return nil, err
		}
		var reg galleries.Registration
		if err := json.Unmarshal(body.Args, &reg); err != nil {
			return nil, bad("画廊注册参数无效")
		}
		reg.Owner = c.ID
		reg.ImageRoot = c.Dir
		if err := s.Galleries.Register(reg); err != nil {
			return nil, bad(err.Error())
		}
		return okv, nil
	case "models.list":
		if err := needAny("models:text", "models:vision", "models:image", "generate"); err != nil {
			return nil, err
		}
		var a struct {
			Purpose string `json:"purpose"`
		}
		_ = json.Unmarshal(body.Args, &a)
		return s.hostModelsSummary(r.Context(), a.Purpose)
	case "models.chat":
		if err := needAny("models:text", "models:vision"); err != nil {
			return nil, err
		}
		var a hostChatRequest
		if err := json.Unmarshal(body.Args, &a); err != nil {
			return nil, bad("对话参数无效")
		}
		if strings.EqualFold(strings.TrimSpace(a.Capability), "vision") {
			if err := need("models:vision"); err != nil {
				return nil, err
			}
		}
		return s.executeHostChat(r.Context(), a)
	case "skills.list":
		if err := needAny("skills:read", "models:text"); err != nil {
			return nil, err
		}
		return s.hostSkillsList(w, r)
	case "skills.get":
		if err := needAny("skills:read", "models:text"); err != nil {
			return nil, err
		}
		var a struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(body.Args, &a); err != nil || strings.TrimSpace(a.ID) == "" {
			return nil, bad("缺少 skill id")
		}
		sk, err := s.skillsManager().Get(a.ID)
		if err != nil || !sk.Enabled {
			return nil, notFound("未找到已启用的 Skill：" + a.ID)
		}
		return map[string]any{"skill": sk}, nil
	case "models.quote":
		if err := needAny("models:image", "generate"); err != nil {
			return nil, err
		}
		var a map[string]any
		_ = json.Unmarshal(body.Args, &a)
		return s.invokeLocalJSON(r.Context(), s.quote, a)
	case "models.generate":
		if err := needAny("models:image", "generate"); err != nil {
			return nil, err
		}
		var a map[string]any
		if err := json.Unmarshal(body.Args, &a); err != nil || a == nil {
			return nil, bad("生图参数无效")
		}
		if _, ok := a["mode"]; !ok {
			a["mode"] = "plugin"
		}
		return s.invokeLocalJSON(r.Context(), s.generate, a)
	case "works.list":
		if err := need("works:read"); err != nil {
			return nil, err
		}
		return s.works(w, r)
	case "recipes.list":
		if err := need("recipes:read"); err != nil {
			return nil, err
		}
		return s.mineList(w, r)
	case "clipboard.copyText":
		if err := need("clipboard"); err != nil {
			return nil, err
		}
		var a struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(body.Args, &a)
		return okv, s.Host.CopyText(a.Text)
	case "open.url":
		if err := need("open:url"); err != nil {
			return nil, err
		}
		var a struct {
			URL string `json:"url"`
		}
		_ = json.Unmarshal(body.Args, &a)
		if !strings.HasPrefix(a.URL, "https://") && !strings.HasPrefix(a.URL, "http://") {
			return nil, bad("只允许打开 http/https 链接")
		}
		return okv, s.Host.OpenURL(a.URL)
	default:
		return nil, bad("未知插件动作：" + body.Action)
	}
}

// ---------- updates ----------

func (s *Server) updateStatus(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.Updater.Status(), nil
}

func (s *Server) updateCheck(w http.ResponseWriter, r *http.Request) (any, error) {
	st, err := s.Updater.Check(r.Context())
	if plan, pErr := s.Updater.PlanResources(r.Context(), s.PackDir); pErr == nil && plan != nil {
		st = s.Updater.Status()
	}
	var skillRes *skills.UpdateCheckResult
	if res, sErr := s.skillsManager().CheckUpdate(r.Context(), skills.BuiltinHandrawSkillID); sErr == nil {
		skillRes = &res
		s.Emit("skills", map[string]any{"checked": true, "id": res.ID, "latestVersion": res.LatestVersion})
	}
	out := map[string]any{"status": st}
	if skillRes != nil {
		out["skill"] = skillRes
	}
	if err != nil && st.ResourceNew == "" {
		out["error"] = err.Error()
	}
	return out, nil
}

func (s *Server) updateDownload(w http.ResponseWriter, r *http.Request) (any, error) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		_ = s.Updater.Download(ctx)
	}()
	return map[string]any{"status": s.Updater.Status()}, nil
}

func (s *Server) updateApply(w http.ResponseWriter, r *http.Request) (any, error) {
	if _, err := s.Updater.Apply(); err != nil {
		return nil, bad(err.Error())
	}
	go func() {
		time.Sleep(400 * time.Millisecond)
		s.Host.Restart()
	}()
	return okv, nil
}

func (s *Server) updateResources(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.PackDir == "" {
		return nil, bad("未配置可写资源目录")
	}
	plan, err := s.Updater.PlanResources(r.Context(), s.PackDir)
	if err != nil {
		return nil, err
	}
	resChanged := 0
	if len(plan.Changed) > 0 || len(plan.Removed) > 0 {
		if err := s.Updater.ApplyResources(r.Context(), s.PackDir, plan, func(done, total int) {
			s.Emit("resource_update", map[string]any{"done": done, "total": total})
		}); err != nil {
			return nil, err
		}
		resChanged = len(plan.Changed)
		if p, err := resources.Load(s.PackDir); err == nil {
			resources.SetCurrent(p)
			s.Emit("pack", map[string]any{"version": p.Version, "styles": len(p.Styles)})
		}
	}
	skillUpdated := false
	skillVersion := ""
	if sk, changed, sErr := s.skillsManager().Update(r.Context(), skills.BuiltinHandrawSkillID); sErr == nil {
		skillUpdated = changed
		skillVersion = sk.Version
		if changed {
			s.Emit("skills", map[string]any{"updated": true, "changed": true, "id": sk.ID, "version": sk.Version})
		}
	}
	return map[string]any{
		"updated":      resChanged > 0 || skillUpdated,
		"changed":      resChanged,
		"skillUpdated": skillUpdated,
		"skillVersion": skillVersion,
		"status":       s.Updater.Status(),
	}, nil
}
