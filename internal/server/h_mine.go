package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/profile"
	"github.com/yang0/handraw-client/internal/prompt"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

func normMineKind(k string) string {
	switch strings.ToLower(strings.TrimSpace(k)) {
	case "style", "styles":
		return "style"
	case "layout", "layouts":
		return "layout"
	case "recipe", "recipes":
		return "recipe"
	case "asset", "assets":
		return "asset"
	}
	return k
}

func (s *Server) mineList(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := normMineKind(r.PathValue("kind"))
	if kind == "" {
		kind = "recipe"
	}
	switch kind {
	case "style", "layout":
		s.importProfileLibraryToDB()
		docs, err := s.DB.ListDocs(kind, false)
		if err != nil {
			return nil, err
		}
		var items []json.RawMessage
		for _, d := range docs {
			var m map[string]any
			if json.Unmarshal(d.Data, &m) == nil {
				m["docId"] = d.ID
				m["remoteId"] = d.RemoteID
				m["remoteRev"] = d.RemoteRev
				m["dirty"] = d.Dirty
				if b, err := json.Marshal(m); err == nil {
					items = append(items, b)
				}
			}
		}
		if items == nil {
			items = []json.RawMessage{}
		}
		return map[string]any{"items": items, "total": len(items)}, nil

	case "recipe":
		var out []profile.Recipe
		seen := map[string]bool{}
		if list, err := profile.ListRecipes(); err == nil {
			for _, rec := range list {
				seen[rec.ID] = true
				out = append(out, rec)
			}
		}
		if docs, err := s.DB.ListDocs("recipe", false); err == nil {
			for _, d := range docs {
				var rec profile.Recipe
				if json.Unmarshal(d.Data, &rec) == nil && rec.ID != "" && !seen[rec.ID] {
					seen[rec.ID] = true
					out = append(out, rec)
				}
			}
		}
		for _, rec := range profile.BuiltinRecipes() {
			if !seen[rec.ID] {
				out = append(out, rec)
			}
		}
		return map[string]any{"items": out, "total": len(out)}, nil

	case "asset":
		docs, err := s.DB.ListDocs("asset", false)
		if err != nil {
			return nil, err
		}
		var out []map[string]any
		seen := map[string]bool{}
		for _, d := range docs {
			var a map[string]any
			if json.Unmarshal(d.Data, &a) == nil {
				id, _ := a["id"].(string)
				if id != "" {
					seen[id] = true
				}
				out = append(out, a)
			}
		}
		for _, tk := range profile.ListTukuAssets() {
			if seen[tk.ID] {
				continue
			}
			out = append(out, map[string]any{
				"id":     tk.ID,
				"kind":   tk.Kind,
				"name":   tk.Name,
				"nameEn": tk.NameEn,
				"image":  tk.FilePath,
				"source": "skill",
			})
		}
		if out == nil {
			out = []map[string]any{}
		}
		return map[string]any{"items": out, "total": len(out)}, nil
	default:
		return nil, bad("未知个人资源类型：" + kind)
	}
}

func (s *Server) importProfileLibraryToDB() {
	lib, _, err := profile.ReadLibrary()
	if err != nil || len(lib) == 0 {
		return
	}
	for _, it := range lib {
		if it.Kind != "style" && it.Kind != "layout" {
			continue
		}
		docID := it.ID
		if _, err := s.DB.GetDoc(it.Kind, docID); err == nil {
			continue
		}
		var payload []byte
		if it.Kind == "style" {
			num := ""
			if raw, ok := it.Extra["local_number"]; ok {
				_ = json.Unmarshal(raw, &num)
			}
			if num == "" {
				num = s.nextCustomCode("style", "MY-S-")
			}
			st := resources.Style{
				Number:         num,
				Group:          "MY 我的画风 / My Styles",
				GroupCode:      "MY",
				GroupZh:        "我的画风",
				GroupEn:        "My Styles",
				GenerationName: it.Name,
				NameZh:         it.Name,
				Traits:         it.PromptZh,
				TraitsEn:       it.PromptEn,
				License:        it.License,
				Source:         "mine",
			}
			if it.Section == "collected" {
				st.Source = "unlocked"
			}
			payload, _ = json.Marshal(st)
		} else {
			id := ""
			if raw, ok := it.Extra["local_number"]; ok {
				_ = json.Unmarshal(raw, &id)
			}
			if id == "" {
				id = s.nextCustomCode("layout", "MY-L-")
			}
			lay := resources.Layout{
				ID:       id,
				Category: "mine",
				Name:     it.Name,
				PromptZh: it.PromptZh,
				PromptEn: it.PromptEn,
				Source:   "mine",
			}
			payload, _ = json.Marshal(lay)
		}
		doc := store.Doc{Kind: it.Kind, ID: docID, Name: it.Name, Data: payload, Dirty: it.Section == "owned"}
		_ = s.DB.PutDoc(&doc)
	}
}

