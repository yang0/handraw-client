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
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/harnesses"
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
				if pub := s.publishedState(d.ID); pub != nil {
					m["published"] = pub
				}
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
		out := []profile.Recipe{}
		seen := map[string]bool{}
		docMeta := map[string]store.Doc{}
		if docs, err := s.DB.ListDocs("recipe", true); err == nil {
			for _, d := range docs {
				docMeta[d.ID] = d
			}
		}
		enrichSync := func(rec *profile.Recipe) {
			rec.Builtin = false
			if d, ok := docMeta[rec.ID]; ok {
				if d.RemoteID != "" {
					rec.Remote = &profile.RecipeRemote{ID: d.RemoteID, Revision: d.RemoteRev}
					if d.Dirty {
						rec.SyncStatus = "pending"
					} else {
						rec.SyncStatus = "synced"
					}
				} else if d.Dirty {
					rec.SyncStatus = "pending"
				} else {
					rec.SyncStatus = "local"
				}
			} else if rec.Remote != nil && rec.Remote.ID != "" {
				rec.SyncStatus = "synced"
			} else {
				rec.SyncStatus = "local"
			}
		}
		if list, err := profile.ListRecipes(); err == nil {
			for _, rec := range list {
				if rec.Builtin || strings.HasPrefix(rec.ID, "rcp_builtin_") {
					continue
				}
				if d, ok := docMeta[rec.ID]; ok && d.Deleted {
					continue
				}
				enrichSync(&rec)
				seen[rec.ID] = true
				out = append(out, rec)
			}
		}
		if docs, err := s.DB.ListDocs("recipe", false); err == nil {
			for _, d := range docs {
				var rec profile.Recipe
				if json.Unmarshal(d.Data, &rec) == nil && rec.ID != "" && !rec.Builtin && !strings.HasPrefix(rec.ID, "rcp_builtin_") && !seen[rec.ID] {
					enrichSync(&rec)
					seen[rec.ID] = true
					out = append(out, rec)
				}
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
				if _, ok := a["source"]; !ok {
					a["source"] = "local"
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

func cleanLocalImageList(cover string, list []string) (string, []string) {
	seen := map[string]bool{}
	out := make([]string, 0, len(list)+1)
	add := func(raw string) {
		p := strings.TrimSpace(raw)
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	add(cover)
	for _, item := range list {
		add(item)
		if len(out) >= 5 {
			break
		}
	}
	if len(out) == 0 {
		return "", nil
	}
	return out[0], out
}

func (s *Server) putCustomStyle(r *http.Request) (any, error) {
	var body struct {
		DocID          string   `json:"docId"`
		Number         string   `json:"number"`
		Name           string   `json:"name"`
		GenerationName string   `json:"generation_name"`
		Reference      string   `json:"reference"`
		Description    string   `json:"description"`
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
	name := strings.TrimSpace(firstStr(body.Name, body.GenerationName))
	if name == "" {
		return nil, bad("画风名称不能为空")
	}
	traits := strings.TrimSpace(firstStr(body.Description, body.Traits, body.TraitsEn))
	if traits == "" {
		return nil, bad("请填写画风视觉特征描述")
	}
	traitsEn := strings.TrimSpace(firstStr(body.TraitsEn, traits))
	violations := prompt.CheckTraitViolations(traits)
	if body.Strict && len(violations) > 0 {
		return nil, &apiError{Status: 400, Code: "trait_subject_violation", Msg: "画风特征不能包含具体人物、服饰或场景：" + strings.Join(violations, "、")}
	}
	docID := strings.TrimSpace(body.DocID)
	if docID == "" {
		docID = "mine:" + uuid.NewString()
	}
	var oldStyle resources.Style
	var oldDoc store.Doc
	hasOld := false
	if existing, err := s.DB.GetDoc("style", docID); err == nil {
		oldDoc = existing
		hasOld = true
		_ = json.Unmarshal(existing.Data, &oldStyle)
	}
	num := strings.TrimSpace(firstStr(body.Number, oldStyle.Number))
	if num == "" {
		num = s.nextCustomCode("style", "MY-S-")
	}
	if strings.TrimSpace(body.License) == "" {
		body.License = firstStr(oldStyle.License, "个人与商业创作输出允许，原包不允许再次分发")
	}
	cover, imgList := cleanLocalImageList(body.Image, body.Images)
	remoteImgURL := ""
	if cover != "" && cover == oldStyle.Image {
		remoteImgURL = oldStyle.RemoteImageURL
	}
	st := resources.Style{
		Number:         num,
		Group:          "MY 我的画风 / My Styles",
		GroupCode:      "MY",
		GroupZh:        "我的画风",
		GroupEn:        "My Styles",
		Reference:      firstStr(body.Reference, oldStyle.Reference, "自建画风"),
		GenerationName: firstStr(body.GenerationName, name),
		NameZh:         name,
		Traits:         traits,
		TraitsEn:       traitsEn,
		Image:          cover,
		Images:         imgList,
		RemoteImageURL: remoteImgURL,
		License:        body.License,
		Tags:           body.Tags,
		Source:         "mine",
	}
	b, _ := json.Marshal(st)
	doc := store.Doc{Kind: "style", ID: docID, Name: name, Data: b, Dirty: true}
	if hasOld {
		doc.CreatedAt = oldDoc.CreatedAt
		doc.RemoteID = oldDoc.RemoteID
		doc.RemoteRev = oldDoc.RemoteRev
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
		Examples: imgList,
		Extra:    map[string]json.RawMessage{"local_number": numRaw},
	})
	if settings.Get().AutoSyncResources && s.Site.LoggedIn() {
		go func() { _, _ = s.syncResourcesInternal(context.Background()) }()
	}
	return map[string]any{"style": st, "docId": docID, "violations": violations}, nil
}

func (s *Server) putCustomLayout(r *http.Request) (any, error) {
	var body struct {
		DocID       string   `json:"docId"`
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		NameEn      string   `json:"name_en"`
		Description string   `json:"description"`
		PromptZh    string   `json:"prompt_zh"`
		PromptEn    string   `json:"prompt_en"`
		Image       string   `json:"image"`
		Images      []string `json:"images"`
		Keywords    []string `json:"keywords"`
		License     string   `json:"license"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(body.Name)
	desc := strings.TrimSpace(firstStr(body.Description, body.PromptZh, body.PromptEn))
	if name == "" || desc == "" {
		return nil, bad("图型名称与排版约束不能为空")
	}
	promptEn := strings.TrimSpace(firstStr(body.PromptEn, desc))
	docID := strings.TrimSpace(body.DocID)
	if docID == "" {
		docID = "mine:" + uuid.NewString()
	}
	var oldLay resources.Layout
	var oldDoc store.Doc
	hasOld := false
	if existing, err := s.DB.GetDoc("layout", docID); err == nil {
		oldDoc = existing
		hasOld = true
		_ = json.Unmarshal(existing.Data, &oldLay)
	}
	lid := strings.TrimSpace(firstStr(body.ID, oldLay.ID))
	if lid == "" {
		lid = s.nextCustomCode("layout", "MY-L-")
	}
	lic := firstStr(body.License, oldLay.License, "个人与商业创作输出允许，原包不允许再次分发")
	cover, imgList := cleanLocalImageList(body.Image, body.Images)
	remoteImgURL := ""
	if cover != "" && cover == oldLay.Image {
		remoteImgURL = oldLay.RemoteImageURL
	}
	lay := resources.Layout{
		ID:             lid,
		Category:       "mine",
		Name:           name,
		NameEn:         firstStr(body.NameEn, name),
		Image:          cover,
		Images:         imgList,
		RemoteImageURL: remoteImgURL,
		Keywords:       body.Keywords,
		PromptZh:       desc,
		PromptEn:       promptEn,
		License:        lic,
		Source:         "mine",
	}
	b, _ := json.Marshal(lay)
	doc := store.Doc{Kind: "layout", ID: docID, Name: lay.Name, Data: b, Dirty: true}
	if hasOld {
		doc.CreatedAt = oldDoc.CreatedAt
		doc.RemoteID = oldDoc.RemoteID
		doc.RemoteRev = oldDoc.RemoteRev
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
		Examples: imgList,
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
	rec.Name = strings.TrimSpace(rec.Name)
	if rec.Name == "" {
		return nil, bad("请填写配方名称")
	}
	if len([]rune(rec.Name)) > 60 {
		return nil, bad("配方名称不能超过 60 个字符")
	}
	rec.Builtin = false
	rec.References = []string{} // never store/sync local reference image paths
	oldID := strings.TrimSpace(rec.ID)
	if oldID == "" || strings.HasPrefix(oldID, "rcp_builtin_") {
		rec.ID = uuid.NewString()
	} else if _, err := uuid.Parse(oldID); err != nil {
		// Upgrade legacy non-UUID recipe ID (e.g. rcp_local_xxx) to UUID for cloud sync.
		rec.ID = uuid.NewString()
		_ = profile.DeleteRecipe(oldID)
		_ = s.DB.DeleteDocHard("recipe", oldID)
	}
	var remoteID string
	var remoteRev int
	if existing, err := s.DB.GetDoc("recipe", rec.ID); err == nil {
		remoteID = existing.RemoteID
		remoteRev = existing.RemoteRev
	}
	if remoteID != "" {
		rec.Remote = &profile.RecipeRemote{ID: remoteID, Revision: remoteRev}
	}
	rec.SyncStatus = "pending"
	if err := profile.SaveRecipe(&rec); err != nil {
		return nil, bad(err.Error())
	}
	b, _ := json.Marshal(rec)
	_ = s.DB.PutDoc(&store.Doc{
		Kind:      "recipe",
		ID:        rec.ID,
		Name:      rec.Name,
		Data:      b,
		RemoteID:  remoteID,
		RemoteRev: remoteRev,
		Dirty:     true,
		Deleted:   false,
	})
	if s.Site.LoggedIn() && settings.Get().AutoSyncResources {
		go func() { _, _ = s.syncRecipesInternal(context.Background()) }()
	}
	return map[string]any{"recipe": rec}, nil
}

type AssetCategory struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Builtin bool   `json:"builtin"`
}

var builtinAssetCategories = []AssetCategory{
	{Key: "character", Label: "角色", Builtin: true},
	{Key: "prop", Label: "道具", Builtin: true},
	{Key: "scene", Label: "场景", Builtin: true},
	{Key: "other", Label: "其他", Builtin: true},
}

func isBuiltinAssetCategory(key string) bool {
	for _, c := range builtinAssetCategories {
		if c.Key == key {
			return true
		}
	}
	return false
}

func (s *Server) listAssetCategories() ([]AssetCategory, []AssetCategory) {
	all := make([]AssetCategory, 0, len(builtinAssetCategories)+8)
	all = append(all, builtinAssetCategories...)
	custom := []AssetCategory{}
	docs, err := s.DB.ListDocs("asset_category", false)
	if err == nil {
		sort.Slice(docs, func(i, j int) bool {
			if docs[i].UpdatedAt == docs[j].UpdatedAt {
				return docs[i].ID < docs[j].ID
			}
			return docs[i].UpdatedAt < docs[j].UpdatedAt
		})
		seen := map[string]bool{}
		for _, c := range builtinAssetCategories {
			seen[c.Key] = true
		}
		for _, d := range docs {
			var cat AssetCategory
			if json.Unmarshal(d.Data, &cat) != nil {
				cat = AssetCategory{Key: d.ID, Label: d.Name}
			}
			cat.Key = strings.TrimSpace(firstStr(cat.Key, d.ID))
			cat.Label = strings.TrimSpace(firstStr(cat.Label, d.Name))
			cat.Builtin = false
			if cat.Key == "" || cat.Label == "" || seen[cat.Key] {
				continue
			}
			seen[cat.Key] = true
			custom = append(custom, cat)
			all = append(all, cat)
		}
	}
	return all, custom
}

func (s *Server) mineAssetCategoriesList(w http.ResponseWriter, r *http.Request) (any, error) {
	all, custom := s.listAssetCategories()
	return map[string]any{"items": all, "custom": custom}, nil
}

func (s *Server) mineAssetCategorySave(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Key   string `json:"key"`
		Label string `json:"label"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		return nil, bad("分类名称不能为空")
	}
	if len([]rune(label)) > 24 {
		return nil, bad("分类名称最多 24 个字符")
	}
	key := strings.TrimSpace(body.Key)
	if key != "" && isBuiltinAssetCategory(key) {
		return nil, bad("内置分类不可修改")
	}
	all, _ := s.listAssetCategories()
	for _, c := range all {
		if c.Key != key && strings.EqualFold(strings.TrimSpace(c.Label), label) {
			return nil, bad("已存在同名分类：" + label)
		}
	}
	if key == "" {
		key = "cat_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	} else {
		// Sanitize custom key so it is safe in URL paths and JSON.
		var clean strings.Builder
		for _, ch := range key {
			if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
				clean.WriteRune(ch)
			}
		}
		key = clean.String()
		if key == "" || isBuiltinAssetCategory(key) {
			key = "cat_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
		}
	}
	cat := AssetCategory{Key: key, Label: label, Builtin: false}
	b, _ := json.Marshal(cat)
	if err := s.DB.PutDoc(&store.Doc{Kind: "asset_category", ID: key, Name: label, Data: b, Dirty: true}); err != nil {
		return nil, err
	}
	updatedAll, custom := s.listAssetCategories()
	return map[string]any{"category": cat, "items": updatedAll, "custom": custom}, nil
}

func (s *Server) mineAssetCategoryDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	key := strings.TrimSpace(r.PathValue("key"))
	if key == "" {
		return nil, bad("缺少分类标识")
	}
	if isBuiltinAssetCategory(key) {
		return nil, bad("内置分类不可删除")
	}
	_ = s.DB.DeleteDocHard("asset_category", key)

	migrated := 0
	docs, _ := s.DB.ListDocs("asset", false)
	for _, d := range docs {
		var a resources.Asset
		if json.Unmarshal(d.Data, &a) != nil {
			continue
		}
		if a.Kind == key {
			a.Kind = "other"
			b, _ := json.Marshal(a)
			d.Data = b
			d.Dirty = true
			if s.DB.PutDoc(&d) == nil {
				migrated++
			}
		}
	}
	all, custom := s.listAssetCategories()
	return map[string]any{"ok": true, "migrated": migrated, "items": all, "custom": custom}, nil
}

func (s *Server) putCustomAsset(r *http.Request) (any, error) {
	var body struct {
		ID      string   `json:"id"`
		Kind    string   `json:"kind"` // character | prop | scene | other | cat_*
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
	body.Kind = strings.TrimSpace(body.Kind)
	if body.Kind == "" {
		body.Kind = "other"
	}
	if body.DataURL != "" {
		saved, err := saveUploadedDataURL(body.DataURL, body.Name)
		if err != nil {
			return nil, err
		}
		body.Image = saved.Path
	}
	if body.ID != "" && body.Image == "" {
		if existingDoc, err := s.DB.GetDoc("asset", body.ID); err == nil {
			var prev resources.Asset
			if json.Unmarshal(existingDoc.Data, &prev) == nil {
				body.Image = prev.Image
				if body.Tags == nil {
					body.Tags = prev.Tags
				}
			}
		}
	}
	if strings.TrimSpace(body.Image) == "" {
		return nil, bad("请先选择或粘贴参考图片")
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
		if doc, err := s.DB.GetDoc("recipe", id); err == nil && doc.RemoteID != "" {
			doc.Deleted = true
			doc.Dirty = true
			_ = s.DB.PutDoc(&doc)
			if s.Site.LoggedIn() && settings.Get().AutoSyncResources {
				go func() { _, _ = s.syncRecipesInternal(context.Background()) }()
			}
		} else {
			_ = s.DB.DeleteDocHard("recipe", id)
		}
		return okv, nil
	}
	needSync := false
	if doc, err := s.DB.GetDoc(kind, id); err == nil {
		if doc.RemoteID != "" {
			doc.Deleted = true
			doc.Dirty = true
			_ = s.DB.PutDoc(&doc)
			needSync = true
		} else {
			_ = s.DB.DeleteDocHard(kind, id)
		}
	}
	if kind == "style" || kind == "layout" {
		_ = profile.DeleteLibrary(id)
		if needSync && settings.Get().AutoSyncResources && s.Site.LoggedIn() {
			go func() { _, _ = s.syncResourcesInternal(context.Background()) }()
		}
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

func isRemoteResourceImageURL(s string) bool {
	u := strings.TrimSpace(s)
	return strings.HasPrefix(u, "/api/library/assets/") ||
		strings.HasPrefix(u, "/uploads/") ||
		strings.HasPrefix(u, "/generated/") ||
		strings.HasPrefix(u, "/images/")
}

func firstRemoteCoverURL(examples []string) string {
	for _, ex := range examples {
		if isRemoteResourceImageURL(ex) {
			return strings.TrimSpace(ex)
		}
	}
	return ""
}

func (s *Server) uploadPrivateResourceCover(ctx context.Context, localPath, label string) string {
	path := normalizeLocalRef(localPath)
	if path == "" {
		path = strings.TrimSpace(localPath)
	}
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 || len(raw) > 10<<20 {
		return ""
	}
	mime := "image/png"
	switch strings.ToLower(sniffImageExt(raw)) {
	case ".jpg", ".jpeg":
		mime = "image/jpeg"
	case ".webp":
		mime = "image/webp"
	}
	assetUID := uuid.NewString()
	cleanName := strings.TrimSpace(label)
	if cleanName == "" {
		cleanName = "自定义封面"
	}
	if rs := []rune(cleanName); len(rs) > 72 {
		cleanName = string(rs[:72])
	}
	respRaw, err := s.Site.Send(ctx, "PUT", "/api/library/assets/"+assetUID, map[string]any{
		"uid":     assetUID,
		"cat":     "other",
		"name":    cleanName,
		"dataUrl": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw),
		"origin":  "skill",
	})
	if err != nil {
		return ""
	}
	var parsed struct {
		ImageURL string `json:"imageUrl"`
		Item     struct {
			ImageURL string `json:"imageUrl"`
		} `json:"item"`
	}
	_ = json.Unmarshal(respRaw, &parsed)
	return firstStr(parsed.Item.ImageURL, parsed.ImageURL, "/api/library/assets/"+assetUID+"/image")
}

func (s *Server) downloadPrivateResourceCover(ctx context.Context, remoteURL string) string {
	if !isRemoteResourceImageURL(remoteURL) {
		return ""
	}
	raw, err := s.Site.Get(ctx, remoteURL)
	if err != nil || len(raw) == 0 || len(raw) > 15<<20 {
		return ""
	}
	up, err := saveUploadedBytes(raw, filepath.Base(remoteURL))
	if err != nil {
		return ""
	}
	return up.Path
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
			var zh, en, lic, localCover, remoteCover string
			examples := []string{} // never null: the site rejects a null list
			var st resources.Style
			var lay resources.Layout
			if kind == "style" {
				_ = json.Unmarshal(d.Data, &st)
				zh, en, lic = st.Traits, firstStr(st.TraitsEn, st.Traits), firstStr(st.License, "个人使用")
				localCover, remoteCover = st.Image, st.RemoteImageURL
			} else {
				_ = json.Unmarshal(d.Data, &lay)
				zh, en, lic = lay.PromptZh, firstStr(lay.PromptEn, lay.PromptZh), firstStr(lay.License, "个人使用")
				localCover, remoteCover = lay.Image, lay.RemoteImageURL
			}
			if localCover != "" && remoteCover == "" {
				if uploadedURL := s.uploadPrivateResourceCover(ctx, localCover, d.Name); uploadedURL != "" {
					remoteCover = uploadedURL
					if kind == "style" {
						st.RemoteImageURL = remoteCover
						if nb, mErr := json.Marshal(st); mErr == nil {
							d.Data = nb
						}
					} else {
						lay.RemoteImageURL = remoteCover
						if nb, mErr := json.Marshal(lay); mErr == nil {
							d.Data = nb
						}
					}
				}
			}
			if remoteCover != "" {
				examples = append(examples, remoteCover)
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
	for pageIdx := 0; pageIdx < 10; pageIdx++ {
		raw, err := s.Site.Get(ctx, "/api/v1/me/resources?limit=100&since="+url.QueryEscape(since))
		if err != nil {
			break
		}
		var page struct {
			Items []struct {
				ID         string            `json:"id"`
				Kind       string            `json:"kind"`
				Name       string            `json:"name"`
				Definition map[string]string `json:"definition"`
				License    string            `json:"license"`
				Examples   []string          `json:"examples"`
				Version    string            `json:"version"`
				Revision   int               `json:"revision"`
				DeletedAt  string            `json:"deletedAt"`
				Published  json.RawMessage   `json:"published"`
			} `json:"items"`
			HasMore    bool   `json:"hasMore"`
			NextCursor string `json:"nextCursor"`
		}
		if json.Unmarshal(raw, &page) != nil {
			break
		}
		for _, it := range page.Items {
			docID := "mine:" + it.ID
			if it.DeletedAt != "" {
				_ = s.DB.DeleteDocHard(it.Kind, docID)
				_ = profile.DeleteLibrary(docID)
				continue
			}
			oldDoc, oldErr := s.DB.GetDoc(it.Kind, docID)
			if oldErr == nil && oldDoc.Dirty && oldDoc.RemoteRev != it.Revision {
				conflicts = append(conflicts, map[string]any{"id": docID, "kind": it.Kind, "name": it.Name, "remoteRev": it.Revision})
				continue
			}
			zh := strings.TrimSpace(firstStr(it.Definition["zh"], it.Definition["en"]))
			en := strings.TrimSpace(firstStr(it.Definition["en"], zh))
			remoteCover := firstRemoteCoverURL(it.Examples)
			var data []byte
			var localCode string
			var imgList []string
			if it.Kind == "style" {
				var prev resources.Style
				if oldErr == nil {
					_ = json.Unmarshal(oldDoc.Data, &prev)
				}
				num := firstStr(prev.Number, s.nextCustomCode("style", "MY-S-"))
				localCode = num
				cover := prev.Image
				if remoteCover != "" && (remoteCover != prev.RemoteImageURL || cover == "" || !fileExists(cover)) {
					if dl := s.downloadPrivateResourceCover(ctx, remoteCover); dl != "" {
						cover = dl
					}
				}
				cover, imgList = cleanLocalImageList(cover, prev.Images)
				st := resources.Style{
					Number: num, Group: "MY 我的画风 / My Styles", GroupCode: "MY", GroupZh: "我的画风", GroupEn: "My Styles",
					Reference: firstStr(prev.Reference, "自建画风"),
					GenerationName: it.Name, NameZh: it.Name, Traits: zh, TraitsEn: en,
					Image: cover, Images: imgList, RemoteImageURL: firstStr(remoteCover, prev.RemoteImageURL),
					License: it.License, Source: "mine",
				}
				data, _ = json.Marshal(st)
			} else {
				var prev resources.Layout
				if oldErr == nil {
					_ = json.Unmarshal(oldDoc.Data, &prev)
				}
				lid := firstStr(prev.ID, s.nextCustomCode("layout", "MY-L-"))
				localCode = lid
				cover := prev.Image
				if remoteCover != "" && (remoteCover != prev.RemoteImageURL || cover == "" || !fileExists(cover)) {
					if dl := s.downloadPrivateResourceCover(ctx, remoteCover); dl != "" {
						cover = dl
					}
				}
				cover, imgList = cleanLocalImageList(cover, prev.Images)
				lay := resources.Layout{
					ID: lid, Category: "mine", Name: it.Name, NameEn: firstStr(prev.NameEn, it.Name),
					Image: cover, Images: imgList, RemoteImageURL: firstStr(remoteCover, prev.RemoteImageURL),
					PromptZh: zh, PromptEn: en, License: it.License, Source: "mine",
				}
				data, _ = json.Marshal(lay)
			}
			_ = s.DB.PutDoc(&store.Doc{Kind: it.Kind, ID: docID, Name: it.Name, Data: data, RemoteID: it.ID, RemoteRev: it.Revision, Dirty: false})
			if len(it.Published) > 2 && string(it.Published) != "null" {
				_ = s.DB.PutDoc(&store.Doc{Kind: publishStateKind, ID: docID, Name: it.Name, Data: it.Published})
			}
			numRaw, _ := json.Marshal(localCode)
			_ = profile.UpsertLibrary(profile.PersonalResource{
				ID: docID, Kind: it.Kind, Name: it.Name, PromptZh: zh, PromptEn: en,
				License: firstStr(it.License, "个人使用"), Version: firstStr(it.Version, "1.0.0"), Section: "owned",
				Examples: imgList, Extra: map[string]json.RawMessage{"local_number": numRaw},
			})
			pulled++
		}
		if page.NextCursor != "" {
			since = page.NextCursor
			syncState.Cursors["resources"] = page.NextCursor
		}
		if !page.HasMore || len(page.Items) == 0 {
			break
		}
	}
	_ = profile.WriteSyncState(username, syncState)
	if rRes, rErr := s.syncRecipesInternal(ctx); rErr == nil {
		if rp, ok := rRes["pushed"].(int); ok {
			pushed += rp
		}
		if rpl, ok := rRes["pulled"].(int); ok {
			pulled += rpl
		}
	}
	return map[string]any{"ok": true, "pushed": pushed, "pulled": pulled, "conflicts": conflicts}, nil
}

func fileExists(p string) bool {
	if strings.TrimSpace(p) == "" {
		return false
	}
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func (s *Server) mineAnalyze(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Images   []string `json:"images"`
		Kind     string   `json:"kind"`    // style | layout
		Purpose  string   `json:"purpose"` // find | create
		ModelRef string   `json:"modelRef"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.Images) == 0 {
		return nil, bad("请先选择、粘贴或拖入参考图")
	}
	kind := strings.ToLower(strings.TrimSpace(body.Kind))
	if kind != "layout" {
		kind = "style"
	}
	route, err := resolveAIRoute("vision", body.ModelRef)
	if err != nil {
		return nil, err
	}
	dataURLs := make([]string, 0, len(body.Images))
	localPaths := make([]string, 0, len(body.Images))
	var tempPaths []string
	defer func() {
		for _, tp := range tempPaths {
			_ = os.Remove(tp)
		}
	}()
	for _, img := range body.Images {
		if strings.HasPrefix(img, "data:image/") {
			dataURLs = append(dataURLs, img)
			if raw, dErr := decodeDataURL(img); dErr == nil && len(raw) > 0 {
				if tf, tErr := os.CreateTemp("", "handraw-analyze-*"+sniffImageExt(raw)); tErr == nil {
					_, _ = tf.Write(raw)
					_ = tf.Close()
					localPaths = append(localPaths, tf.Name())
					tempPaths = append(tempPaths, tf.Name())
				}
			}
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
		if abs, aErr := filepath.Abs(path); aErr == nil {
			localPaths = append(localPaths, abs)
		} else {
			localPaths = append(localPaths, path)
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

	promptText := "请仅提取以下参考图的纯粹视觉艺术语言（媒介、笔触线条、纸张材质肌理、色彩倾向、光影质感、空间氛围）。严禁描述任何具体人物、性别、发型、服饰、动物、道具、建筑或场景故事。只用一段精炼清晰的中文概括视觉特征即可。返回严格 JSON: {\"name\":\"画风名称（4-12字）\",\"description\":\"纯视觉艺术语言描述\"}"
	if kind == "layout" {
		promptText = "请仅提取以下参考图的画面构图与版面排版结构（视觉动线、区域网格划分、标题区/主体配图区/说明文案区位置与比例、边框分隔与留白机制）。不要描述具体画风笔触、不要描述具体人物或故事题材。只用一段清晰可复用的中文排版约束描述。返回严格 JSON: {\"name\":\"图型名称（4-12字）\",\"description\":\"构图与版面排版约束描述\"}"
	}

	buildResult := func(source, service, modelName, rawReply string) (map[string]any, error) {
		var out struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			TraitsZh    string `json:"traitsZh"`
			TraitsEn    string `json:"traitsEn"`
			PromptZh    string `json:"promptZh"`
			PromptEn    string `json:"promptEn"`
		}
		if json.Unmarshal([]byte(extractJSON(rawReply)), &out) != nil {
			return nil, bad("视觉解析模型返回格式无法解析，请确认所选模型支持看图（Vision）并重试")
		}
		desc := strings.TrimSpace(firstStr(out.Description, out.TraitsZh, out.PromptZh, out.TraitsEn, out.PromptEn))
		if desc == "" {
			return nil, bad("视觉解析模型未返回有效特征描述，请重试或切换支持视觉识图的模型")
		}
		res := map[string]any{
			"source":      source,
			"kind":        kind,
			"name":        strings.TrimSpace(out.Name),
			"description": desc,
			"traitsZh":    desc,
			"traitsEn":    firstStr(strings.TrimSpace(out.TraitsEn), desc),
			"promptZh":    desc,
			"promptEn":    firstStr(strings.TrimSpace(out.PromptEn), desc),
		}
		if service != "" {
			res["service"] = service
		}
		if modelName != "" {
			res["model"] = modelName
		}
		if kind == "style" {
			res["matches"] = p.SearchStyles(desc, 5)
			res["violations"] = prompt.CheckTraitViolations(desc)
		} else {
			res["violations"] = []string{}
		}
		return res, nil
	}

	analyzeWithSite := func() (map[string]any, error) {
		if kind == "style" {
			raw, err := s.Site.AnalyzeStyle(r.Context(), dataURLs, purpose)
			if err == nil {
				var parsed struct {
					Name     string   `json:"name"`
					TraitsZh string   `json:"traitsZh"`
					TraitsEn string   `json:"traitsEn"`
					Matches  []string `json:"matches"`
				}
				_ = json.Unmarshal(raw, &parsed)
				desc := strings.TrimSpace(firstStr(parsed.TraitsZh, parsed.TraitsEn))
				if desc != "" {
					var matched []resources.Style
					for _, id := range parsed.Matches {
						if st, ok := p.Style(id); ok {
							matched = append(matched, st)
						}
					}
					if len(matched) == 0 {
						matched = p.SearchStyles(desc, 5)
					}
					return map[string]any{
						"source":      "site",
						"kind":        kind,
						"name":        strings.TrimSpace(parsed.Name),
						"description": desc,
						"traitsZh":    desc,
						"traitsEn":    firstStr(strings.TrimSpace(parsed.TraitsEn), desc),
						"matches":     matched,
						"violations":  prompt.CheckTraitViolations(desc),
					}, nil
				}
			} else {
				var ae *site.APIError
				if !errors.As(err, &ae) || (ae.Status != 404 && ae.Status != 403) {
					return nil, err
				}
			}
		}
		parts := []any{map[string]any{"type": "text", "text": promptText}}
		for _, du := range dataURLs {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": du}})
		}
		aiRes, aiErr := s.Site.AIChat(r.Context(), site.AIChatRequest{
			Capability:   "vision",
			Messages:     []providers.ChatMessage{{Role: "user", Content: parts}},
			JSONMode:     true,
			FeatureScope: "vision_extract",
		})
		if aiErr != nil {
			return nil, aiErr
		}
		return buildResult("site", aiRes.Service, "", aiRes.Content)
	}

	analyzeWithProvider := func(tp settings.Provider, model string) (map[string]any, error) {
		parts := []any{map[string]any{"type": "text", "text": promptText}}
		for _, du := range dataURLs {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": du}})
		}
		reply, err := providers.Chat(r.Context(), tp, model, []providers.ChatMessage{{Role: "user", Content: parts}}, true)
		if err != nil {
			return nil, err
		}
		return buildResult("provider", "", tp.Name+":"+model, reply)
	}

	analyzeWithHarness := func(hst harnesses.Status, subModel string) (map[string]any, error) {
		res, err := harnesses.Chat(r.Context(), hst, harnesses.ChatRequest{
			Messages: []harnesses.Message{{Role: "user", Content: promptText}},
			Images:   localPaths,
			JSONMode: true,
			Model:    subModel,
		})
		if err != nil {
			return nil, err
		}
		modelLabel := hst.Name
		if res.Model != "" {
			modelLabel += " · " + res.Model
		}
		return buildResult("harness", "", modelLabel, res.Text)
	}

	switch route.Mode {
	case "harness":
		return analyzeWithHarness(route.Harness, route.HarnessSubModel)
	case "provider":
		return analyzeWithProvider(route.Provider, route.Model)
	case "site":
		if !s.Site.LoggedIn() {
			return nil, site.ErrNotLoggedIn
		}
		res, err := analyzeWithSite()
		if err != nil {
			return nil, analyzeSiteError(err)
		}
		return res, nil
	default:
		var siteErr error
		if s.Site.LoggedIn() {
			res, err := analyzeWithSite()
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
			Msg:    "请先登录手绘风账号，或选择第三方接口 / 本地 AI Harness 进行识别提取",
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
		URL     string `json:"url"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.URL) != "" {
		rawURL := strings.TrimSpace(body.URL)
		if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
			return nil, bad("仅支持 http/https 图片链接")
		}
		hc := &http.Client{Timeout: 20 * time.Second}
		req, err := http.NewRequestWithContext(r.Context(), "GET", rawURL, nil)
		if err != nil {
			return nil, bad("图片链接无效")
		}
		req.Header.Set("User-Agent", "HandrawClient/1.0")
		resp, err := hc.Do(req)
		if err != nil {
			return nil, bad("下载远端图片失败：" + err.Error())
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return nil, bad(fmt.Sprintf("远端图片返回状态 %d", resp.StatusCode))
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 25<<20))
		if err != nil || len(b) == 0 {
			return nil, bad("读取远端图片失败")
		}
		return saveUploadedBytes(b, firstStr(body.Name, "remote"))
	}
	if body.DataURL == "" {
		return nil, bad("缺少 dataUrl 或 url")
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
