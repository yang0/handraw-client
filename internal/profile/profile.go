// Package profile reads and writes the Skill-compatible ~/.handraw-style
// personal library, recipes and custom asset library (see
// handraw-style/docs/client-data-contract.md).
package profile

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/settings"
)

var (
	homeMu   sync.Mutex
	homeOver string
)

// SetHome overrides the profile directory (tests only).
func SetHome(dir string) {
	homeMu.Lock()
	homeOver = dir
	homeMu.Unlock()
}

// Home resolves HANDRAW_PROFILE_HOME, or an isolated directory under appdir
// during tests / HANDRAW_HOME overrides, or ~/.handraw-style in normal runs.
func Home() string {
	homeMu.Lock()
	over := homeOver
	homeMu.Unlock()
	if over != "" {
		return over
	}
	if v := os.Getenv("HANDRAW_PROFILE_HOME"); v != "" {
		return v
	}
	if os.Getenv("HANDRAW_HOME") != "" || testing.Testing() {
		return filepath.Join(appdir.Root(), "profile")
	}
	h, err := os.UserHomeDir()
	if err != nil || h == "" {
		return filepath.Join(appdir.Root(), "profile")
	}
	return filepath.Join(h, ".handraw-style")
}

// PersonalResource matches personal-library/library.json entries. Unknown JSON
// fields are preserved in Extra across read-modify-write cycles.
type PersonalResource struct {
	ID        string                     `json:"id"`
	Kind      string                     `json:"kind"` // style | layout | package | work | experience
	Name      string                     `json:"name"`
	PromptZh  string                     `json:"prompt_zh"`
	PromptEn  string                     `json:"prompt_en"`
	License   string                     `json:"license"`
	Version   string                     `json:"version"`
	Section   string                     `json:"section"` // owned | collected
	Origin    json.RawMessage            `json:"origin,omitempty"`
	Examples  []string                   `json:"examples,omitempty"`
	SHA256    string                     `json:"sha256,omitempty"`
	Path      string                     `json:"path,omitempty"`
	CreatedAt string                     `json:"created_at,omitempty"`
	UpdatedAt string                     `json:"updated_at,omitempty"`
	Extra     map[string]json.RawMessage `json:"-"`
}

func (r PersonalResource) MarshalJSON() ([]byte, error) {
	m := map[string]any{}
	for k, v := range r.Extra {
		m[k] = v
	}
	m["id"] = r.ID
	m["kind"] = r.Kind
	m["name"] = r.Name
	m["prompt_zh"] = r.PromptZh
	m["prompt_en"] = r.PromptEn
	m["license"] = r.License
	if r.Version == "" {
		r.Version = "1.0.0"
	}
	m["version"] = r.Version
	if r.Section == "" {
		r.Section = "owned"
	}
	m["section"] = r.Section
	if len(r.Origin) > 0 {
		m["origin"] = r.Origin
	} else {
		m["origin"] = nil
	}
	if len(r.Examples) > 0 {
		m["examples"] = r.Examples
	}
	if r.SHA256 != "" {
		m["sha256"] = r.SHA256
	}
	if r.Path != "" {
		m["path"] = r.Path
	}
	if r.CreatedAt != "" {
		m["created_at"] = r.CreatedAt
	}
	if r.UpdatedAt != "" {
		m["updated_at"] = r.UpdatedAt
	}
	return json.Marshal(m)
}

func (r *PersonalResource) UnmarshalJSON(data []byte) error {
	type alias PersonalResource
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*r = PersonalResource(a)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err == nil {
		known := map[string]bool{
			"id": true, "kind": true, "name": true, "prompt_zh": true, "prompt_en": true,
			"license": true, "version": true, "section": true, "origin": true, "examples": true,
			"sha256": true, "path": true, "created_at": true, "updated_at": true,
		}
		for k := range known {
			delete(raw, k)
		}
		if len(raw) > 0 {
			r.Extra = raw
		}
	}
	return nil
}

func LibraryPath() string {
	return filepath.Join(Home(), "personal-library", "library.json")
}

// ReadLibrary reads <home>/personal-library/library.json, preserving top-level extra keys.
func ReadLibrary() ([]PersonalResource, map[string]json.RawMessage, error) {
	p := LibraryPath()
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, map[string]json.RawMessage{"schema_version": json.RawMessage("1")}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(b, &root); err != nil {
		return nil, nil, err
	}
	var items []PersonalResource
	if rawRes, ok := root["resources"]; ok && len(rawRes) > 0 {
		if err := json.Unmarshal(rawRes, &items); err != nil {
			return nil, nil, err
		}
	}
	delete(root, "resources")
	if _, ok := root["schema_version"]; !ok {
		root["schema_version"] = json.RawMessage("1")
	}
	return items, root, nil
}