func (s *Server) nextCustomCode(kind, prefix string) string {
	docs, _ := s.DB.ListDocs(kind, true)
	maxN := 0
	for _, d := range docs {
		var m map[string]any
		if json.Unmarshal(d.Data, &m) == nil {
			code, _ := m["number"].(string)
			if code == "" {
				code, _ = m["id"].(string)
			}
			if strings.HasPrefix(code, prefix) {
				var n int
				if _, err := fmt.Sscanf(strings.TrimPrefix(code, prefix), "%d", &n); err == nil && n > maxN {
					maxN = n
				}
			}
		}
	}
	return fmt.Sprintf("%s%03d", prefix, maxN+1)
}

func (s *Server) minePut(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := normMineKind(r.PathValue("kind"))
	switch kind {
	case "style":
		return s.putCustomStyle(r)
	case "layout":
		return s.putCustomLayout(r)
	case "recipe":
		return s.putRecipe(r)
	case "asset":
		return s.putCustomAsset(r)
	default:
		return nil, bad("未知个人资源类型：" + kind)
	}
}

func (s *Server) putCustomStyle(r *http.Request) (any, error) {
	var body struct {
		DocID          string   `json:"docId"`
		Number         string   `json:"number"`
		Name           string   `json:"name"`
		GenerationName string   `json:"generation_name"`
		Reference      string   `json:"reference"`
		Traits         string   `json:"traits"`
		TraitsEn       string   `json:"traitsEn"`
		Image          string   `json:"image"`
		Images         []string `json:"images"`
		License        string   `json:"license"`
		Tags           []string `json:"tags"`
		Strict         bool     `json:"strict"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	name := firstStr(body.Name, body.GenerationName)
	if strings.TrimSpace(name) == "" {
		return nil, bad("画风名称不能为空")
	}
	if strings.TrimSpace(body.Traits) == "" {
		return nil, bad("请填写画风特征描述")
	}
	if strings.TrimSpace(body.TraitsEn) == "" {
		body.TraitsEn = body.Traits
	}
	violations := prompt.CheckTraitViolations(body.Traits + "\n" + body.TraitsEn)
	if body.Strict && len(violations) > 0 {
		return nil, &apiError{Status: 400, Code: "trait_subject_violation", Msg: "画风特征不能包含具体人物、服饰或场景：" + strings.Join(violations, "、")}
	}
	docID := body.DocID
	if docID == "" {
		docID = "mine:" + uuid.NewString()
	}
	num := body.Number
	if num == "" {
		num = s.nextCustomCode("style", "MY-S-")
	}
	if strings.TrimSpace(body.License) == "" {
		body.License = "个人与商业创作输出允许，原包不允许再次分发"
	}
	img := body.Image
	if img == "" && len(body.Images) > 0 {
		img = body.Images[0]
	}
	st := resources.Style{
		Number:         num,
		Group:          "MY 我的画风 / My Styles",
		GroupCode:      "MY",
		GroupZh:        "我的画风",
		GroupEn:        "My Styles",
		Reference:      firstStr(body.Reference, "自建画风"),
		GenerationName: firstStr(body.GenerationName, name),
		NameZh:         name,
		Traits:         strings.TrimSpace(body.Traits),
		TraitsEn:       strings.TrimSpace(body.TraitsEn),
		Image:          img,
		License:        body.License,
		Tags:           body.Tags,
		Source:         "mine",
	}
	b, _ := json.Marshal(st)
	doc := store.Doc{Kind: "style", ID: docID, Name: name, Data: b, Dirty: true}
	if old, err := s.DB.GetDoc("style", docID); err == nil {
		doc.CreatedAt = old.CreatedAt
		doc.RemoteID = old.RemoteID
		doc.RemoteRev = old.RemoteRev
	}
	if err := s.DB.PutDoc(&doc); err != nil {
		return nil, err
	}
	numRaw, _ := json.Marshal(num)
	_ = profile.UpsertLibrary(profile.PersonalResource{
		ID:       docID,
		Kind:     "style",
		Name:     name,
		PromptZh: st.Traits,
		PromptEn: st.TraitsEn,
		License:  st.License,
		Section:  "owned",
		Examples: body.Images,
		Extra:    map[string]json.RawMessage{"local_number": numRaw},
	})
	if settings.Get().AutoSyncResources && s.Site.LoggedIn() {
		go func() { _, _ = s.syncResourcesInternal(context.Background()) }()
	}
	return map[string]any{"style": st, "docId": docID, "violations": violations}, nil
}

func (s *Server) putCustomLayout(r *http.Request) (any, error) {
	var body struct {
		DocID    string   `json:"docId"`
		ID       string   `json:"id"`
		Name     string   `json:"name"`
		NameEn   string   `json:"name_en"`
		PromptZh string   `json:"prompt_zh"`
		PromptEn string   `json:"prompt_en"`
		Image    string   `json:"image"`
		Keywords []string `json:"keywords"`
		License  string   `json:"license"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.PromptZh) == "" {
		return nil, bad("图型名称与布局约束不能为空")
	}
	if strings.TrimSpace(body.PromptEn) == "" {
		body.PromptEn = body.PromptZh
	}
	docID := body.DocID
	if docID == "" {
		docID = "mine:" + uuid.NewString()
	}
	lid := body.ID
	if lid == "" {
		lid = s.nextCustomCode("layout", "MY-L-")
	}
	lic := firstStr(body.License, "个人与商业创作输出允许，原包不允许再次分发")
	lay := resources.Layout{
		ID:       lid,
		Category: "mine",
		Name:     strings.TrimSpace(body.Name),
		NameEn:   firstStr(body.NameEn, body.Name),
		Image:    body.Image,
		Keywords: body.Keywords,
		PromptZh: strings.TrimSpace(body.PromptZh),
		PromptEn: strings.TrimSpace(body.PromptEn),
		Source:   "mine",
	}
	b, _ := json.Marshal(lay)
	doc := store.Doc{Kind: "layout", ID: docID, Name: lay.Name, Data: b, Dirty: true}
	if old, err := s.DB.GetDoc("layout", docID); err == nil {
		doc.CreatedAt = old.CreatedAt
		doc.RemoteID = old.RemoteID
		doc.RemoteRev = old.RemoteRev
	}
	if err := s.DB.PutDoc(&doc); err != nil {
		return nil, err
	}
	numRaw, _ := json.Marshal(lid)
	_ = profile.UpsertLibrary(profile.PersonalResource{
		ID:       docID,
		Kind:     "layout",
		Name:     lay.Name,
		PromptZh: lay.PromptZh,
		PromptEn: lay.PromptEn,
		License:  lic,
		Section:  "owned",
		Extra:    map[string]json.RawMessage{"local_number": numRaw},
	})
	if settings.Get().AutoSyncResources && s.Site.LoggedIn() {
		go func() { _, _ = s.syncResourcesInternal(context.Background()) }()
	}
	return map[string]any{"layout": lay, "docId": docID}, nil
}

