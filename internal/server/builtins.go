package server

import (
	"encoding/json"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/plugins"
	"github.com/yang0/handraw-client/internal/prompt"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/settings"
)

var jsonUnmarshal = json.Unmarshal

func promptDecision(s *Server, p *resources.Pack, model string, st resources.Style) prompt.Decision {
	return prompt.Resolve(p, s.Rules(), model, st)
}

func (s *Server) enabledPlugins() map[string]bool {
	st := settings.Get()
	if st.Plugins == nil {
		return map[string]bool{}
	}
	return st.Plugins
}

// RegisterBuiltins registers the default built-in feature plugins described in
// docs/product.md 5.1.1 and reconciles them against saved settings.
func (s *Server) RegisterBuiltins() {
	if s.Plugins == nil {
		s.Plugins = plugins.NewRuntime(appdir.Plugins())
	}
	countKind := func(kind string) func() (int, error) {
		return func() (int, error) {
			if s.DB == nil {
				return 0, nil
			}
			docs, err := s.DB.ListDocs(kind, false)
			if err != nil {
				return 0, err
			}
			return len(docs), nil
		}
	}
	s.Plugins.Register(plugins.Manifest{
		ID:       "canvas",
		Name:     "参数与自由画布",
		Desc:     "自由画布、节点组合工作流、模板与助手搭建",
		API:      "^1",
		Provides: []string{"canvas"},
		Pages:    []string{"canvas"},
		InUse:    countKind("canvas"),
	})
	s.Plugins.Register(plugins.Manifest{
		ID:       "article",
		Name:     "文章到图文",
		Desc:     "导入文章、规划封面与正文配图位、批量生成与导出",
		API:      "^1",
		Provides: []string{"article"},
		Pages:    []string{"article"},
		InUse:    countKind("article"),
	})
	st := settings.Get()
	s.Plugins.Reconcile(st.Plugins, st.PluginConfig)
}

// CommunityProviders returns image providers registered by enabled community plugins.
func (s *Server) CommunityProviders() []settings.Provider {
	if s.Plugins == nil {
		return nil
	}
	var out []settings.Provider
	for _, c := range s.Plugins.ListCommunity(s.enabledPlugins()) {
		if !c.Enabled || !c.Has("provider") {
			continue
		}
		for _, cp := range c.Providers {
			out = append(out, settings.Provider{
				ID:      "plugin_" + c.ID + "_" + cp.ID,
				Name:    cp.Name + "（插件）",
				Kind:    "openai",
				Purpose: "image",
				BaseURL: cp.Endpoint,
				Models:  []settings.Model{{ID: cp.ID, Label: cp.Name}},
				Enabled: true,
			})
		}
	}
	return out
}
