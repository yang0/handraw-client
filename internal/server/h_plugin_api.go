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
			"source":   "provider",
			"provider": tp.ID,
			"model":    model,
		}, nil
	}

	switch route.Mode {
	case "provider":
		return callProvider(route.Provider, route.Model)
	default:
		// Prefer user's configured text/vision OpenAI-compatible provider for general
		// chat completions (official website text/vision endpoints are task-specific).
		if tp, model, ok := findTextProviderFor(capStr); ok {
			return callProvider(tp, model)
		}
		if capStr == "vision" {
			if tp, model, ok := findTextProviderFor("text"); ok {
				return callProvider(tp, model)
			}
		}
		return nil, bad("尚未配置可用的文字/视觉模型接口，请在「设置 → 模型与接口」中添加自定义文字模型")
	}
}

func (s *Server) hostModelsChat(w http.ResponseWriter, r *http.Request) (any, error) {
	var req hostChatRequest
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	return s.executeHostChat(r.Context(), req)
}

func (s *Server) hostGalleryRegister(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Owner string                 `json:"owner"`
		Reg   galleries.Registration `json:"gallery"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.Reg.ID == "" {
		return nil, bad("缺少 gallery.id")
	}
	body.Reg.Owner = strings.TrimSpace(body.Owner)
	if body.Reg.Owner != "" && body.Reg.ImageRoot == "" {
		if c, err := s.Plugins.Community(body.Reg.Owner); err == nil && c.Dir != "" {
			body.Reg.ImageRoot = c.Dir
		}
	}
	if err := s.Galleries.Register(body.Reg); err != nil {
		return nil, bad(err.Error())
	}
	return okv, nil
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
