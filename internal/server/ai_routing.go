package server

import (
	"encoding/json"
	"strings"

	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/settings"
)

type aiRoute struct {
	Mode      string // "auto" | "site_explicit" | "provider"
	SiteModel string
	Provider  settings.Provider
	Model     string
}

func isTextOrVisionPurpose(purpose string) bool {
	return purpose == "text" || purpose == "vision"
}

func resolveAIRoute(capability, overrideRef string) (aiRoute, error) {
	st := settings.Get()
	ref := strings.TrimSpace(overrideRef)
	if ref == "" {
		if capability == "vision" {
			ref = strings.TrimSpace(st.DefaultVisionModel)
		} else {
			ref = strings.TrimSpace(st.DefaultTextModel)
		}
	}
	if ref == "" || ref == "site:auto" {
		return aiRoute{Mode: "auto"}, nil
	}
	if strings.HasPrefix(ref, "site:") {
		modelID := strings.TrimSpace(strings.TrimPrefix(ref, "site:"))
		if modelID == "" || modelID == "auto" {
			return aiRoute{Mode: "auto"}, nil
		}
		return aiRoute{Mode: "site_explicit", SiteModel: modelID}, nil
	}
	pid, mid, ok := strings.Cut(ref, ":")
	if !ok || strings.TrimSpace(pid) == "" {
		return aiRoute{}, bad("模型标识格式无效：" + ref)
	}
	p, found := findProvider(strings.TrimSpace(pid))
	if !found || !p.Enabled {
		return aiRoute{}, bad("所选自定义接口不可用或已停用，请在「设置」中重新选择")
	}
	mid = strings.TrimSpace(mid)
	if mid == "" {
		if len(p.Models) == 0 {
			return aiRoute{}, bad("所选自定义接口尚未配置可用模型")
		}
		mid = p.Models[0].ID
	}
	return aiRoute{Mode: "provider", Provider: p, Model: mid}, nil
}

func findTextProviderFor(capability string) (settings.Provider, string, bool) {
	provs := settings.Get().Providers
	if capability == "vision" {
		for _, p := range provs {
			if !p.Enabled || !isTextOrVisionPurpose(p.Purpose) {
				continue
			}
			for _, m := range p.Models {
				if m.CanVision || providers.LooksVision(m.ID) {
					return p, m.ID, true
				}
			}
		}
	}
	for _, p := range provs {
		if p.Enabled && isTextOrVisionPurpose(p.Purpose) && len(p.Models) > 0 {
			return p, p.Models[0].ID, true
		}
	}
	return settings.Provider{}, "", false
}

func normalizeSiteAIModels(raw json.RawMessage) []map[string]any {
	out := []map[string]any{}
	var obj struct {
		AIModels []map[string]any `json:"aiModels"`
	}
	if json.Unmarshal(raw, &obj) != nil || len(obj.AIModels) == 0 {
		return out
	}
	seen := map[string]bool{}
	for _, it := range obj.AIModels {
		id := strings.TrimSpace(planString(it, "id"))
		if id == "" {
			id = strings.TrimSpace(planString(it, "model"))
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(firstStr(planString(it, "name"), planString(it, "label"), id))
		capStr := strings.ToLower(strings.TrimSpace(planString(it, "capability")))
		if capStr != "text" && capStr != "vision" && capStr != "both" {
			capStr = "text"
		}
		isDefText, _ := it["isDefaultText"].(bool)
		isDefVision, _ := it["isDefaultVision"].(bool)
		inPrice, _ := it["inputPriceMicrosPerM"].(float64)
		outPrice, _ := it["outputPriceMicrosPerM"].(float64)
		out = append(out, map[string]any{
			"id":                    id,
			"model":                 id,
			"name":                  name,
			"label":                 name,
			"capability":            capStr,
			"isDefaultText":         isDefText,
			"isDefaultVision":       isDefVision,
			"inputPriceMicrosPerM":  int64(inPrice),
			"outputPriceMicrosPerM": int64(outPrice),
		})
	}
	return out
}
