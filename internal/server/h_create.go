package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/yang0/handraw-client/internal/harnesses"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/prompt"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

func (s *Server) buildPrompt(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	var body struct {
		prompt.Input
		GalleryRefs []GalleryRef `json:"galleryRefs,omitempty"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	in := body.Input
	if len(body.GalleryRefs) > 0 {
		gctx := s.resolveGalleryRefs(r.Context(), body.GalleryRefs)
		if in.Style == "" && gctx.Style != "" {
			in.Style = gctx.Style
		}
		if in.Layout == "" && gctx.Layout != "" {
			in.Layout = gctx.Layout
		}
		if in.Color == "" && gctx.Color != "" {
			in.Color = gctx.Color
		}
		if in.Tone == "" && gctx.Tone != "" {
			in.Tone = gctx.Tone
		}
		if len(gctx.PromptCues) > 0 {
			cues := strings.Join(gctx.PromptCues, "\n")
			if strings.TrimSpace(in.Extra) != "" {
				in.Extra = strings.TrimSpace(in.Extra) + "\n" + cues
			} else {
				in.Extra = cues
			}
		}
	}
	res, err := prompt.Build(p, s.Rules(), in)
	if err != nil {
		return nil, bad(err.Error())
	}
	// Attach preview asset paths for zero-cost local preview.
	preview := map[string]string{}
	if res.StyleID != "" {
		if st, ok := p.Style(res.StyleID); ok {
			preview["styleImage"] = st.Image
			preview["styleName"] = firstStr(st.NameZh, st.GenerationName)
		}
	}
	if in.Style2 != "" {
		if st2, ok := p.Style(in.Style2); ok {
			preview["style2Image"] = st2.Image
			preview["style2Name"] = firstStr(st2.NameZh, st2.GenerationName)
		}
	}
	if res.LayoutID != "" {
		if l, ok := p.Layout(res.LayoutID); ok {
			preview["layoutImage"] = l.Image
			preview["layoutName"] = l.Name
		}
	}
	if res.ColorID != "" {
		firstCol := strings.TrimSpace(strings.Split(res.ColorID, "+")[0])
		if c, ok := p.Color(firstCol); ok {
			preview["colorImage"] = c.Image
			preview["colorName"] = c.NameZh
		}
	}
	if in.Tone != "" {
		if t, ok := p.Tone(in.Tone); ok {
			preview["toneImage"] = t.Image
			preview["toneName"] = t.NameZh
		}
	}
	return map[string]any{"result": res, "preview": preview}, nil
}

func (s *Server) expandTheme(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Theme    string `json:"theme"`
		Style    string `json:"style"`
		Mode     string `json:"mode"`
		ModelRef string `json:"modelRef"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Theme) == "" {
		return nil, bad("请输入要扩写的主题")
	}
	route, err := resolveAIRouteForScene("text", "studioPlan", body.ModelRef)
	if err != nil {
		return nil, err
	}
	expandWithHarness := func() (string, error) {
		sys := "你是手绘插画画面构思助手。将用户简短主题扩写成丰富、具体、有画面感的中文场景描述（不超过 120 字），只补充主体动作、环境氛围、视角细节，不要指定画风或色彩术语。"
		res, err := s.callHarnessText(r.Context(), route, []providers.ChatMessage{
			{Role: "system", Content: sys},
			{Role: "user", Content: body.Theme},
		}, false)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(res.Text) == "" {
			return "", bad("本地 Harness 返回内容为空")
		}
		return strings.TrimSpace(res.Text), nil
	}
	expandWithProvider := func(tp settings.Provider, model string) (string, error) {
		sys := "你是手绘插画画面构思助手。将用户简短主题扩写成丰富、具体、有画面感的中文场景描述（不超过 120 字），只补充主体动作、环境氛围、视角细节，不要指定画风或色彩术语。"
		reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{
			{Role: "system", Content: sys},
			{Role: "user", Content: body.Theme},
		}, false)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(reply) == "" {
			return "", bad("文字模型返回内容为空")
		}
		return strings.TrimSpace(reply), nil
	}
	expandWithSite := func() (string, error) {
		req := map[string]any{"seed": body.Theme, "count": 1, "layoutMode": "fixed"}
		if strings.TrimSpace(body.Style) != "" {
			req["styleId"] = strings.TrimSpace(body.Style)
		}
		raw, err := s.Site.BatchPlan(r.Context(), req)
		if err != nil {
			return "", err
		}
		var res struct {
			Items []struct {
				Subject string `json:"subject"`
				Theme   string `json:"theme"`
				Prompt  string `json:"prompt"`
			} `json:"items"`
		}
		if json.Unmarshal(raw, &res) == nil && len(res.Items) > 0 {
			if t := firstStr(res.Items[0].Subject, res.Items[0].Theme, res.Items[0].Prompt); t != "" {
				return t, nil
			}
		}
		return "", bad("线上接口未能生成扩写内容")
	}
	switch route.Mode {
	case "harness":
		txt, err := expandWithHarness()
		if err != nil {
			return nil, err
		}
		return map[string]any{"theme": txt, "source": "harness", "harness": route.Harness.ID}, nil
	case "provider":
		txt, err := expandWithProvider(route.Provider, route.Model)
		if err != nil {
			return nil, err
		}
		return map[string]any{"theme": txt, "source": "provider"}, nil
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		txt, err := expandWithSite()
		if err != nil {
			return nil, err
		}
		return map[string]any{"theme": txt, "source": "site"}, nil
	default:
		if s.Site.LoggedIn() {
			if txt, err := expandWithSite(); err == nil {
				return map[string]any{"theme": txt, "source": "site"}, nil
			}
		}
		if tp, model, ok := findTextProviderFor("text"); ok {
			if txt, err := expandWithProvider(tp, model); err == nil {
				return map[string]any{"theme": txt, "source": "provider"}, nil
			}
		}
		// Deterministic fallback enrichment when no text model is available.
		return map[string]any{
			"theme":  strings.TrimSpace(body.Theme) + "，前景主体鲜明生动，中景有生活气息的小细节，背景柔和透气形成层次感",
			"source": "local",
		}, nil
	}
}

func (s *Server) models(w http.ResponseWriter, r *http.Request) (any, error) {
	st := settings.Get()
	var siteModels json.RawMessage = json.RawMessage("[]")
	if raw, err := s.Site.PublicModels(r.Context()); err == nil && len(raw) > 0 {
		siteModels = raw
		_ = s.DB.SetKV("site_models_cache", raw)
	} else {
		var cached json.RawMessage
		if s.DB.GetKV("site_models_cache", &cached) == nil && len(cached) > 0 {
			siteModels = cached
		}
	}
	var imgProvs []settings.Provider
	var txtProvs []settings.Provider
	for _, p := range st.Providers {
		if !p.Enabled {
			continue
		}
		imgs := p.ImageModels()
		txts := p.TextModels()
		if len(imgs) > 0 {
			cp := p
			cp.Models = imgs
			imgProvs = append(imgProvs, cp)
		}
		if len(txts) > 0 {
			cp := p
			cp.Models = txts
			txtProvs = append(txtProvs, cp)
		}
		if len(imgs) == 0 && len(txts) == 0 {
			if isTextOrVisionPurpose(p.Purpose) {
				txtProvs = append(txtProvs, p)
			} else if p.Purpose == "image" {
				imgProvs = append(imgProvs, p)
			}
		}
	}
	for _, p := range s.CommunityProviders() {
		imgProvs = append(imgProvs, p)
	}
	if imgProvs == nil {
		imgProvs = []settings.Provider{}
	}
	if txtProvs == nil {
		txtProvs = []settings.Provider{}
	}
	return map[string]any{
		"site":               normalizeSiteModels(siteModels),
		"siteAI":             normalizeSiteAIModels(siteModels),
		"providers":          imgProvs,
		"textProviders":      txtProvs,
		"harnesses":          harnesses.Discover(st.Harnesses),
		"sceneModels":        st.SceneModels,
		"defaultModel":       st.DefaultModel,
		"defaultTextModel":   st.DefaultTextModel,
		"defaultVisionModel": st.DefaultVisionModel,
		"costLimitCents":     st.CostLimitCents,
		"loggedIn":           s.Site.LoggedIn(),
	}, nil
}