func (s *Server) putRecipe(r *http.Request) (any, error) {
	var rec profile.Recipe
	if err := decode(r, &rec); err != nil {
		return nil, err
	}
	if strings.TrimSpace(rec.Name) == "" {
		rec.Name = "未命名配方"
	}
	if rec.ID == "" || strings.HasPrefix(rec.ID, "rcp_builtin_") {
		rec.ID = "rcp_local_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
		rec.Builtin = false
	}
	if err := profile.SaveRecipe(&rec); err != nil {
		return nil, bad(err.Error())
	}
	b, _ := json.Marshal(rec)
	_ = s.DB.PutDoc(&store.Doc{Kind: "recipe", ID: rec.ID, Name: rec.Name, Data: b, Dirty: true})
	return map[string]any{"recipe": rec}, nil
}

func (s *Server) putCustomAsset(r *http.Request) (any, error) {
	var body struct {
		ID      string   `json:"id"`
		Kind    string   `json:"kind"` // character | prop | scene
		Name    string   `json:"name"`
		NameEn  string   `json:"name_en"`
		Image   string   `json:"image"`
		DataURL string   `json:"dataUrl"`
		Tags    []string `json:"tags"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Name) == "" {
		return nil, bad("资产名称不能为空")
	}
	if body.Kind == "" {
		body.Kind = "character"
	}
	if body.DataURL != "" {
		saved, err := saveUploadedDataURL(body.DataURL, body.Name)
		if err != nil {
			return nil, err
		}
		body.Image = saved.Path
	}
	if body.ID == "" {
		prefix := map[string]string{"character": "MY-CH-", "prop": "MY-PR-", "scene": "MY-SCN-"}[body.Kind]
		if prefix == "" {
			prefix = "MY-AS-"
		}
		body.ID = s.nextCustomCode("asset", prefix)
	}
	asset := resources.Asset{
		ID:     body.ID,
		Kind:   body.Kind,
		Name:   strings.TrimSpace(body.Name),
		NameEn: firstStr(body.NameEn, body.Name),
		Image:  body.Image,
		Tags:   body.Tags,
	}
	b, _ := json.Marshal(asset)
	if err := s.DB.PutDoc(&store.Doc{Kind: "asset", ID: asset.ID, Name: asset.Name, Data: b, Dirty: true}); err != nil {
		return nil, err
	}
	return map[string]any{"asset": asset}, nil
}

func (s *Server) mineDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := normMineKind(r.PathValue("kind"))
	id := r.PathValue("id")
	if kind == "recipe" {
		_ = profile.DeleteRecipe(id)
		_ = s.DB.DeleteDocHard("recipe", id)
		return okv, nil
	}
	if doc, err := s.DB.GetDoc(kind, id); err == nil {
		if doc.RemoteID != "" {
			doc.Deleted = true
			doc.Dirty = true
			_ = s.DB.PutDoc(&doc)
		} else {
			_ = s.DB.DeleteDocHard(kind, id)
		}
	}
	if kind == "style" || kind == "layout" {
		_ = profile.DeleteLibrary(id)
	}
	return okv, nil
}

func (s *Server) mineSync(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	var body struct {
		Resolution string `json:"resolution"` // "" | "keep_local" | "use_remote"
		ID         string `json:"id"`
	}
	_ = decode(r, &body)
	return s.syncResourcesInternal(r.Context())
}

func (s *Server) syncResourcesInternal(ctx context.Context) (map[string]any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	me, err := s.Site.Me(ctx)
	if err != nil {
		return nil, err
	}
	username, _ := me["username"].(string)
	syncState := profile.ReadSyncState(username)
	pushed, pulled := 0, 0
	var conflicts []map[string]any

	for _, kind := range []string{"style", "layout"} {
		docs, _ := s.DB.ListDocs(kind, true)
		for _, d := range docs {
			if !d.Dirty {
				continue
			}
			uid := strings.TrimPrefix(d.ID, "mine:")
			if _, err := uuid.Parse(uid); err != nil {
				continue
			}
			if d.Deleted {
				if d.RemoteID != "" {
					_, err := s.Site.Send(ctx, "DELETE", fmt.Sprintf("/api/v1/me/resources/%s?baseRevision=%d", uid, d.RemoteRev), nil)
					if err == nil || strings.Contains(err.Error(), "404") {
						_ = s.DB.DeleteDocHard(kind, d.ID)
						delete(syncState.Resources, d.ID)
					}
				} else {
					_ = s.DB.DeleteDocHard(kind, d.ID)
				}
				continue
			}
			var zh, en, lic string
			var examples []string
			if kind == "style" {
				var st resources.Style
				_ = json.Unmarshal(d.Data, &st)
				zh, en, lic = st.Traits, firstStr(st.TraitsEn, st.Traits), firstStr(st.License, "private")
			} else {
				var lay resources.Layout
				_ = json.Unmarshal(d.Data, &lay)
				zh, en, lic = lay.PromptZh, firstStr(lay.PromptEn, lay.PromptZh), "private"
			}
			payload := map[string]any{
				"id":            uid,
				"kind":          kind,
				"name":          d.Name,
				"definition":    map[string]string{"zh": zh, "en": en},
				"license":       lic,
				"examples":      examples,
				"version":       "1.0.0",
				"visibility":    "private",
				"schemaVersion": 1,
			}
			if d.RemoteRev > 0 {
				payload["baseRevision"] = d.RemoteRev
			}
			raw, err := s.Site.Send(ctx, "PUT", "/api/v1/me/resources/"+uid, payload)
			if err != nil {
				var ae *site.APIError
				if errors.As(err, &ae) && ae.Status == 409 {
					conflicts = append(conflicts, map[string]any{"id": d.ID, "kind": kind, "name": d.Name, "error": err.Error()})
					continue
				}
				continue
			}
			var res struct {
				Resource struct {
					ID       string `json:"id"`
					Revision int    `json:"revision"`
				} `json:"resource"`
			}
			if json.Unmarshal(raw, &res) == nil {
				d.RemoteID = firstStr(res.Resource.ID, uid)
				d.RemoteRev = res.Resource.Revision
				d.Dirty = false
				_ = s.DB.PutDoc(&d)
				prefix := "USR-S"
				if kind == "layout" {
					prefix = "USR-L"
				}
				syncState.Resources[d.ID] = profile.SyncResource{
					UID:      uid,
					Code:     prefix + strings.ToUpper(strings.ReplaceAll(uid, "-", "")),
					Revision: d.RemoteRev,
				}
				pushed++
			}
		}
	}

	since, _ := syncState.Cursors["resources"].(string)
	if since == "" {
		since = "0"
	}
	raw, err := s.Site.Get(ctx, "/api/v1/me/resources?limit=100&since="+url.QueryEscape(since))
	if err == nil {
		var page struct {
			Items []struct {
				ID         string            `json:"id"`
				Kind       string            `json:"kind"`
				Name       string            `json:"name"`
				Definition map[string]string `json:"definition"`
				License    string            `json:"license"`
				Version    string            `json:"version"`
				Revision   int               `json:"revision"`
				DeletedAt  string            `json:"deletedAt"`
			} `json:"items"`
			NextCursor string `json:"nextCursor"`
		}
		if json.Unmarshal(raw, &page) == nil {
			for _, it := range page.Items {
				docID := "mine:" + it.ID
				if it.DeletedAt != "" {
					_ = s.DB.DeleteDocHard(it.Kind, docID)
					_ = profile.DeleteLibrary(docID)
					continue
				}
				if old, err := s.DB.GetDoc(it.Kind, docID); err == nil && old.Dirty && old.RemoteRev != it.Revision {
					conflicts = append(conflicts, map[string]any{"id": docID, "kind": it.Kind, "name": it.Name, "remoteRev": it.Revision})
					continue
				}
				var data []byte
				if it.Kind == "style" {
					num := s.nextCustomCode("style", "MY-S-")
					st := resources.Style{
						Number: num, Group: "MY 我的画风 / My Styles", GroupCode: "MY", GroupZh: "我的画风", GroupEn: "My Styles",
						GenerationName: it.Name, NameZh: it.Name, Traits: it.Definition["zh"], TraitsEn: it.Definition["en"],
						License: it.License, Source: "mine",
					}
					data, _ = json.Marshal(st)
				} else {
					lid := s.nextCustomCode("layout", "MY-L-")
					lay := resources.Layout{
						ID: lid, Category: "mine", Name: it.Name, PromptZh: it.Definition["zh"], PromptEn: it.Definition["en"], Source: "mine",
					}
					data, _ = json.Marshal(lay)
				}
				_ = s.DB.PutDoc(&store.Doc{Kind: it.Kind, ID: docID, Name: it.Name, Data: data, RemoteID: it.ID, RemoteRev: it.Revision, Dirty: false})
				_ = profile.UpsertLibrary(profile.PersonalResource{
					ID: docID, Kind: it.Kind, Name: it.Name, PromptZh: it.Definition["zh"], PromptEn: it.Definition["en"],
					License: firstStr(it.License, "private"), Version: firstStr(it.Version, "1.0.0"), Section: "owned",
				})
				pulled++
			}
			if page.NextCursor != "" {
				syncState.Cursors["resources"] = page.NextCursor
			}
		}
	}
	_ = profile.WriteSyncState(username, syncState)
	return map[string]any{"ok": true, "pushed": pushed, "pulled": pulled, "conflicts": conflicts}, nil
}

func (s *Server) mineAnalyze(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Images   []string `json:"images"`
		Purpose  string   `json:"purpose"` // find | create
		ModelRef string   `json:"modelRef"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.Images) == 0 {
		return nil, bad("请先选择或拖入参考图")
	}
	route, err := resolveAIRoute("vision", body.ModelRef)
	if err != nil {
		return nil, err
	}
	dataURLs := make([]string, 0, len(body.Images))
	for _, img := range body.Images {
		if strings.HasPrefix(img, "data:image/") {
			dataURLs = append(dataURLs, img)
			continue
		}
		path := normalizeLocalRef(img)
		if path == "" {
			path = img
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("无法读取图片 %s：%w", filepath.Base(path), err)
		}
		mime := "image/png"
		switch strings.ToLower(filepath.Ext(path)) {
		case ".jpg", ".jpeg":
			mime = "image/jpeg"
		case ".webp":
			mime = "image/webp"
		}
		dataURLs = append(dataURLs, "data:"+mime+";base64,"+base64.StdEncoding.EncodeToString(b))
	}

	p, err := s.pack()
	if err != nil {
		return nil, err
	}
	purpose := firstStr(body.Purpose, "find")

	analyzeWithSite := func(siteModel string) (map[string]any, error) {
		raw, err := s.Site.AnalyzeStyle(r.Context(), dataURLs, purpose, siteModel)
		if err != nil {
			return nil, err
		}
		var parsed struct {
			Name     string   `json:"name"`
			TraitsZh string   `json:"traitsZh"`
			TraitsEn string   `json:"traitsEn"`
			Matches  []string `json:"matches"`
		}
		_ = json.Unmarshal(raw, &parsed)
		var matched []resources.Style
		for _, id := range parsed.Matches {
			if st, ok := p.Style(id); ok {
				matched = append(matched, st)
			}
		}
		if len(matched) == 0 && parsed.TraitsZh+parsed.TraitsEn != "" {
			matched = p.SearchStyles(parsed.TraitsZh+" "+parsed.TraitsEn, 5)
		}
		return map[string]any{
			"source":     "site",
			"model":      siteModel,
			"name":       parsed.Name,
			"traitsZh":   parsed.TraitsZh,
			"traitsEn":   parsed.TraitsEn,
			"matches":    matched,
			"violations": prompt.CheckTraitViolations(parsed.TraitsZh + " " + parsed.TraitsEn),
		}, nil
	}

	analyzeWithProvider := func(tp settings.Provider, model string) (map[string]any, error) {
		parts := []any{map[string]any{
			"type": "text",
			"text": "请仅提取以下参考图的纯粹视觉艺术语言（媒介、线条、材质、色彩倾向、光影质感、空间构图机制）。严禁描述任何具体人物、性别、发型、服饰、动物、道具、建筑或场景故事。返回严格 JSON: {\"name\":\"\",\"traitsZh\":\"\",\"traitsEn\":\"\"}",
		}}
		for _, du := range dataURLs {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": du}})
		}
		reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{{Role: "user", Content: parts}}, true)
		if err != nil {
			return nil, err
		}
		var out struct {
			Name     string `json:"name"`
			TraitsZh string `json:"traitsZh"`
			TraitsEn string `json:"traitsEn"`
		}
		if json.Unmarshal([]byte(extractJSON(reply)), &out) != nil || (out.TraitsZh == "" && out.TraitsEn == "") {
			return nil, bad("视觉解析模型返回格式无法解析，请确认所选模型支持视觉识图（Vision）")
		}
		matched := p.SearchStyles(out.TraitsZh+" "+out.TraitsEn, 5)
		return map[string]any{
			"source":     "provider",
			"model":      tp.Name + ":" + model,
			"name":       out.Name,
			"traitsZh":   out.TraitsZh,
			"traitsEn":   out.TraitsEn,
			"matches":    matched,
			"violations": prompt.CheckTraitViolations(out.TraitsZh + " " + out.TraitsEn),
		}, nil
	}

	switch route.Mode {
	case "provider":
		return analyzeWithProvider(route.Provider, route.Model)
	case "site_explicit":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		res, err := analyzeWithSite(route.SiteModel)
		if err != nil {
			return nil, analyzeSiteError(err)
		}
		return res, nil
	default:
		var siteErr error
		if s.Site.LoggedIn() {
			res, err := analyzeWithSite("")
			if err == nil {
				return res, nil
			}
			siteErr = err
		}
		if tp, model, ok := findTextProviderFor("vision"); ok {
			res, err := analyzeWithProvider(tp, model)
			if err == nil {
				return res, nil
			}
			if siteErr == nil {
				return nil, err
			}
		}
		if siteErr != nil {
			return nil, analyzeSiteError(siteErr)
		}
		return nil, &apiError{
			Status: 503,
			Code:   "analyze_unavailable",
			Msg:    "请先登录手绘风账号（使用网站线上视觉接口），或在「设置 → 模型与接口配置」添加支持视觉识图的第三方中转站",
		}
	}
}

