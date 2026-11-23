package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/yang0/handraw-client/internal/galleries"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
)

// hostModelsSummary returns a sanitized, secret-free model catalog for plugins
// and DSH bridges. Respects #45 (never exposes raw internal website AI model names).
func (s *Server) hostModelsSummary(ctx context.Context, purpose string) (map[string]any, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "/api/models", nil)
	raw, err := s.models(httptest.NewRecorder(), req)
	if err != nil {
		return nil, err
	}
	m, _ := raw.(map[string]any)
	purpose = strings.ToLower(strings.TrimSpace(purpose))
	if purpose == "" || purpose == "all" {
		return m, nil
	}
	out := map[string]any{
		"loggedIn":       m["loggedIn"],
		"costLimitCents": m["costLimitCents"],
	}
	switch purpose {
	case "image":
		out["site"] = m["site"]
		out["providers"] = m["providers"]
		out["defaultModel"] = m["defaultModel"]
	case "text", "vision":
		out["siteAI"] = m["siteAI"]
		out["textProviders"] = m["textProviders"]
		out["defaultTextModel"] = m["defaultTextModel"]
		out["defaultVisionModel"] = m["defaultVisionModel"]
	default:
		return m, nil
	}
	return out, nil
}

type hostChatRequest struct {
	ModelRef   string                  `json:"modelRef"`
	Capability string                  `json:"capability"` // text | vision
	System     string                  `json:"system"`
	Messages   []providers.ChatMessage `json:"messages"`
	JSONMode   bool                    `json:"jsonMode"`
}

func (s *Server) executeHostChat(ctx context.Context, req hostChatRequest) (map[string]any, error) {
	capStr := strings.ToLower(strings.TrimSpace(req.Capability))
	if capStr != "vision" {
		capStr = "text"
	}
	msgs := make([]providers.ChatMessage, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.System) != "" {
		msgs = append(msgs, providers.ChatMessage{Role: "system", Content: req.System})
	}
	msgs = append(msgs, req.Messages...)
	if len(msgs) == 0 {
		return nil, bad("messages 不能为空")
	}

	route, err := resolveAIRoute(capStr, req.ModelRef)
	if err != nil {
		return nil, err
	}

	callProvider := func(tp settings.Provider, model string) (map[string]any, error) {
		reply, err := providers.Chat(ctx, tp, model, msgs, req.JSONMode)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"text":     reply,
			"content":  reply,
			"source":   "provider",
			"provider": tp.ID,
			"model":    model,
		}, nil
	}

	callSite := func() (map[string]any, error) {
		res, err := s.Site.AIChat(ctx, site.AIChatRequest{
			Capability:   capStr,
			Messages:     msgs,
			JSONMode:     req.JSONMode,
			FeatureScope: "plugin_chat",
		})
		if err != nil {
			return nil, err
		}
		out := map[string]any{
			"text":       res.Content,
			"content":    res.Content,
			"source":     "site",
			"service":    res.Service,
			"capability": res.Capability,
		}
		if res.Usage != nil {
			out["usage"] = res.Usage
		}
		return out, nil
	}

	switch route.Mode {
	case "provider":
		return callProvider(route.Provider, route.Model)
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		return callSite()
	default:
		if s.Site.LoggedIn() {
			if res, err := callSite(); err == nil {
				return res, nil
			}
		}
		if tp, model, ok := findTextProviderFor(capStr); ok {
			return callProvider(tp, model)
		}
		if capStr == "vision" {
			if tp, model, ok := findTextProviderFor("text"); ok {
				return callProvider(tp, model)
			}
		}
		return nil, bad("请先登录手绘风账号使用官方智能文字/视觉服务，或在「设置 → 第三方接口」中添加自定义接口")
	}
}

func (s *Server) hostModelsList(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.hostModelsSummary(r.Context(), r.URL.Query().Get("purpose"))
}

func (s *Server) hostModelsChat(w http.ResponseWriter, r *http.Request) (any, error) {
	var req hostChatRequest
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	return s.executeHostChat(r.Context(), req)
}

type directoryPickerHost interface {
	PickDirectory() (string, error)
}

func (s *Server) hostPickDirectory(w http.ResponseWriter, r *http.Request) (any, error) {
	picker, ok := s.Host.(directoryPickerHost)
	if !ok {
		return nil, &apiError{Status: 503, Msg: "当前运行环境不支持系统目录选择器"}
	}
	p, err := picker.PickDirectory()
	if err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"path": p}, nil
}

func (s *Server) hostGalleryRegister(w http.ResponseWriter, r *http.Request) (any, error) {
	var raw json.RawMessage
	if err := decode(r, &raw); err != nil {
		return nil, err
	}
	var wrapped struct {
		Owner     string                  `json:"owner"`
		ImageRoot string                  `json:"imageRoot"`
		Reg       *galleries.Registration `json:"gallery"`
	}
	_ = json.Unmarshal(raw, &wrapped)
	var reg galleries.Registration
	if wrapped.Reg != nil && wrapped.Reg.ID != "" {
		reg = *wrapped.Reg
	} else if err := json.Unmarshal(raw, &reg); err != nil {
		return nil, bad("画廊注册参数无效")
	}
	if reg.ID == "" {
		return nil, bad("缺少 gallery.id")
	}
	reg.Owner = strings.TrimSpace(wrapped.Owner)
	if strings.TrimSpace(wrapped.ImageRoot) != "" {
		reg.ImageRoot = strings.TrimSpace(wrapped.ImageRoot)
	}
	if reg.Owner != "" && reg.ImageRoot == "" && s.Plugins != nil {
		if c, err := s.Plugins.Community(reg.Owner); err == nil && c.Dir != "" {
			reg.ImageRoot = c.Dir
		}
	}
	if err := s.Galleries.Register(reg); err != nil {
		return nil, bad(err.Error())
	}
	return okv, nil
}

func (s *Server) pluginDSHDiscover(w http.ResponseWriter, r *http.Request) (any, error) {
	items := s.Plugins.DiscoverDSHProfile()
	if items == nil {
		return map[string]any{"items": []any{}}, nil
	}
	return map[string]any{"items": items}, nil
}

func (s *Server) pluginDSHStatus(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.DSH == nil {
		return map[string]any{"running": false, "plugins": []any{}, "exactRoutes": []any{}, "prefixRoutes": []any{}}, nil
	}
	return s.DSH.Status(), nil
}

func (s *Server) dshClientFile(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	c, err := s.Plugins.Community(id)
	if err != nil || c.Kind != "dsh" || c.DSH == nil || c.DSH.ClientEntry == "" {
		http.NotFound(w, r)
		return
	}
	fp, ok := s.Plugins.FilePath(id, c.DSH.ClientEntry)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, fp)
}

func (s *Server) hostGalleryUnregister(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := strings.TrimSpace(r.PathValue("kind"))
	owner := strings.TrimSpace(r.URL.Query().Get("owner"))
	s.Galleries.Unregister(kind, owner)
	return okv, nil
}

func (s *Server) invokeLocalJSON(ctx context.Context, fn handler, payload any) (any, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "/api/internal", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return fn(httptest.NewRecorder(), req)
}
