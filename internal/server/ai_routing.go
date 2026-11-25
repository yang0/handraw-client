package server

import (
	"encoding/json"
	"strings"

	"github.com/yang0/handraw-client/internal/harnesses"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/settings"
)

type aiRoute struct {
	Mode            string // "auto" | "site" | "provider" | "harness"
	Provider        settings.Provider
	Model           string
	Harness         harnesses.Status
	HarnessSubModel string
}

func isTextOrVisionPurpose(purpose string) bool {
	return purpose == "text" || purpose == "vision"
}

func resolveAIRoute(capability, overrideRef string) (aiRoute, error) {
	return resolveAIRouteForScene(capability, "", overrideRef)
}

func resolveAIRouteForScene(capability, scene, overrideRef string) (aiRoute, error) {
	st := settings.Get()
	ref := strings.TrimSpace(overrideRef)
	if ref == "" && scene != "" && capability != "vision" {
		if v := strings.TrimSpace(st.SceneModels[scene]); v != "" {
			ref = v
		}
	}
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
	if hid, subModel, isHarness := harnesses.ParseRef(ref); isHarness {
		hst, ok := harnesses.Find(st.Harnesses, hid)
		if !ok {
			return aiRoute{}, bad("未找到所选本地 Harness：" + hid + "，请在「设置 → 本地 Harness」中检查配置")
		}
		if !hst.Detected {
			return aiRoute{}, bad("本机未检测到 " + hst.Name + "，请先安装或在「设置 → 本地 Harness」中指定可执行路径")
		}
		if !hst.Enabled {
			return aiRoute{}, bad(hst.Name + " 已停用，请在「设置 → 本地 Harness」中开启")
		}
		return aiRoute{
			Mode:            "harness",
			Harness:         hst,
			HarnessSubModel: subModel,
			Model:           firstStr(subModel, hst.Model, hst.ID),
		}, nil
	}
	// Official website text/vision always uses fixed capability endpoints without
	// exposing or selecting internal site model names (#45). Legacy "site:<model>"
	// values gracefully route to the fixed official site service.
	if strings.HasPrefix(ref, "site:") {
		sub := strings.TrimSpace(strings.TrimPrefix(ref, "site:"))
		if sub == "" || sub == "auto" {
			return aiRoute{Mode: "auto"}, nil
		}
		return aiRoute{Mode: "site"}, nil
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
			if !p.Enabled {
				continue
			}
			for _, m := range p.TextModels() {
				if m.CanVision || providers.LooksVision(m.ID) {
					return p, m.ID, true
				}
			}
		}
	}
	for _, p := range provs {
		if !p.Enabled {
			continue
		}
		if txts := p.TextModels(); len(txts) > 0 {
			return p, txts[0].ID, true
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
	// Never expose raw internal website multimodal model names to client UI (#45).
	// Collapse any server response into fixed abstract capability service entries.
	var textItem, visionItem map[string]any
	for _, it := range obj.AIModels {
		capStr := strings.ToLower(strings.TrimSpace(planString(it, "capability")))
		if capStr != "text" && capStr != "vision" && capStr != "both" {
			capStr = "text"
		}
		isDefText, _ := it["isDefaultText"].(bool)
		isDefVision, _ := it["isDefaultVision"].(bool)
		if capStr == "text" || capStr == "both" {
			if textItem == nil || isDefText {
				textItem = it
			}
		}
		if capStr == "vision" || capStr == "both" {
			if visionItem == nil || isDefVision {
				visionItem = it
			}
		}
	}
	makeEntry := func(id, name, capStr string, isDefText, isDefVision bool, src map[string]any) map[string]any {
		inPrice, _ := src["inputPriceMicrosPerM"].(float64)
		outPrice, _ := src["outputPriceMicrosPerM"].(float64)
		return map[string]any{
			"id":                    id,
			"model":                 id,
			"name":                  name,
			"label":                 name,
			"capability":            capStr,
			"isDefaultText":         isDefText,
			"isDefaultVision":       isDefVision,
			"inputPriceMicrosPerM":  int64(inPrice),
			"outputPriceMicrosPerM": int64(outPrice),
		}
	}
	if textItem != nil {
		out = append(out, makeEntry("text", "智能文字服务", "text", true, false, textItem))
	}
	if visionItem != nil {
		out = append(out, makeEntry("vision", "智能视觉理解服务", "vision", false, true, visionItem))
	}
	return out
}