func writeLibrary(items []PersonalResource, top map[string]json.RawMessage) error {
	dir := filepath.Dir(LibraryPath())
	_ = os.MkdirAll(dir, 0o700)
	if top == nil {
		top = map[string]json.RawMessage{}
	}
	top["schema_version"] = json.RawMessage("1")
	resJSON, err := json.Marshal(items)
	if err != nil {
		return err
	}
	top["resources"] = resJSON
	b, err := json.MarshalIndent(top, "", "  ")
	if err != nil {
		return err
	}
	if err := settings.WriteFileAtomic(LibraryPath(), append(b, '\n')); err != nil {
		return err
	}
	_ = os.Chmod(LibraryPath(), 0o600)
	return nil
}

// UpsertLibrary inserts or updates a personal resource in library.json.
func UpsertLibrary(item PersonalResource) error {
	if item.ID == "" || item.Kind == "" || strings.TrimSpace(item.Name) == "" {
		return errors.New("资源缺少必要字段")
	}
	if strings.TrimSpace(item.License) == "" {
		item.License = "个人与商业创作输出允许，原包不允许再次分发"
	}
	if (item.Kind == "style" || item.Kind == "layout") && (strings.TrimSpace(item.PromptZh) == "" || strings.TrimSpace(item.PromptEn) == "") {
		return errors.New("画风与图型的中英文定义均不能为空")
	}
	items, top, err := ReadLibrary()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if item.UpdatedAt == "" {
		item.UpdatedAt = now
	}
	if item.Version == "" {
		item.Version = "1.0.0"
	}
	if item.Section == "" {
		item.Section = "owned"
	}
	replaced := false
	for i := range items {
		if items[i].ID == item.ID {
			if item.CreatedAt == "" {
				item.CreatedAt = items[i].CreatedAt
			}
			// Preserve unknown Extra keys from the existing record unless overwritten.
			if len(items[i].Extra) > 0 {
				merged := map[string]json.RawMessage{}
				for k, v := range items[i].Extra {
					merged[k] = v
				}
				for k, v := range item.Extra {
					merged[k] = v
				}
				item.Extra = merged
			}
			items[i] = item
			replaced = true
			break
		}
	}
	if !replaced {
		if item.CreatedAt == "" {
			item.CreatedAt = now
		}
		items = append(items, item)
	}
	return writeLibrary(items, top)
}

// DeleteLibrary removes a resource by id from library.json.
func DeleteLibrary(id string) error {
	items, top, err := ReadLibrary()
	if err != nil {
		return err
	}
	var out []PersonalResource
	for _, it := range items {
		if it.ID != id {
			out = append(out, it)
		}
	}
	if out == nil {
		out = []PersonalResource{}
	}
	return writeLibrary(out, top)
}

// ---------- Cloud sync state (compatible with handraw_cloud.py) ----------

type SyncState struct {
	Assets    map[string]any            `json:"assets"`
	Cursors   map[string]any            `json:"cursors"`
	Resources map[string]SyncResource   `json:"resources"`
}

type SyncResource struct {
	UID      string `json:"uid"`
	Code     string `json:"code"`
	Revision int    `json:"revision"`
}

func SyncStatePath(username string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(username))))
	return filepath.Join(Home(), fmt.Sprintf("cloud-sync-%s.json", hex.EncodeToString(sum[:])[:16]))
}

func ReadSyncState(username string) SyncState {
	st := SyncState{Assets: map[string]any{}, Cursors: map[string]any{}, Resources: map[string]SyncResource{}}
	if username == "" {
		return st
	}
	b, err := os.ReadFile(SyncStatePath(username))
	if err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Assets == nil {
		st.Assets = map[string]any{}
	}
	if st.Cursors == nil {
		st.Cursors = map[string]any{}
	}
	if st.Resources == nil {
		st.Resources = map[string]SyncResource{}
	}
	return st
}