func analyzeSiteError(err error) error {
	var ae *site.APIError
	if errors.As(err, &ae) && (ae.Status == 404 || ae.Code == "token_scope_denied") {
		return &apiError{
			Status: 503,
			Code:   "analyze_unavailable",
			Msg:    "网站线上视觉分析接口暂未对桌面端开放，请在「设置 → 模型与接口配置」添加或切换支持视觉识图的第三方中转站",
		}
	}
	return err
}

type uploadedFile struct {
	Path   string `json:"path"`
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	SHA256 string `json:"sha256"`
}

func saveUploadedDataURL(dataURL, name string) (uploadedFile, error) {
	raw, err := decodeDataURL(dataURL)
	if err != nil {
		return uploadedFile{}, err
	}
	return saveUploadedBytes(raw, name)
}

func saveUploadedBytes(raw []byte, origName string) (uploadedFile, error) {
	if len(raw) == 0 {
		return uploadedFile{}, bad("图片内容为空")
	}
	ext := sniffImageExt(raw)
	sum := sha256.Sum256(raw)
	hashHex := hex.EncodeToString(sum[:])
	dir := filepath.Join(appdir.Library(), "uploads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return uploadedFile{}, err
	}
	fn := hashHex[:16] + ext
	dst := filepath.Join(dir, fn)
	if err := os.WriteFile(dst, raw, 0o644); err != nil {
		return uploadedFile{}, err
	}
	w, h, _, _ := inspectBytes(raw)
	_ = origName
	return uploadedFile{
		Path:   dst,
		URL:    "/files/local?p=" + url.QueryEscape(dst),
		Width:  w,
		Height: h,
		SHA256: hashHex,
	}, nil
}