func normalizeSiteModels(raw json.RawMessage) []map[string]any {
	out := []map[string]any{}
	var arr []map[string]any
	supportsFreeGlobal := false

	if json.Unmarshal(raw, &arr) != nil {
		var obj struct {
			Specifications []map[string]any `json:"specifications"`
			Models         []map[string]any `json:"models"`
			Items          []map[string]any `json:"items"`
			Policies       []struct {
				FreeUnits int `json:"freeUnits"`
			} `json:"policies"`
		}
		if json.Unmarshal(raw, &obj) != nil {
			return out
		}
		for _, pol := range obj.Policies {
			if pol.FreeUnits > 0 {
				supportsFreeGlobal = true
				break
			}
		}
		switch {
		case len(obj.Specifications) > 0:
			arr = obj.Specifications
		case len(obj.Models) > 0:
			arr = obj.Models
		default:
			arr = obj.Items
		}
	}

	seen := map[string]int{}
	for _, it := range arr {
		if en, ok := it["enabled"].(bool); ok && !en {
			continue
		}
		modelID, _ := it["model"].(string)
		idStr, _ := it["id"].(string)
		modelID = strings.TrimSpace(firstStr(modelID, idStr))
		if modelID == "" {
			continue
		}
		label, _ := it["label"].(string)
		name, _ := it["name"].(string)
		res, _ := it["resolution"].(string)
		if label == "" && res != "" && strings.HasSuffix(strings.ToLower(name), " "+strings.ToLower(res)) {
			name = strings.TrimSpace(name[:len(name)-len(res)-1])
		}
		display := firstStr(label, name, modelID)

		price := 0
		if v, ok := it["priceCents"].(float64); ok {
			price = int(v)
		}
		free := supportsFreeGlobal
		if v, ok := it["supportsFreeQuota"].(bool); ok {
			free = v
		} else if v, ok := it["freeQuota"].(bool); ok {
			free = v
		}

		if idx, exists := seen[modelID]; exists {
			curPrice, _ := out[idx]["priceCents"].(int)
			if price > 0 && (curPrice == 0 || price < curPrice) {
				out[idx]["priceCents"] = price
			}
			continue
		}
		seen[modelID] = len(out)
		out = append(out, map[string]any{
			"id":                modelID,
			"model":             modelID,
			"name":              display,
			"label":             display,
			"priceCents":        price,
			"supportsFreeQuota": free,
		})
	}
	return out
}

type siteSpecEntry struct {
	ID         string `json:"id"`
	Model      string `json:"model"`
	Resolution string `json:"resolution"`
	Quality    string `json:"quality"`
	Enabled    *bool  `json:"enabled"`
	Verified   *bool  `json:"verified"`
}

func parseSiteSpecs(raw json.RawMessage) []siteSpecEntry {
	if len(raw) == 0 {
		return nil
	}
	var obj struct {
		Specifications []siteSpecEntry `json:"specifications"`
		Models         []siteSpecEntry `json:"models"`
		Items          []siteSpecEntry `json:"items"`
	}
	var arr []siteSpecEntry
	if json.Unmarshal(raw, &arr) != nil {
		if json.Unmarshal(raw, &obj) != nil {
			return nil
		}
		switch {
		case len(obj.Specifications) > 0:
			arr = obj.Specifications
		case len(obj.Models) > 0:
			arr = obj.Models
		default:
			arr = obj.Items
		}
	}
	out := make([]siteSpecEntry, 0, len(arr))
	for _, sp := range arr {
		if sp.Enabled != nil && !*sp.Enabled {
			continue
		}
		if sp.Verified != nil && !*sp.Verified {
			continue
		}
		if strings.TrimSpace(sp.ID) == "" && strings.TrimSpace(sp.Model) == "" {
			continue
		}
		out = append(out, sp)
	}
	return out
}

func matchSiteSpec(specs []siteSpecEntry, modelOrID, wantRes, wantQual string) (siteSpecEntry, bool) {
	m := strings.ToLower(strings.TrimSpace(modelOrID))
	res := strings.ToLower(strings.TrimSpace(wantRes))
	qual := strings.ToLower(strings.TrimSpace(wantQual))
	if m == "" || len(specs) == 0 {
		return siteSpecEntry{}, false
	}
	for _, sp := range specs {
		if strings.ToLower(strings.TrimSpace(sp.ID)) == m {
			return sp, true
		}
	}
	if res != "" && qual != "" {
		for _, sp := range specs {
			if strings.EqualFold(sp.Model, m) && strings.EqualFold(sp.Resolution, res) && strings.EqualFold(sp.Quality, qual) {
				return sp, true
			}
		}
	}
	if res != "" {
		for _, sp := range specs {
			if strings.EqualFold(sp.Model, m) && strings.EqualFold(sp.Resolution, res) {
				return sp, true
			}
		}
	}
	for _, sp := range specs {
		if strings.EqualFold(sp.Model, m) {
			return sp, true
		}
	}
	return siteSpecEntry{}, false
}

// resolveSiteSpec maps a website model + desired resolution/quality to a verified
// specification ID from /api/economy/public-models (#61).
func (s *Server) resolveSiteSpec(ctx context.Context, modelOrID, wantRes, wantQual string) (specID, effRes, effQual string) {
	effRes = firstStr(strings.TrimSpace(wantRes), "1k")
	effQual = firstStr(strings.TrimSpace(wantQual), "standard")

	var cached json.RawMessage
	if s.DB != nil && s.DB.GetKV("site_models_cache", &cached) == nil && len(cached) > 0 {
		if sp, ok := matchSiteSpec(parseSiteSpecs(cached), modelOrID, wantRes, wantQual); ok {
			return sp.ID, firstStr(sp.Resolution, effRes), firstStr(sp.Quality, effQual)
		}
	}
	if s.Site != nil {
		if raw, err := s.Site.PublicModels(ctx); err == nil && len(raw) > 0 {
			if s.DB != nil {
				_ = s.DB.SetKV("site_models_cache", raw)
			}
			if sp, ok := matchSiteSpec(parseSiteSpecs(raw), modelOrID, wantRes, wantQual); ok {
				return sp.ID, firstStr(sp.Resolution, effRes), firstStr(sp.Quality, effQual)
			}
		}
	}
	return "", effRes, effQual
}