func WriteSyncState(username string, st SyncState) error {
	if username == "" {
		return nil
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return settings.WriteFileAtomic(SyncStatePath(username), append(b, '\n'))
}

// ---------- Recipes (<home>/recipes/<id>.json) ----------

type RecipeRemote struct {
	ID               string `json:"id"`
	Revision         int    `json:"revision"`
	InputFingerprint string `json:"inputFingerprint,omitempty"`
}

type Recipe struct {
	SchemaVersion    int                        `json:"schemaVersion"`
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	Kind             string                     `json:"kind"` // single | batch | article_card
	StyleIDs         []string                   `json:"styleIds"`
	LayoutID         string                     `json:"layoutId"`
	Colors           []string                   `json:"colors"`
	Tones            []string                   `json:"tones"`
	Moods            []string                   `json:"moods"`
	Whitespace       string                     `json:"whitespace"`
	Ratio            string                     `json:"ratio"`
	Mode             string                     `json:"mode"` // pure-image | graphic-text
	Subject          string                     `json:"subject"`
	References       []string                   `json:"references"`
	Prompt           string                     `json:"prompt"`
	PromptCustomized bool                       `json:"promptCustomized"`
	Model            string                     `json:"model,omitempty"`
	Notes            string                     `json:"notes,omitempty"`
	Remote           *RecipeRemote              `json:"remote,omitempty"`
	Builtin          bool                       `json:"builtin,omitempty"`
	CreatedAt        string                     `json:"createdAt"`
	UpdatedAt        string                     `json:"updatedAt"`
	Extra            map[string]json.RawMessage `json:"-"`
}

func (r Recipe) ComputeInputFingerprint() string {
	normList := func(in []string, upper bool) []string {
		out := make([]string, 0, len(in))
		for _, v := range in {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			if upper {
				v = strings.ToUpper(v)
			}
			out = append(out, v)
		}
		return out
	}
	payload := struct {
		Colors     []string `json:"colors"`
		LayoutID   string   `json:"layout_id"`
		Mode       string   `json:"mode"`
		Moods      []string `json:"moods"`
		Ratio      string   `json:"ratio"`
		StyleIDs   []string `json:"style_ids"`
		Subject    string   `json:"subject"`
		Tones      []string `json:"tones"`
		Whitespace string   `json:"whitespace"`
	}{
		Colors:     normList(r.Colors, true),
		LayoutID:   strings.ToUpper(strings.TrimSpace(r.LayoutID)),
		Mode:       strings.TrimSpace(r.Mode),
		Moods:      normList(r.Moods, false),
		Ratio:      strings.TrimSpace(r.Ratio),
		StyleIDs:   normList(r.StyleIDs, true),
		Subject:    strings.TrimSpace(r.Subject),
		Tones:      normList(r.Tones, true),
		Whitespace: strings.TrimSpace(r.Whitespace),
	}
	b, _ := json.Marshal(payload)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:32]
}

func RecipesDir() string { return filepath.Join(Home(), "recipes") }