func (s *Server) uploadImage(w http.ResponseWriter, r *http.Request) (any, error) {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(40 << 20); err != nil {
			return nil, bad("解析上传文件失败：" + err.Error())
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			return nil, bad("缺少文件字段 file")
		}
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, 40<<20))
		if err != nil {
			return nil, err
		}
		return saveUploadedBytes(b, hdr.Filename)
	}
	var body struct {
		Name    string `json:"name"`
		DataURL string `json:"dataUrl"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.DataURL == "" {
		return nil, bad("缺少 dataUrl")
	}
	return saveUploadedDataURL(body.DataURL, body.Name)
}

func decodeDataURL(s string) ([]byte, error) {
	if !strings.HasPrefix(s, "data:") {
		return nil, errors.New("不是有效的 data URL")
	}
	_, b64, ok := strings.Cut(s, ",")
	if !ok {
		return nil, errors.New("data URL 缺少编码内容")
	}
	return base64.StdEncoding.DecodeString(b64)
}

func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	objIdx := strings.Index(s, "{")
	arrIdx := strings.Index(s, "[")
	if arrIdx >= 0 && (objIdx < 0 || arrIdx < objIdx) {
		if end := strings.LastIndex(s, "]"); end > arrIdx {
			return s[arrIdx : end+1]
		}
	}
	if objIdx >= 0 {
		if end := strings.LastIndex(s, "}"); end > objIdx {
			return s[objIdx : end+1]
		}
	}
	return s
}