func (s *Server) quote(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		ModelRef   string `json:"modelRef"`
		Resolution string `json:"resolution"`
		Quality    string `json:"quality"`
		Count      int    `json:"count"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.Count <= 0 {
		body.Count = 1
	}
	if strings.HasPrefix(body.ModelRef, "site:") {
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		modelID := strings.TrimPrefix(body.ModelRef, "site:")
		specID, effRes, effQual := s.resolveSiteSpec(r.Context(), modelID, body.Resolution, body.Quality)
		qItem := map[string]any{
			"model":      modelID,
			"resolution": effRes,
			"quality":    effQual,
			"count":      body.Count,
		}
		if specID != "" {
			qItem["specId"] = specID
		}
		raw, err := s.Site.Quote(r.Context(), []map[string]any{qItem})
		if err != nil {
			return nil, err
		}
		var q struct {
			QuoteID    string `json:"quoteId"`
			TotalCents int    `json:"totalCents"`
			FreeCount  int    `json:"freeCount"`
		}
		_ = json.Unmarshal(raw, &q)
		limit := settings.Get().CostLimitCents
		return map[string]any{
			"source":     "site",
			"quoteId":    q.QuoteID,
			"totalCents": q.TotalCents,
			"freeCount":  q.FreeCount,
			"overLimit":  limit > 0 && q.TotalCents > limit,
			"limitCents": limit,
			"raw":        raw,
		}, nil
	}
	pid, mid, _ := strings.Cut(body.ModelRef, ":")
	price := 0
	if p, ok := findProvider(pid); ok {
		for _, m := range p.Models {
			if m.ID == mid {
				price = m.PriceCents
			}
		}
	}
	total := price * body.Count
	return map[string]any{
		"source":     "provider",
		"totalCents": total,
		"siteCharge": 0,
		"freeCount":  0,
		"overLimit":  false,
	}, nil
}

func (s *Server) generate(w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	var body struct {
		Mode             string           `json:"mode"` // quick | single | series | article | canvas | edit | compare
		Title            string           `json:"title"`
		ModelRef         string           `json:"modelRef"` // site:<id> | <providerId>:<modelId>
		Resolution       string           `json:"resolution"`
		Quality          string           `json:"quality"`
		Count            int              `json:"count"` // variants for single
		Confirmed        bool             `json:"confirmed"`
		GroupID          string           `json:"groupId"`
		ParentID         string           `json:"parentId"`
		ForkOf           string           `json:"forkOf"`
		Recipe                json.RawMessage  `json:"recipe"`
		DirectPrompt          bool             `json:"directPrompt"`
		PromptCustomized      bool             `json:"promptCustomized"`
		CustomPrompt          string           `json:"customPrompt"`
		Annotations           []map[string]any `json:"annotations"`
		MaskDataURL           string           `json:"maskDataUrl"`
		AnnotatedGuideDataURL string           `json:"annotatedGuideDataUrl"`
		Refs                  []string         `json:"refs"`
		RefMeta               []RunRefMeta     `json:"refMeta"`
		GalleryRefs           []GalleryRef     `json:"galleryRefs"`
		Items            []struct {
			Theme  string `json:"theme"`
			Style  string `json:"style"`
			Style2 string `json:"style2"`
			Layout string `json:"layout"`
			Color  string `json:"color"`
			Tone   string `json:"tone"`
			Mood   string `json:"mood"`
			Ratio  string `json:"ratio"`
			Text   string `json:"text"`
			Mode   string `json:"mode"`
			Redraw bool   `json:"redraw"`
			Extra  string `json:"extra"`
			Prompt string `json:"prompt"`
		} `json:"items"`
		Input prompt.Input `json:"input"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.Mode == "" {
		body.Mode = "single"
	}
	if body.ModelRef == "" {
		body.ModelRef = settings.Get().DefaultModel
	}
	if body.ModelRef == "" {
		return nil, bad("请先选择生图模型")
	}
	isSite := strings.HasPrefix(body.ModelRef, "site:")
	if isSite && !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	if len(body.Items) == 0 {
		cnt := body.Count
		if cnt <= 0 {
			cnt = 1
		}
		if cnt > 4 && body.Mode == "single" {
			cnt = 4
		}
		for i := 0; i < cnt; i++ {
			body.Items = append(body.Items, struct {
				Theme  string `json:"theme"`
				Style  string `json:"style"`
				Style2 string `json:"style2"`
				Layout string `json:"layout"`
				Color  string `json:"color"`
				Tone   string `json:"tone"`
				Mood   string `json:"mood"`
				Ratio  string `json:"ratio"`
				Text   string `json:"text"`
				Mode   string `json:"mode"`
				Redraw bool   `json:"redraw"`
				Extra  string `json:"extra"`
				Prompt string `json:"prompt"`
			}{
				Theme: body.Input.Theme, Style: body.Input.Style, Style2: body.Input.Style2,
				Layout: body.Input.Layout, Color: body.Input.Color, Tone: body.Input.Tone,
				Mood: body.Input.Mood, Ratio: body.Input.Ratio, Text: body.Input.Text,
				Mode: body.Input.Mode, Redraw: body.Input.Redraw, Extra: body.Input.Extra,
			})
		}
	}

	// Resolve extensible gallery references (e.g. hairstyles, poses) into prompt cues and reference images (#48).
	var galCtx resolvedGalleryContext
	if len(body.GalleryRefs) > 0 {
		galCtx = s.resolveGalleryRefs(r.Context(), body.GalleryRefs)
		if len(galCtx.RefImages) > 0 {
			body.Refs = append(body.Refs, galCtx.RefImages...)
		}
		if body.DirectPrompt {
			// In direct-prompt mode keep the user's prompt untouched, only attach reference images.
			galCtx.PromptCues = nil
		}
	}

	// Build prompts for each item.
	_, rawModel, _ := strings.Cut(body.ModelRef, ":")
	var built []prompt.Result
	var itemPrompts []string
	var itemRatios []string
	var itemThemes []string
	for _, it := range body.Items {
		if body.DirectPrompt {
			rawPrompt := firstStr(strings.TrimSpace(it.Prompt), strings.TrimSpace(body.CustomPrompt), strings.TrimSpace(it.Theme), strings.TrimSpace(body.Input.Theme))
			if rawPrompt == "" {
				return nil, bad("请输入要直出的完整提示词")
			}
			pr := prompt.Result{Primary: rawPrompt, Zh: rawPrompt}
			built = append(built, pr)
			itemPrompts = append(itemPrompts, rawPrompt)
			itemRatios = append(itemRatios, firstStr(it.Ratio, body.Input.Ratio, "3:4"))
			itemThemes = append(itemThemes, firstStr(strings.TrimSpace(it.Theme), rawPrompt))
			continue
		}
		in := prompt.Input{
			Style: firstStr(it.Style, galCtx.Style), Style2: it.Style2,
			Layout: firstStr(it.Layout, galCtx.Layout), Color: firstStr(it.Color, galCtx.Color),
			Tone: firstStr(it.Tone, galCtx.Tone), Mood: it.Mood, Theme: it.Theme, Ratio: it.Ratio,
			Text: it.Text, Model: rawModel, Mode: it.Mode, Redraw: it.Redraw, Extra: it.Extra,
		}
		var pr prompt.Result
		if it.Prompt != "" {
			pr.Primary, pr.Zh = it.Prompt, it.Prompt
		} else if body.PromptCustomized && strings.TrimSpace(body.CustomPrompt) != "" {
			pr.Primary, pr.Zh = body.CustomPrompt, body.CustomPrompt
		} else if in.Style != "" || in.Layout != "" || in.Color != "" {
			res, err := prompt.Build(p, s.Rules(), in)
			if err != nil {
				return nil, bad(err.Error())
			}
			pr = res
		} else {
			pr.Primary, pr.Zh = it.Theme, it.Theme
		}
		finalPrompt := prompt.ForGeneration(pr, s.Rules())
		if !body.PromptCustomized && strings.TrimSpace(it.Prompt) == "" && body.Mode != "edit" {
			finalPrompt = appendChineseTypographyDirective(finalPrompt, it.Mode, firstStr(it.Layout, galCtx.Layout), it.Theme, it.Text)
		}
		if len(galCtx.PromptCues) > 0 {
			finalPrompt += "\n" + strings.Join(galCtx.PromptCues, "\n")
		}
		globalEditExtra := strings.TrimSpace(firstStr(it.Extra, body.Input.Extra))
		if len(body.Annotations) > 0 {
			if body.Mode == "edit" {
				if editPrompt := buildAnnotateEditPrompt(body.Annotations, strings.TrimSpace(body.AnnotatedGuideDataURL) != ""); editPrompt != "" {
					if globalEditExtra != "" {
						editPrompt += "\n- 整体补充要求：" + globalEditExtra
					}
					finalPrompt = editPrompt
					pr.Primary, pr.Zh = editPrompt, editPrompt
				}
			} else {
				var notes []string
				for _, a := range body.Annotations {
					txt, _ := a["text"].(string)
					if txt != "" {
						notes = append(notes, txt)
					}
				}
				if len(notes) > 0 {
					finalPrompt += "\n局部修改要求：" + strings.Join(notes, "；")
				}
			}
		} else if body.Mode == "edit" && globalEditExtra != "" {
			editPrompt := "请严格基于所附参考图 1 进行编辑修改：\n" +
				"- 保留原图主体构图、画风笔触、材质肌理与未要求改动的元素。\n" +
				"- 按以下要求调整画面：" + globalEditExtra + "\n" +
				"- 新增或修改的内容必须自然融入原图的画风、透视与光影中。"
			finalPrompt = editPrompt
			pr.Primary, pr.Zh = editPrompt, editPrompt
		}
		built = append(built, pr)
		itemPrompts = append(itemPrompts, finalPrompt)
		itemRatios = append(itemRatios, firstStr(it.Ratio, "3:4"))
		itemThemes = append(itemThemes, firstStr(it.Theme, body.Input.Theme))
	}

	var quoteID string
	var estCents, freeCnt int
	var siteSpecID string
	effResolution := firstStr(body.Resolution, "1k")
	effQuality := firstStr(body.Quality, "standard")
	if isSite {
		siteSpecID, effResolution, effQuality = s.resolveSiteSpec(r.Context(), rawModel, body.Resolution, body.Quality)
		qItems := make([]map[string]any, 0, len(body.Items))
		for i := range body.Items {
			qi := map[string]any{
				"model":      rawModel,
				"resolution": effResolution,
				"quality":    effQuality,
				"ratio":      itemRatios[i],
				"count":      1,
			}
			if siteSpecID != "" {
				qi["specId"] = siteSpecID
			}
			qItems = append(qItems, qi)
		}
		rawQ, err := s.Site.Quote(r.Context(), qItems)
		if err != nil {
			return nil, err
		}
		var q struct {
			QuoteID    string `json:"quoteId"`
			TotalCents int    `json:"totalCents"`
			FreeCount  int    `json:"freeCount"`
		}
		_ = json.Unmarshal(rawQ, &q)
		quoteID, estCents, freeCnt = q.QuoteID, q.TotalCents, q.FreeCount
		limit := settings.Get().CostLimitCents
		if !body.Confirmed && limit > 0 && estCents > limit {
			return map[string]any{
				"needConfirm": true,
				"totalCents":  estCents,
				"freeCount":   freeCnt,
				"limitCents":  limit,
				"count":       len(body.Items),
			}, nil
		}
	}

	runID := jobs.NewID("run")
	dir := jobs.RunDir(runID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	maskPath := ""
	if body.MaskDataURL != "" {
		if mBytes, err := decodeDataURL(body.MaskDataURL); err == nil {
			maskPath = filepath.Join(dir, "mask.png")
			_ = os.WriteFile(maskPath, mBytes, 0o644)
		}
	}
	guidePath := ""
	if body.AnnotatedGuideDataURL != "" {
		if gBytes, err := decodeDataURL(body.AnnotatedGuideDataURL); err == nil {
			guidePath = filepath.Join(dir, "annotated_guide"+sniffImageExt(gBytes))
			_ = os.WriteFile(guidePath, gBytes, 0o644)
		}
	}
	src := "provider"
	if isSite {
		src = "site"
	}
	firstRes := built[0]
	var persistedRecipe json.RawMessage
	var runMeta json.RawMessage
	defaultRunTitle := "手绘风创作"
	refMetaList := s.buildRunRefMeta(body.RefMeta, body.GalleryRefs, body.Refs)
	if body.DirectPrompt {
		persistedRecipe = json.RawMessage("{}")
		metaObj := map[string]any{
			"directPrompt": true,
			"ratio":        itemRatios[0],
			"resolution":   effResolution,
			"quality":      effQuality,
		}
		if len(refMetaList) > 0 {
			metaObj["refs"] = refMetaList
		}
		runMeta, _ = json.Marshal(metaObj)
		defaultRunTitle = "直出创作"
	} else {
		var parentRecipe json.RawMessage
		if body.ParentID != "" {
			if parentRun, pErr := s.DB.GetRun(body.ParentID); pErr == nil {
				parentRecipe = parentRun.Recipe
			}
		}
		firstIt := body.Items[0]
		persistedRecipe = mergePersistedRecipe(
			body.Recipe,
			parentRecipe,
			prompt.Input{
				Style:  firstStr(firstIt.Style, firstRes.StyleID, galCtx.Style),
				Style2: firstIt.Style2,
				Layout: firstStr(firstIt.Layout, firstRes.LayoutID, galCtx.Layout),
				Color:  firstStr(firstIt.Color, firstRes.ColorID, galCtx.Color),
				Tone:   firstStr(firstIt.Tone, galCtx.Tone),
				Mood:   firstIt.Mood,
				Ratio:  firstIt.Ratio,
				Mode:   firstIt.Mode,
				Text:   firstIt.Text,
				Redraw: firstIt.Redraw,
				Extra:  firstIt.Extra,
			},
			body.Resolution,
			body.Quality,
		)
		if len(refMetaList) > 0 {
			runMeta, _ = json.Marshal(map[string]any{"refs": refMetaList})
		}
	}
	run := &store.Run{
		ID:              runID,
		Mode:            body.Mode,
		Title:           firstStr(body.Title, firstNRunes(itemThemes[0], 28), defaultRunTitle),
		OriginalRequest: firstStr(itemThemes[0], body.Input.Theme),
		PromptZh:        firstStr(firstRes.Zh, itemPrompts[0]),
		PromptEn:        firstRes.En,
		Recipe:          persistedRecipe,
		Model:           body.ModelRef,
		ModelLabel:      rawModel,
		Source:          src,
		CostCents:       estCents,
		FreeCount:       freeCnt,
		Status:          "queued",
		Dir:             dir,
		ParentID:        body.ParentID,
		GroupID:         body.GroupID,
		Meta:            runMeta,
	}

	imgs := make([]store.Image, 0, len(body.Items))
	canRef := providerSupportsRef(body.ModelRef)
	baseRefs := make([]string, 0, len(body.Refs)+1)
	for _, ref := range body.Refs {
		if resolved := normalizeLocalRef(ref); resolved != "" {
			baseRefs = append(baseRefs, resolved)
		}
	}
	if guidePath != "" {
		baseRefs = append(baseRefs, guidePath)
	}
	for i, it := range body.Items {
		refs := append([]string{}, baseRefs...)
		if !body.DirectPrompt && !isSite && canRef && built[i].UseReference && built[i].ReferenceImage != "" {
			if resolved := jobs.ResolveRef(built[i].ReferenceImage); resolved != "" {
				refs = append(refs, resolved)
			}
		}
		spec := jobs.Spec{
			ModelRef:   body.ModelRef,
			Prompt:     itemPrompts[i],
			Ratio:      itemRatios[i],
			Resolution: effResolution,
			Quality:    effQuality,
			Refs:       refs,
			Mask:       maskPath,
			RequestID:  jobs.NewID("req"),
			QuoteID:    quoteID,
			QuoteIndex: i,
		}
		if isSite {
			siteMode := firstStr(it.Mode, "pure-image")
			siteTheme := it.Theme
			if body.Mode == "edit" {
				siteMode = "edit"
				siteTheme = itemPrompts[i]
			}
			siteCreationSource := body.Mode
			// Local desktop Markdown articles are not cloud-saved articles with remote articleId/slotId;
			// the website rejects creationSource="article" without those cloud bindings (#72).
			if siteCreationSource == "article" {
				if len(body.Items) > 1 {
					siteCreationSource = "series"
				} else {
					siteCreationSource = "single"
				}
			}
			var sb map[string]any
			if body.DirectPrompt {
				sb = map[string]any{
					"model":           rawModel,
					"resolution":      spec.Resolution,
					"quality":         spec.Quality,
					"ratio":           spec.Ratio,
					"prompt":          itemPrompts[i],
					"style1":          "",
					"style2":          "",
					"layout":          "",
					"colors":          []string{},
					"tones":           []string{},
					"moods":           []string{},
					"theme":           itemThemes[i],
					"displayCopy":     "",
					"mode":            "pure-image",
					"creationSource":  siteCreationSource,
					"autoPublish":     false,
					"promptFromSkill": true,
				}
			} else {
				sb = map[string]any{
					"model":          rawModel,
					"resolution":     spec.Resolution,
					"quality":        spec.Quality,
					"ratio":          spec.Ratio,
					"prompt":         itemPrompts[i],
					"style1":         it.Style,
					"style2":         it.Style2,
					"layout":         it.Layout,
					"colors":         splitParamList(it.Color),
					"tones":          splitParamList(it.Tone),
					"moods":          splitParamList(it.Mood),
					"theme":          siteTheme,
					"displayCopy":    strings.TrimSpace(it.Text),
					"mode":           siteMode,
					"creationSource": siteCreationSource,
					"autoPublish":    false,
				}
				if body.Mode == "edit" || body.PromptCustomized || strings.TrimSpace(it.Prompt) != "" {
					sb["promptFromSkill"] = true
				}
			}
			if siteSpecID != "" {
				sb["specId"] = siteSpecID
			}
			if fo := strings.TrimSpace(body.ForkOf); fo != "" {
				sb["forkOf"] = fo
			}
			spec.SiteBody = sb
		}
		meta, _ := json.Marshal(spec)
		imgs = append(imgs, store.Image{
			ID:     jobs.NewID("img"),
			Idx:    i,
			Status: "queued",
			Theme:  itemThemes[i],
			Prompt: itemPrompts[i],
			Meta:   meta,
		})
	}
	if err := s.DB.InsertRun(run, imgs); err != nil {
		return nil, err
	}
	_ = jobs.WriteRunJSON(s.DB, runID)
	for _, im := range imgs {
		s.Jobs.Enqueue(im.ID)
	}
	run.Images = imgs
	return map[string]any{"run": run, "images": imgs}, nil
}

func (s *Server) seriesPlan(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Topic             string `json:"topic"`
		CSV               string `json:"csv"`
		Count             int    `json:"count"`
		LayoutMode        string `json:"layoutMode"`
		FixedLayout       string `json:"fixedLayout"`
		LayoutRequirement string `json:"layoutRequirement"`
		StyleID           string `json:"styleId"`
		ModelRef          string `json:"modelRef"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.CSV) != "" {
		rd := csv.NewReader(strings.NewReader(body.CSV))
		records, err := rd.ReadAll()
		if err != nil {
			return nil, bad("CSV 解析失败：" + err.Error())
		}
		var cards []map[string]string
		var hdr []string
		for i, row := range records {
			if len(row) == 0 {
				continue
			}
			if i == 0 && (strings.Contains(strings.ToLower(row[0]), "theme") || strings.Contains(row[0], "主题") || strings.Contains(row[0], "标题")) {
				hdr = row
				continue
			}
			item := map[string]string{"theme": strings.TrimSpace(row[0])}
			for c := 1; c < len(row); c++ {
				key := fmt.Sprintf("col%d", c)
				if c < len(hdr) {
					k := strings.ToLower(strings.TrimSpace(hdr[c]))
					if strings.Contains(k, "layout") || strings.Contains(k, "图型") {
						key = "layout"
					} else if strings.Contains(k, "text") || strings.Contains(k, "文案") {
						key = "text"
					} else if strings.Contains(k, "title") || strings.Contains(k, "标题") {
						key = "title"
					}
				}
				item[key] = strings.TrimSpace(row[c])
			}
			if item["theme"] != "" {
				cards = append(cards, item)
			}
		}
		return map[string]any{"cards": cards, "source": "csv"}, nil
	}
	if strings.TrimSpace(body.Topic) == "" {
		return nil, bad("请先填写整套母题")
	}
	if body.Count <= 0 || body.Count > 20 {
		body.Count = 3
	}
	if body.LayoutMode != "fixed" {
		body.LayoutMode = "ai"
	}
	route, err := resolveAIRouteForScene("text", "studioPlan", body.ModelRef)
	if err != nil {
		return nil, err
	}
	applyFixed := func(cards []map[string]string) {
		if body.LayoutMode == "fixed" {
			for _, c := range cards {
				c["layout"] = body.FixedLayout
			}
		}
	}
	planWithHarness := func() (map[string]any, error) {
		promptTxt := fmt.Sprintf("将主题「%s」拆分为 %d 张连贯系列插画分镜。图型策略 %s，固定图型 %s，图型要求 %s。返回 JSON 数组：[{\"title\":\"\",\"theme\":\"\",\"text\":\"\",\"layout\":\"\"}]", body.Topic, body.Count, body.LayoutMode, body.FixedLayout, body.LayoutRequirement)
		res, err := s.callHarnessText(r.Context(), route, []providers.ChatMessage{{Role: "user", Content: promptTxt}}, false)
		if err != nil {
			return nil, err
		}
		cards := seriesCards(json.RawMessage(extractJSON(res.Text)))
		if len(cards) == 0 {
			return nil, bad("本地 Harness 返回的分镜格式无法解析")
		}
		applyFixed(cards)
		return map[string]any{"cards": cards, "source": "harness", "harness": route.Harness.ID}, nil
	}
	planWithSite := func() (map[string]any, error) {
		req := map[string]any{
			"seed": body.Topic, "count": body.Count, "layoutMode": body.LayoutMode,
			"fixedLayout": body.FixedLayout, "layoutRequirement": body.LayoutRequirement, "styleId": body.StyleID,
		}
		raw, err := s.Site.BatchPlan(r.Context(), req)
		if err != nil {
			return nil, err
		}
		cards := seriesCards(raw)
		if len(cards) == 0 {
			return nil, bad("线上规划返回为空")
		}
		applyFixed(cards)
		return map[string]any{"cards": cards, "source": planningSource(raw)}, nil
	}
	planWithProvider := func(tp settings.Provider, model string) (map[string]any, error) {
		promptTxt := fmt.Sprintf("将主题「%s」拆分为 %d 张连贯系列插画分镜。图型策略 %s，固定图型 %s，图型要求 %s。返回 JSON 数组：[{\"title\":\"\",\"theme\":\"\",\"text\":\"\",\"layout\":\"\"}]", body.Topic, body.Count, body.LayoutMode, body.FixedLayout, body.LayoutRequirement)
		reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{{Role: "user", Content: promptTxt}}, false)
		if err != nil {
			return nil, err
		}
		cards := seriesCards(json.RawMessage(extractJSON(reply)))
		if len(cards) == 0 {
			return nil, bad("自定义文本模型返回的分镜格式无法解析")
		}
		applyFixed(cards)
		return map[string]any{"cards": cards, "source": "provider"}, nil
	}
	switch route.Mode {
	case "harness":
		return planWithHarness()
	case "provider":
		return planWithProvider(route.Provider, route.Model)
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		return planWithSite()
	default:
		if s.Site.LoggedIn() {
			if res, err := planWithSite(); err == nil {
				return res, nil
			}
		}
		if tp, model, ok := findTextProviderFor("text"); ok {
			if res, err := planWithProvider(tp, model); err == nil {
				return res, nil
			}
		}
	}
	cards := make([]map[string]string, 0, body.Count)
	for i := 0; i < body.Count; i++ {
		cards = append(cards, map[string]string{
			"title": fmt.Sprintf("第 %d 张", i+1),
			"theme": fmt.Sprintf("%s · 核心场景 %d", strings.TrimSpace(body.Topic), i+1),
			"layout": func() string {
				if body.LayoutMode == "fixed" {
					return body.FixedLayout
				}
				return ""
			}(),
		})
	}
	return map[string]any{"cards": cards, "source": "local"}, nil
}

func buildArticlePlanMessages(title, content string, includeCover bool) []providers.ChatMessage {
	sys := strings.TrimSpace(`你是资深的公众号与专栏插画视觉总监。请通读用户提供的 Markdown 文章，为其规划最能提升阅读氛围与传播力的配图方案。

核心要求：
1. 若需要封面（includeCover=true），第 1 个槽位必须是 role="cover"（anchor 留空 ""），提炼整篇文章最具情绪张力或视觉隐喻的封面画面。
2. 正文插图（role="inline"）根据文章篇幅规划 2~5 张，均匀分布在关键情绪转折点、核心观点或故事节点之后。
3. 每个 inline 槽位的 anchor 必须是文章原文中真实存在的连续文字片段（10~35 字，不要编造或改写），以便精准定位插入位置。
4. 每个槽位的 theme 必须是具体的中文视觉画面描述（35~90 字：包含画面主体、动作神态、场景道具、光影氛围与构图隐喻），严禁机械照抄原文段落或 Markdown 标记符号。
5. title 为简洁的 4~12 字配图小标题；recommendedStyles 推荐 2~3 个合适的画风编号（如 "FA-013", "FB-001", "FE-001"）。
6. 严格只输出一个合法 JSON 对象，不要包含额外解释或代码块围栏，格式如下：
{"recommendedStyles":["FA-013"],"slots":[{"role":"cover|inline","anchor":"正文原文片段或空","title":"配图小标题","theme":"具体视觉画面描述","layout":""}]}`)
	trimmedContent := content
	if runes := []rune(trimmedContent); len(runes) > 9000 {
		trimmedContent = string(runes[:9000]) + "\n……（正文已截断）"
	}
	user := fmt.Sprintf("请分析下面文章，规划配图位（包含封面：%t）。\n文章标题：%s\n\n文章正文：\n%s", includeCover, firstStr(strings.TrimSpace(title), "（未命名）"), trimmedContent)
	return []providers.ChatMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: user},
	}
}

func (s *Server) articlePlan(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Title        string `json:"title"`
		Content      string `json:"content"`
		Count        int    `json:"count"`
		StyleID      string `json:"styleId"`
		CoverRatio   string `json:"coverRatio"`
		InlineRatio  string `json:"inlineRatio"`
		IncludeCover *bool  `json:"includeCover"`
		ModelRef     string `json:"modelRef"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Content) == "" {
		return nil, bad("请先输入或导入文章正文")
	}
	body.CoverRatio = firstStr(body.CoverRatio, "2.35:1")
	body.InlineRatio = firstStr(body.InlineRatio, "4:3")
	includeCover := body.IncludeCover == nil || *body.IncludeCover
	route, err := resolveAIRouteForScene("text", "articlePlan", body.ModelRef)
	if err != nil {
		return nil, err
	}
	planMsgs := buildArticlePlanMessages(body.Title, body.Content, includeCover)
	planWithHarness := func() (map[string]any, error) {
		res, err := s.callHarnessText(r.Context(), route, planMsgs, true)
		if err != nil {
			return nil, err
		}
		slots, styles := articleSlots(json.RawMessage(extractJSON(res.Text)), body.Content, body.CoverRatio, body.InlineRatio, includeCover)
		if len(slots) == 0 {
			return nil, bad("本地 Harness 返回的配图规划无法解析")
		}
		return map[string]any{
			"slots":             slots,
			"recommendedStyles": styles,
			"source":            "harness",
			"harness":           route.Harness.ID,
			"model":             firstStr(res.Model, route.Harness.Name),
		}, nil
	}

	planWithSiteEndpoint := func() (map[string]any, error) {
		request := articlePlanRequest(body.Title, body.Content, body.StyleID, body.CoverRatio, body.InlineRatio, includeCover)
		raw, err := s.Site.ArticlePlan(r.Context(), request)
		if err != nil {
			return nil, err
		}
		src := planningSource(raw)
		if src == "local" {
			return nil, bad("网站 article-plan 接口返回了模板结果，改用 AI 对话规划")
		}
		slots, styles := articleSlots(raw, body.Content, body.CoverRatio, body.InlineRatio, includeCover)
		if len(slots) == 0 {
			return nil, bad("线上接口未能规划出有效配图位")
		}
		return map[string]any{"slots": slots, "recommendedStyles": styles, "source": src, "model": "官方文章规划服务"}, nil
	}
	planWithSiteAIChat := func() (map[string]any, error) {
		res, err := s.Site.AIChat(r.Context(), site.AIChatRequest{
			Capability:   "text",
			Messages:     planMsgs,
			JSONMode:     true,
			FeatureScope: "article_plan",
		})
		if err != nil {
			return nil, err
		}
		slots, styles := articleSlots(json.RawMessage(extractJSON(firstStr(res.Content, res.Text))), body.Content, body.CoverRatio, body.InlineRatio, includeCover)
		if len(slots) == 0 {
			return nil, bad("官方智能文字服务返回的配图规划无法解析")
		}
		return map[string]any{
			"slots":             slots,
			"recommendedStyles": styles,
			"source":            "site",
			"model":             firstStr(res.Service, "官方智能文字服务"),
		}, nil
	}
	planWithSite := func() (map[string]any, error) {
		if res, err := planWithSiteEndpoint(); err == nil {
			return res, nil
		} else {
			if chatRes, chatErr := planWithSiteAIChat(); chatErr == nil {
				return chatRes, nil
			} else {
				return nil, fmt.Errorf("%v；AI 文本规划失败：%v", err, chatErr)
			}
		}
	}
	planWithProvider := func(tp settings.Provider, model string) (map[string]any, error) {
		reply, err := providers.Chat(r.Context(), tp, model, planMsgs, true)
		if err != nil {
			// Some OpenAI-compatible relays reject response_format=json_object; retry once without JSONMode.
			if retryReply, retryErr := providers.Chat(r.Context(), tp, model, planMsgs, false); retryErr == nil {
				reply, err = retryReply, nil
			}
		}
		if err != nil {
			return nil, err
		}
		slots, styles := articleSlots(json.RawMessage(extractJSON(reply)), body.Content, body.CoverRatio, body.InlineRatio, includeCover)
		if len(slots) == 0 {
			return nil, bad("自定义文本模型返回的配图规划无法解析")
		}
		return map[string]any{
			"slots":             slots,
			"recommendedStyles": styles,
			"source":            "provider",
			"model":             model,
			"provider":          tp.ID,
		}, nil
	}

	var fallbackReason string
	switch route.Mode {
	case "harness":
		return planWithHarness()
	case "provider":
		return planWithProvider(route.Provider, route.Model)
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		return planWithSite()
	default:
		var errs []string
		if s.Site.LoggedIn() {
			if res, err := planWithSite(); err == nil {
				return res, nil
			} else {
				errs = append(errs, "官方接口："+err.Error())
			}
		}
		if tp, model, ok := findTextProviderFor("text"); ok {
			if res, err := planWithProvider(tp, model); err == nil {
				return res, nil
			} else {
				errs = append(errs, "自定义模型："+err.Error())
			}
		}
		if len(errs) > 0 {
			fallbackReason = strings.Join(errs, "；")
		} else {
			fallbackReason = "未登录手绘风账号且未配置自定义文本模型"
		}
	}
	// Heuristic local fallback: split headings/paragraphs into cover + inline illustration slots.
	paras := splitParagraphs(body.Content)
	slots := []map[string]any{}
	if includeCover {
		slots = append(slots, map[string]any{
			"id": "slot_cover", "role": "cover", "anchor": "", "title": "文章封面",
			"theme": firstStr(stripMarkdownLead(body.Title), firstNRunes(stripMarkdownLead(body.Content), 40)), "ratio": body.CoverRatio,
		})
	}
	step := 1
	if len(paras) > 5 {
		step = len(paras) / 4
	}
	for i := 0; i < len(paras) && len(slots) < 6; i += step {
		slots = append(slots, map[string]any{
			"id": fmt.Sprintf("slot_%d", len(slots)), "role": "inline",
			"anchor": firstNRunes(paras[i], 28), "title": fmt.Sprintf("正文配图 %d", len(slots)),
			"theme": firstNRunes(stripMarkdownLead(paras[i]), 80), "ratio": body.InlineRatio,
		})
	}
	return map[string]any{
		"source":            "local",
		"fallbackReason":    fallbackReason,
		"recommendedStyles": []string{"FA-013", "FB-001", "FE-001"},
		"slots":             slots,
	}, nil
}

