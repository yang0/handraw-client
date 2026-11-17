package server

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

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
	var in prompt.Input
	if err := decode(r, &in); err != nil {
		return nil, err
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
		Theme string `json:"theme"`
		Style string `json:"style"`
		Mode  string `json:"mode"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Theme) == "" {
		return nil, bad("请输入要扩写的主题")
	}
	if tp, model, ok := findTextProvider(); ok {
		sys := "你是手绘插画画面构思助手。将用户简短主题扩写成丰富、具体、有画面感的中文场景描述（不超过 120 字），只补充主体动作、环境氛围、视角细节，不要指定画风或色彩术语。"
		reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{
			{Role: "system", Content: sys},
			{Role: "user", Content: body.Theme},
		}, false)
		if err == nil && strings.TrimSpace(reply) != "" {
			return map[string]any{"theme": strings.TrimSpace(reply), "source": "provider"}, nil
		}
	}
	if s.Site.LoggedIn() {
		raw, err := s.Site.BatchPlan(r.Context(), map[string]any{"topic": body.Theme, "count": 1})
		if err == nil {
			var res struct {
				Items []struct {
					Theme  string `json:"theme"`
					Prompt string `json:"prompt"`
				} `json:"items"`
			}
			if json.Unmarshal(raw, &res) == nil && len(res.Items) > 0 {
				t := firstStr(res.Items[0].Theme, res.Items[0].Prompt)
				if t != "" {
					return map[string]any{"theme": t, "source": "site"}, nil
				}
			}
		}
	}
	// Deterministic fallback enrichment when no text model is available.
	return map[string]any{
		"theme":  strings.TrimSpace(body.Theme) + "，前景主体鲜明生动，中景有生活气息的小细节，背景柔和透气形成层次感",
		"source": "local",
	}, nil
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
		if p.Purpose == "text" {
			txtProvs = append(txtProvs, p)
		} else {
			imgProvs = append(imgProvs, p)
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
		"site":           normalizeSiteModels(siteModels),
		"providers":      imgProvs,
		"textProviders":  txtProvs,
		"defaultModel":   st.DefaultModel,
		"costLimitCents": st.CostLimitCents,
		"loggedIn":       s.Site.LoggedIn(),
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
	if body.Resolution == "" {
		body.Resolution = "1k"
	}
	if strings.HasPrefix(body.ModelRef, "site:") {
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		modelID := strings.TrimPrefix(body.ModelRef, "site:")
		raw, err := s.Site.Quote(r.Context(), []map[string]any{{
			"model":      modelID,
			"resolution": body.Resolution,
			"quality":    firstStr(body.Quality, "standard"),
			"count":      body.Count,
		}})
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
		Recipe           json.RawMessage  `json:"recipe"`
		PromptCustomized bool             `json:"promptCustomized"`
		CustomPrompt     string           `json:"customPrompt"`
		Annotations      []map[string]any `json:"annotations"`
		MaskDataURL      string           `json:"maskDataUrl"`
		Refs             []string         `json:"refs"`
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

	// Build prompts for each item.
	_, rawModel, _ := strings.Cut(body.ModelRef, ":")
	var built []prompt.Result
	var itemPrompts []string
	var itemRatios []string
	var itemThemes []string
	for _, it := range body.Items {
		in := prompt.Input{
			Style: it.Style, Style2: it.Style2, Layout: it.Layout, Color: it.Color,
			Tone: it.Tone, Mood: it.Mood, Theme: it.Theme, Ratio: it.Ratio,
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
		if len(body.Annotations) > 0 {
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
		built = append(built, pr)
		itemPrompts = append(itemPrompts, finalPrompt)
		itemRatios = append(itemRatios, firstStr(it.Ratio, "3:4"))
		itemThemes = append(itemThemes, firstStr(it.Theme, body.Input.Theme))
	}

	var quoteID string
	var estCents, freeCnt int
	if isSite {
		qItems := make([]map[string]any, 0, len(body.Items))
		for range body.Items {
			qItems = append(qItems, map[string]any{
				"model":      rawModel,
				"resolution": firstStr(body.Resolution, "1k"),
				"quality":    firstStr(body.Quality, "standard"),
				"count":      1,
			})
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
	src := "provider"
	if isSite {
		src = "site"
	}
	firstRes := built[0]
	run := &store.Run{
		ID:              runID,
		Mode:            body.Mode,
		Title:           firstStr(body.Title, itemThemes[0], "手绘风创作"),
		OriginalRequest: firstStr(itemThemes[0], body.Input.Theme),
		PromptZh:        firstStr(firstRes.Zh, itemPrompts[0]),
		PromptEn:        firstRes.En,
		Recipe:          body.Recipe,
		Model:           body.ModelRef,
		ModelLabel:      rawModel,
		Source:          src,
		CostCents:       estCents,
		FreeCount:       freeCnt,
		Status:          "queued",
		Dir:             dir,
		ParentID:        body.ParentID,
		GroupID:         body.GroupID,
	}

	imgs := make([]store.Image, 0, len(body.Items))
	canRef := providerSupportsRef(body.ModelRef)
	baseRefs := make([]string, 0, len(body.Refs))
	for _, ref := range body.Refs {
		if resolved := normalizeLocalRef(ref); resolved != "" {
			baseRefs = append(baseRefs, resolved)
		}
	}
	for i, it := range body.Items {
		refs := append([]string{}, baseRefs...)
		if !isSite && canRef && built[i].UseReference && built[i].ReferenceImage != "" {
			if resolved := jobs.ResolveRef(built[i].ReferenceImage); resolved != "" {
				refs = append(refs, resolved)
			}
		}
		spec := jobs.Spec{
			ModelRef:   body.ModelRef,
			Prompt:     itemPrompts[i],
			Ratio:      itemRatios[i],
			Resolution: firstStr(body.Resolution, "1k"),
			Quality:    firstStr(body.Quality, "standard"),
			Refs:       refs,
			Mask:       maskPath,
			RequestID:  jobs.NewID("req"),
			QuoteID:    quoteID,
			QuoteIndex: i,
		}
		if isSite {
			spec.SiteBody = map[string]any{
				"model":          rawModel,
				"resolution":     spec.Resolution,
				"quality":        spec.Quality,
				"ratio":          spec.Ratio,
				"prompt":         itemPrompts[i],
				"style1":         it.Style,
				"style2":         it.Style2,
				"layout":         it.Layout,
				"colors":         it.Color,
				"tone":           it.Tone,
				"mood":           it.Mood,
				"theme":          it.Theme,
				"mode":           firstStr(it.Mode, "pure-image"),
				"creationSource": body.Mode,
				"autoPublish":    false,
			}
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
	if s.Site.LoggedIn() {
		if raw, err := s.Site.BatchPlan(r.Context(), map[string]any{
			"seed": body.Topic, "count": body.Count, "layoutMode": body.LayoutMode,
			"fixedLayout": body.FixedLayout, "layoutRequirement": body.LayoutRequirement, "styleId": body.StyleID,
		}); err == nil {
			if cards := seriesCards(raw); len(cards) > 0 {
				if body.LayoutMode == "fixed" {
					for _, c := range cards {
						c["layout"] = body.FixedLayout
					}
				}
				return map[string]any{"cards": cards, "source": planningSource(raw)}, nil
			}
		}
	}
	if tp, model, ok := findTextProvider(); ok {
		promptTxt := fmt.Sprintf("将主题「%s」拆分为 %d 张连贯系列插画分镜。图型策略 %s，固定图型 %s，图型要求 %s。返回 JSON 数组：[{\"title\":\"\",\"theme\":\"\",\"text\":\"\",\"layout\":\"\"}]", body.Topic, body.Count, body.LayoutMode, body.FixedLayout, body.LayoutRequirement)
		if reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{{Role: "user", Content: promptTxt}}, false); err == nil {
			if cards := seriesCards(json.RawMessage(extractJSON(reply))); len(cards) > 0 {
				if body.LayoutMode == "fixed" {
					for _, c := range cards {
						c["layout"] = body.FixedLayout
					}
				}
				return map[string]any{"cards": cards, "source": "provider"}, nil
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

func (s *Server) articlePlan(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Title        string `json:"title"`
		Content      string `json:"content"`
		Count        int    `json:"count"`
		StyleID      string `json:"styleId"`
		CoverRatio   string `json:"coverRatio"`
		InlineRatio  string `json:"inlineRatio"`
		IncludeCover *bool  `json:"includeCover"`
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
	if s.Site.LoggedIn() {
		request := articlePlanRequest(body.Title, body.Content, body.StyleID, body.CoverRatio, body.InlineRatio, includeCover)
		if raw, err := s.Site.ArticlePlan(r.Context(), request); err == nil {
			if slots, styles := articleSlots(raw, body.Content, body.CoverRatio, body.InlineRatio, includeCover); len(slots) > 0 {
				return map[string]any{"slots": slots, "recommendedStyles": styles, "source": planningSource(raw)}, nil
			}
		}
	}
	if tp, model, ok := findTextProvider(); ok {
		ask := fmt.Sprintf("分析下面文章，规划配图位（包含封面：%t）。正文 anchor 必须引用正文中的原文。返回严格 JSON: {\"recommendedStyles\":[],\"slots\":[{\"role\":\"cover|inline\",\"anchor\":\"\",\"title\":\"\",\"theme\":\"\"}]}\n\n标题：%s\n正文：%s", includeCover, body.Title, body.Content)
		if reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{{Role: "user", Content: ask}}, true); err == nil {
			if slots, styles := articleSlots(json.RawMessage(extractJSON(reply)), body.Content, body.CoverRatio, body.InlineRatio, includeCover); len(slots) > 0 {
				return map[string]any{"slots": slots, "recommendedStyles": styles, "source": "provider"}, nil
			}
		}
	}
	// Heuristic local fallback: split headings/paragraphs into cover + inline illustration slots.
	paras := splitParagraphs(body.Content)
	slots := []map[string]any{}
	if includeCover {
		slots = append(slots, map[string]any{
			"id": "slot_cover", "role": "cover", "anchor": body.Title, "title": "文章封面",
			"theme": firstStr(body.Title, firstNRunes(body.Content, 40)), "ratio": body.CoverRatio,
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
			"theme": firstNRunes(paras[i], 80), "ratio": body.InlineRatio,
		})
	}
	return map[string]any{
		"source":            "local",
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
		Prompt string `json:"prompt"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Prompt) == "" {
		return nil, bad("请描述你想搭建的画布流程")
	}
	if s.Site.LoggedIn() {
		if raw, err := s.Site.CanvasAssistant(r.Context(), map[string]any{"prompt": body.Prompt}); err == nil {
			return map[string]any{"raw": raw, "source": "site"}, nil
		}
	}
	if tp, model, ok := findTextProvider(); ok {
		ask := fmt.Sprintf("根据用户需求「%s」生成节点画布工作流 JSON：{\"nodes\":[{\"id\":\"n1\",\"type\":\"themes|recipe|styles|generate|export\",\"x\":80,\"y\":120,\"data\":{\"label\":\"\",\"items\":[]}}],\"edges\":[{\"id\":\"e1\",\"from\":\"n1\",\"to\":\"n2\"}]}", body.Prompt)
		if reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{{Role: "user", Content: ask}}, true); err == nil {
			var g map[string]any
			if json.Unmarshal([]byte(extractJSON(reply)), &g) == nil {
				g["source"] = "provider"
				return g, nil
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