func ListRecipes() ([]Recipe, error) {
	dir := RecipesDir()
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Recipe
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var r Recipe
		if json.Unmarshal(b, &r) == nil && r.ID != "" {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out, nil
}

func SaveRecipe(r *Recipe) error {
	if r.ID == "" {
		return errors.New("配方缺少 id")
	}
	if r.SchemaVersion == 0 {
		r.SchemaVersion = 1
	}
	if r.Kind == "" {
		r.Kind = "single"
	}
	if r.Mode == "" {
		r.Mode = "graphic-text"
	}
	if r.Ratio == "" {
		r.Ratio = "3:4"
	}
	if r.StyleIDs == nil {
		r.StyleIDs = []string{}
	}
	if r.Colors == nil {
		r.Colors = []string{}
	}
	if r.Tones == nil {
		r.Tones = []string{}
	}
	if r.Moods == nil {
		r.Moods = []string{}
	}
	if r.References == nil {
		r.References = []string{}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if r.CreatedAt == "" {
		r.CreatedAt = now
	}
	r.UpdatedAt = now
	_ = os.MkdirAll(RecipesDir(), 0o755)
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return settings.WriteFileAtomic(filepath.Join(RecipesDir(), r.ID+".json"), append(b, '\n'))
}

func DeleteRecipe(id string) error {
	if strings.ContainsAny(id, `/\..`) {
		return errors.New("配方 id 无效")
	}
	err := os.Remove(filepath.Join(RecipesDir(), id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// BuiltinRecipes returns curated starter recipes using verified pack IDs.
func BuiltinRecipes() []Recipe {
	ts := "2026-11-17T00:00:00Z"
	return []Recipe{
		{SchemaVersion: 1, ID: "rcp_builtin_gzh_cover", Name: "公众号横版封面", Kind: "single", StyleIDs: []string{"FA-013"}, LayoutID: "SC-001", Colors: []string{"C-15"}, Tones: []string{"T-01"}, Moods: []string{"温暖", "编辑感"}, Whitespace: "留白透气", Ratio: "2.35:1", Mode: "graphic-text", Notes: "适合深度长文封面，标题突出、线条松弛有趣", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
		{SchemaVersion: 1, ID: "rcp_builtin_xhs_card", Name: "小红书 3:4 干货图", Kind: "batch", StyleIDs: []string{"FA-001"}, LayoutID: "SC-008", Colors: []string{"C-01"}, Tones: []string{"T-13"}, Moods: []string{"轻快", "通透"}, Whitespace: "适中", Ratio: "3:4", Mode: "graphic-text", Notes: "图上文下留白卡，多图系列风格稳定", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
		{SchemaVersion: 1, ID: "rcp_builtin_infographic", Name: "知识金字塔信息图", Kind: "single", StyleIDs: []string{"FB-001"}, LayoutID: "IG-001", Colors: []string{"C-05"}, Tones: []string{"T-01"}, Moods: []string{"清晰", "书卷气"}, Whitespace: "留白透气", Ratio: "3:4", Mode: "graphic-text", Notes: "水彩淡彩配结构化图表", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
		{SchemaVersion: 1, ID: "rcp_builtin_comic4", Name: "漫画四格故事", Kind: "single", StyleIDs: []string{"FA-001"}, LayoutID: "SB-001", Colors: []string{"C-03"}, Tones: []string{"T-02"}, Moods: []string{"幽默", "日常"}, Whitespace: "紧凑", Ratio: "1:1", Mode: "graphic-text", Notes: "规则网格四格故事分镜", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
		{SchemaVersion: 1, ID: "rcp_builtin_poster", Name: "竖版活动海报", Kind: "single", StyleIDs: []string{"FD-001"}, LayoutID: "IG-010", Colors: []string{"C-16"}, Tones: []string{"T-06"}, Moods: []string{"张力", "醒目"}, Whitespace: "适中", Ratio: "9:16", Mode: "graphic-text", Notes: "东方动态笔触配高反差中国红", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
		{SchemaVersion: 1, ID: "rcp_builtin_article_wide", Name: "文章宽幅叙事插图", Kind: "article_card", StyleIDs: []string{"FE-001"}, Colors: []string{"C-08"}, Tones: []string{"T-13"}, Moods: []string{"温柔", "绘本感"}, Whitespace: "大留白", Ratio: "16:9", Mode: "pure-image", Notes: "柔和自然绘本风格，适合散文或深度文章插画", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
		{SchemaVersion: 1, ID: "rcp_builtin_ecom", Name: "手绘产品展示卡", Kind: "single", StyleIDs: []string{"FI-001"}, LayoutID: "EC-001", Colors: []string{"C-01"}, Tones: []string{"T-01"}, Moods: []string{"克制", "高级"}, Whitespace: "大留白", Ratio: "1:1", Mode: "pure-image", Notes: "极简商业产品质感展示", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
		{SchemaVersion: 1, ID: "rcp_builtin_fusion", Name: "手绘角色 × 实景融合", Kind: "single", StyleIDs: []string{"FA-013", "FI-001"}, Colors: []string{"C-15"}, Tones: []string{"T-14"}, Moods: []string{"跨媒介", "电影感"}, Whitespace: "适中", Ratio: "4:3", Mode: "pure-image", Notes: "双画风跨媒介融合示例", Builtin: true, CreatedAt: ts, UpdatedAt: ts},
	}
}

// ---------- Custom tuku_dir assets (<home>/config.json) ----------

type TukuAsset struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"` // character | prop | scene
	Name      string `json:"name"`
	NameEn    string `json:"name_en"`
	Image     string `json:"image"`
	FilePath  string `json:"filePath"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

func TukuDir() string {
	b, err := os.ReadFile(filepath.Join(Home(), "config.json"))
	if err == nil {
		var cfg map[string]any
		if json.Unmarshal(b, &cfg) == nil {
			if d, ok := cfg["tuku_dir"].(string); ok && d != "" {
				return d
			}
		}
	}
	return ""
}

func ListTukuAssets() []TukuAsset {
	dir := TukuDir()
	if dir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(dir, "library.json"))
	if err != nil {
		return nil
	}
	var lib struct {
		Characters []TukuAsset `json:"characters"`
		Props      []TukuAsset `json:"props"`
		Scenes     []TukuAsset `json:"scenes"`
	}
	if json.Unmarshal(b, &lib) != nil {
		return nil
	}
	var out []TukuAsset
	add := func(list []TukuAsset, kind, sub string) {
		for _, a := range list {
			a.Kind = kind
			fp := filepath.Join(dir, sub, a.ID+".webp")
			if st, err := os.Stat(fp); err == nil && !st.IsDir() {
				a.FilePath = fp
			}
			out = append(out, a)
		}
	}
	add(lib.Characters, "character", "characters")
	add(lib.Props, "prop", "props")
	add(lib.Scenes, "scene", "scenes")
	return out
}

// SkillAuthDetected reports whether the Skill CLI has a saved cloud auth file.
func SkillAuthDetected() (username string, ok bool) {
	b, err := os.ReadFile(filepath.Join(Home(), "cloud_auth.json"))
	if err != nil {
		return "", false
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return "", false
	}
	tok, _ := m["token"].(string)
	if tok == "" {
		tok, _ = m["access_token"].(string)
	}
	user, _ := m["username"].(string)
	if user == "" {
		if u, ok := m["user"].(map[string]any); ok {
			user, _ = u["username"].(string)
		}
	}
	return user, tok != "" && user != ""
}