func (s *Server) articleImport(w http.ResponseWriter, r *http.Request) (any, error) {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(30 << 20); err != nil {
			return nil, bad(err.Error())
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			return nil, bad("缺少上传文件")
		}
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, 30<<20))
		if err != nil {
			return nil, err
		}
		ext := strings.ToLower(filepath.Ext(hdr.Filename))
		title := strings.TrimSuffix(hdr.Filename, filepath.Ext(hdr.Filename))
		if ext == ".docx" {
			text, err := extractDocxText(b)
			if err != nil {
				return nil, bad("DOCX 解析失败：" + err.Error())
			}
			return map[string]any{"title": title, "content": text}, nil
		}
		return map[string]any{"title": title, "content": string(b)}, nil
	}
	var body struct {
		URL     string `json:"url"`
		Content string `json:"content"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.URL != "" {
		if !strings.HasPrefix(body.URL, "https://") && !strings.HasPrefix(body.URL, "http://") {
			return nil, bad("文章链接必须以 http:// 或 https:// 开头")
		}
		req, _ := http.NewRequestWithContext(r.Context(), "GET", body.URL, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 HandrawClient")
		resp, err := s.Site.HTTP.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		title, text := stripHTMLArticle(string(raw))
		return map[string]any{"title": title, "content": text}, nil
	}
	return map[string]any{"content": body.Content}, nil
}

func (s *Server) articleExport(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Title   string `json:"title"`
		Content string `json:"content"`
		Format  string `json:"format"` // markdown_zip | wechat_html | images_zip
		Slots   []struct {
			Role      string `json:"role"`
			Anchor    string `json:"anchor"`
			Title     string `json:"title"`
			ImagePath string `json:"imagePath"`
		} `json:"slots"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	outDir := filepath.Join(settings.Get().WorksDir, "articles")
	_ = os.MkdirAll(outDir, 0o755)
	safeTitle := sanitizeName(firstStr(body.Title, "article"))

	if body.Format == "wechat_html" {
		var sb strings.Builder
		sb.WriteString(`<section style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.8;color:#222;font-size:16px;">`)
		if body.Title != "" {
			sb.WriteString(`<h1 style="font-size:22px;font-weight:700;margin:0 0 18px;">` + html.EscapeString(body.Title) + `</h1>`)
		}
		for _, sl := range body.Slots {
			if sl.Role == "cover" && sl.ImagePath != "" {
				if b, err := os.ReadFile(sl.ImagePath); err == nil {
					sb.WriteString(imageTagHTML(b, sl.Title))
				}
			}
		}
		for _, para := range splitParagraphs(body.Content) {
			if strings.HasPrefix(para, "#") {
				sb.WriteString(`<h2 style="font-size:18px;font-weight:700;margin:22px 0 10px;">` + html.EscapeString(strings.TrimLeft(para, "# ")) + `</h2>`)
			} else {
				sb.WriteString(`<p style="margin:0 0 14px;">` + html.EscapeString(para) + `</p>`)
			}
			for _, sl := range body.Slots {
				if sl.Role != "cover" && sl.Anchor != "" && strings.Contains(para, sl.Anchor) && sl.ImagePath != "" {
					if b, err := os.ReadFile(sl.ImagePath); err == nil {
						sb.WriteString(imageTagHTML(b, sl.Title))
					}
				}
			}
		}
		sb.WriteString(`</section>`)
		htmlOut := sb.String()
		htmlPath := filepath.Join(outDir, safeTitle+".wechat.html")
		_ = os.WriteFile(htmlPath, []byte(htmlOut), 0o644)
		return map[string]any{"ok": true, "html": htmlOut, "path": htmlPath}, nil
	}

	var md strings.Builder
	if body.Title != "" {
		md.WriteString("# " + body.Title + "\n\n")
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	imgIdx := 0
	addSlotImg := func(path, alt string) string {
		if path == "" {
			return ""
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return ""
		}
		imgIdx++
		rel := fmt.Sprintf("images/%02d%s", imgIdx, sniffImageExt(b))
		f, _ := zw.Create(rel)
		_, _ = f.Write(b)
		return fmt.Sprintf("![%s](%s)\n\n", alt, rel)
	}
	for _, sl := range body.Slots {
		if sl.Role == "cover" {
			md.WriteString(addSlotImg(sl.ImagePath, firstStr(sl.Title, "封面")))
		}
	}
	for _, para := range splitParagraphs(body.Content) {
		md.WriteString(para + "\n\n")
		for _, sl := range body.Slots {
			if sl.Role != "cover" && sl.Anchor != "" && strings.Contains(para, sl.Anchor) {
				md.WriteString(addSlotImg(sl.ImagePath, sl.Title))
			}
		}
	}
	if body.Format != "images_zip" {
		f, _ := zw.Create(safeTitle + ".md")
		_, _ = f.Write([]byte(md.String()))
	}
	zw.Close()
	zipPath := filepath.Join(outDir, safeTitle+".zip")
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o644); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "path": zipPath, "markdown": md.String()}, nil
}

func (s *Server) canvasAssistant(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Prompt   string `json:"prompt"`
		ModelRef string `json:"modelRef"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Prompt) == "" {
		return nil, bad("请描述你想搭建的画布流程")
	}
	route, err := resolveAIRouteForScene("text", "canvas", body.ModelRef)
	if err != nil {
		return nil, err
	}
	buildWithHarness := func() (map[string]any, error) {
		ask := fmt.Sprintf("根据用户需求「%s」生成节点画布工作流 JSON：{\"nodes\":[{\"id\":\"n1\",\"type\":\"themes|recipe|styles|generate|export\",\"x\":80,\"y\":120,\"data\":{\"label\":\"\",\"items\":[]}}],\"edges\":[{\"id\":\"e1\",\"from\":\"n1\",\"to\":\"n2\"}]}", body.Prompt)
		res, err := s.callHarnessText(r.Context(), route, []providers.ChatMessage{{Role: "user", Content: ask}}, true)
		if err != nil {
			return nil, err
		}
		var g map[string]any
		if json.Unmarshal([]byte(extractJSON(res.Text)), &g) != nil {
			return nil, bad("本地 Harness 返回的画布 JSON 无法解析")
		}
		g["source"] = "harness"
		g["harness"] = route.Harness.ID
		return g, nil
	}
	buildWithSite := func() (map[string]any, error) {
		req := map[string]any{"prompt": body.Prompt}
		raw, err := s.Site.CanvasAssistant(r.Context(), req)
		if err != nil {
			var ae *site.APIError
			if errors.As(err, &ae) && (ae.Status == 404 || ae.Status == 403) {
				ask := fmt.Sprintf("根据用户需求「%s」生成节点画布工作流 JSON：{\"nodes\":[{\"id\":\"n1\",\"type\":\"themes|recipe|styles|generate|export\",\"x\":80,\"y\":120,\"data\":{\"label\":\"\",\"items\":[]}}],\"edges\":[{\"id\":\"e1\",\"from\":\"n1\",\"to\":\"n2\"}]}", body.Prompt)
				aiRes, aiErr := s.Site.AIChat(r.Context(), site.AIChatRequest{
					Capability:   "text",
					Messages:     []providers.ChatMessage{{Role: "user", Content: ask}},
					JSONMode:     true,
					FeatureScope: "canvas_assistant",
				})
				if aiErr != nil {
					return nil, aiErr
				}
				var g map[string]any
				if json.Unmarshal([]byte(extractJSON(aiRes.Content)), &g) != nil {
					return nil, bad("官方文字服务返回的画布 JSON 无法解析")
				}
				g["source"] = "site"
				return g, nil
			}
			return nil, err
		}
		return map[string]any{"raw": raw, "source": "site"}, nil
	}
	buildWithProvider := func(tp settings.Provider, model string) (map[string]any, error) {
		ask := fmt.Sprintf("根据用户需求「%s」生成节点画布工作流 JSON：{\"nodes\":[{\"id\":\"n1\",\"type\":\"themes|recipe|styles|generate|export\",\"x\":80,\"y\":120,\"data\":{\"label\":\"\",\"items\":[]}}],\"edges\":[{\"id\":\"e1\",\"from\":\"n1\",\"to\":\"n2\"}]}", body.Prompt)
		reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{{Role: "user", Content: ask}}, true)
		if err != nil {
			return nil, err
		}
		var g map[string]any
		if json.Unmarshal([]byte(extractJSON(reply)), &g) != nil {
			return nil, bad("自定义文本模型返回的画布 JSON 无法解析")
		}
		g["source"] = "provider"
		return g, nil
	}
	switch route.Mode {
	case "harness":
		return buildWithHarness()
	case "provider":
		return buildWithProvider(route.Provider, route.Model)
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		return buildWithSite()
	default:
		if s.Site.LoggedIn() {
			if res, err := buildWithSite(); err == nil {
				return res, nil
			}
		}
		if tp, model, ok := findTextProviderFor("text"); ok {
			if res, err := buildWithProvider(tp, model); err == nil {
				return res, nil
			}
		}
	}
	tpl := builtinTemplates()[0]
	return map[string]any{
		"source": "local",
		"nodes": []any{
			map[string]any{"id": "n1", "type": "themes", "x": 80, "y": 140, "data": map[string]any{"label": "主题拆解", "items": []string{body.Prompt + " · 场景 1", body.Prompt + " · 场景 2", body.Prompt + " · 场景 3"}}},
			map[string]any{"id": "n2", "type": "styles", "x": 80, "y": 320, "data": map[string]any{"label": "手绘画风", "items": []string{"FA-013", "FB-001"}}},
			map[string]any{"id": "n3", "type": "generate", "x": 420, "y": 210, "data": map[string]any{"label": "组合生成 6 张", "count": 1}},
		},
		"edges": tpl.Edges[:2],
	}, nil
}

// ---------- helpers ----------

func extractDocxText(raw []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return "", err
	}
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		b, _ := io.ReadAll(io.LimitReader(rc, 20<<20))
		rc.Close()
		dec := xml.NewDecoder(bytes.NewReader(b))
		var out strings.Builder
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.CharData:
				out.Write(t)
			case xml.EndElement:
				if t.Name.Local == "p" {
					out.WriteString("\n\n")
				}
			}
		}
		return strings.TrimSpace(out.String()), nil
	}
	return "", fmt.Errorf("未在压缩包中找到 word/document.xml")
}

var (
	reScript = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)
	reTitle  = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reTags   = regexp.MustCompile(`<[^>]+>`)
)

func stripHTMLArticle(s string) (string, string) {
	title := ""
	if m := reTitle.FindStringSubmatch(s); len(m) > 1 {
		title = strings.TrimSpace(html.UnescapeString(reTags.ReplaceAllString(m[1], "")))
	}
	s = reScript.ReplaceAllString(s, "\n")
	s = strings.NewReplacer("</p>", "\n\n", "<br>", "\n", "<br/>", "\n", "</h1>", "\n\n", "</h2>", "\n\n", "</h3>", "\n\n").Replace(s)
	txt := html.UnescapeString(reTags.ReplaceAllString(s, ""))
	lines := splitParagraphs(txt)
	return title, strings.Join(lines, "\n\n")
}

func splitParagraphs(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var out []string
	for _, p := range strings.Split(s, "\n") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func normalizeLocalRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	if strings.HasPrefix(ref, "/files/local") {
		if u, err := url.Parse(ref); err == nil {
			if p := u.Query().Get("p"); p != "" {
				return p
			}
		}
	}
	if strings.HasPrefix(ref, "/files/pack/") {
		ref = strings.TrimPrefix(ref, "/files/pack/")
	}
	return jobs.ResolveRef(ref)
}

func providerSupportsRef(modelRef string) bool {
	pid, mid, ok := strings.Cut(modelRef, ":")
	if !ok {
		return false
	}
	if p, found := findProvider(pid); found {
		for _, m := range p.Models {
			if m.ID == mid {
				return m.CanRefImage
			}
		}
	}
	return false
}

func firstNRunes(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n])
}

func sanitizeName(s string) string {
	return strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-", "\"", "", "<", "", ">", "", "|", "-").Replace(strings.TrimSpace(s))
}

func imageTagHTML(b []byte, alt string) string {
	mime := "image/png"
	switch sniffImageExt(b) {
	case ".jpg":
		mime = "image/jpeg"
	case ".webp":
		mime = "image/webp"
	}
	return fmt.Sprintf(`<p style="margin:18px 0;text-align:center;"><img src="data:%s;base64,%s" alt="%s" style="max-width:100%%;border-radius:8px;" /></p>`,
		mime, base64.StdEncoding.EncodeToString(b), html.EscapeString(alt))
}

func splitParamList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == '+' || r == '、' || r == '/' || r == ';' || r == '；'
	})
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// appendChineseTypographyDirective locks on-image typography to Simplified Chinese
// for Chinese graphic-text/poster requests so English style names do not nudge
// image models into inventing English headings (#63).
func appendChineseTypographyDirective(finalPrompt, mode, layout, theme, displayCopy string) string {
	m := strings.ToLower(strings.TrimSpace(mode))
	isGraphicText := m == "graphic-text" || m == "poster" || (strings.TrimSpace(layout) != "" && m != "pure-image" && m != "pure")
	if !isGraphicText || strings.TrimSpace(finalPrompt) == "" {
		return finalPrompt
	}
	if strings.Contains(finalPrompt, "画面文字语言：") || strings.Contains(finalPrompt, "简体中文") {
		return finalPrompt
	}
	copyTrim := strings.TrimSpace(displayCopy)
	if copyTrim != "" {
		if prompt.DetectLanguage(copyTrim) != "zh" {
			return finalPrompt
		}
		return finalPrompt + "\n画面文字语言：请严格呈现以上中文文案，画面中所有可见文字均须使用简体中文，不得擅自改成或添加英文标题。"
	}
	if prompt.DetectLanguage(strings.TrimSpace(theme)) != "zh" {
		return finalPrompt
	}
	return finalPrompt + "\n画面文字语言：画面中所有标题与可见文字均须使用简体中文，不得擅自使用英文。"
}

func annotatePositionLabel(x, y float64) string {
	h := "中部"
	switch {
	case x < 0.33:
		h = "左侧"
	case x > 0.67:
		h = "右侧"
	}
	v := "中部"
	switch {
	case y < 0.33:
		v = "上方"
	case y > 0.67:
		v = "下方"
	}
	if h == "中部" && v == "中部" {
		return "画面中央"
	}
	if h == "中部" {
		return "画面中" + v
	}
	if v == "中部" {
		return "画面" + h + "中部"
	}
	return "画面" + strings.TrimSuffix(h, "侧") + v
}

// buildAnnotateEditPrompt turns pin annotations (with x/y coordinates and optional
// numbered visual guide reference image) into a clear image-editing instruction (#67).
func buildAnnotateEditPrompt(annotations []map[string]any, hasGuide bool) string {
	var lines []string
	idx := 0
	for _, a := range annotations {
		txt, _ := a["text"].(string)
		txt = strings.TrimSpace(txt)
		if txt == "" {
			continue
		}
		idx++
		x, xOk := a["x"].(float64)
		y, yOk := a["y"].(float64)
		if xOk && yOk {
			if x < 0 {
				x = 0
			} else if x > 1 {
				x = 1
			}
			if y < 0 {
				y = 0
			} else if y > 1 {
				y = 1
			}
			pos := annotatePositionLabel(x, y)
			lines = append(lines, fmt.Sprintf("%d. 【标记 %d · %s（约 x=%.0f%%, y=%.0f%%）】：%s", idx, idx, pos, x*100, y*100, txt))
		} else {
			lines = append(lines, fmt.Sprintf("%d. 【标记 %d】：%s", idx, idx, txt))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("请严格基于所附参考图进行局部精准编辑修改：\n")
	if hasGuide {
		sb.WriteString("- 参考图 1 是需要修改的干净原图；参考图 2 是带醒目红色编号圆点（1、2、3…）的位置指引图，红色编号圆点仅用于指示修改坐标。\n")
	} else {
		sb.WriteString("- 参考图 1 是需要修改的原图。\n")
	}
	sb.WriteString("- 必须严格保留原图的整体构图、画风笔触、材质肌理、配色氛围、原有文字与所有未标注区域完全不变。\n")
	sb.WriteString("- 仅在以下标注位置执行对应修改：\n")
	for _, ln := range lines {
		sb.WriteString("  " + ln + "\n")
	}
	if hasGuide {
		sb.WriteString("- 重要：最终生成的图片中严禁保留或出现任何红色圆点、白圈或数字编号标记；新增或修改的内容必须自然融入原图的画风、透视与光影中。")
	} else {
		sb.WriteString("- 新增或修改的内容必须自然融入原图的画风、透视与光影中。")
	}
	return sb.String()
}
