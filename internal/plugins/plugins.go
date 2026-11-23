// Package plugins is the plugin runtime, modeled on Magpie's
// (docs/subsystems/plugin-runtime.md):
//
//   - Built-in plugins are features compiled into the program that the user
//     can switch off. Each has a manifest; the runtime enables them in
//     dependency order, a failing one never stops the others, and one in use
//     (it has user data) can't be switched off.
//   - Community plugins are folders (installed from GitHub or a zip) with a
//     package.json "handraw" section. They contribute sandboxed pages, panels
//     and menu actions, and may only call the host APIs they declare.
package plugins

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const APIVersion = "1.0"

// Setting is one field of a plugin's settings form.
type Setting struct {
	Key         string   `json:"key"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Type        string   `json:"type"` // bool | int | string | enum
	Enum        []string `json:"enum,omitempty"`
	Min         *int     `json:"min,omitempty"`
	Max         *int     `json:"max,omitempty"`
	Default     any      `json:"default"`
}

// Manifest describes a built-in plugin.
type Manifest struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Desc      string    `json:"desc"`
	API       string    `json:"api"`
	Requires  []string  `json:"requires"`
	Provides  []string  `json:"provides"`
	Essential bool      `json:"essential"`
	Pages     []string  `json:"pages"` // UI page keys this plugin owns
	Settings  []Setting `json:"settings"`
	// InUse counts user data that depends on the plugin; >0 keeps it on.
	InUse func() (int, error) `json:"-"`
	Apply func(ctx *Ctx) error `json:"-"`
}

type Ctx struct {
	Config   map[string]any
	disposes []func()
	provide  func(name string, v any)
	service  func(name string) any
}

func (c *Ctx) OnDispose(f func())          { c.disposes = append(c.disposes, f) }
func (c *Ctx) Provide(name string, v any)  { c.provide(name, v) }
func (c *Ctx) Service(name string) any     { return c.service(name) }

type State struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Desc     string         `json:"desc"`
	State    string         `json:"state"` // off | pending | active | failed
	Reason   string         `json:"reason,omitempty"`
	Enabled  bool           `json:"enabled"`
	InUse    int            `json:"inUse"`
	Locked   bool           `json:"locked"` // in use: can't switch off
	Pages    []string       `json:"pages"`
	Settings []Setting      `json:"settings"`
	Config   map[string]any `json:"config"`
	Builtin  bool           `json:"builtin"`
}

type Runtime struct {
	mu        sync.Mutex
	manifests []Manifest
	active    map[string]*Ctx
	states    map[string]*State
	services  map[string]any
	Dir       string // community plugins folder
}

func NewRuntime(dir string) *Runtime {
	return &Runtime{active: map[string]*Ctx{}, states: map[string]*State{}, services: map[string]any{"core": true, "settings": true, "site": true, "window": true}, Dir: dir}
}

func (r *Runtime) Register(m Manifest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.manifests {
		if x.ID == m.ID {
			panic("plugin registered twice: " + m.ID)
		}
	}
	if m.API == "" {
		m.API = "^1"
	}
	r.manifests = append(r.manifests, m)
}

func compatible(want string) bool {
	return want == "^1" || want == "1" || strings.HasPrefix(want, "^1.") || want == "*"
}

func defaults(m Manifest) map[string]any {
	out := map[string]any{}
	for _, s := range m.Settings {
		out[s.Key] = s.Default
	}
	return out
}

// Reconcile turns plugins on and off to match enabled[id] (missing = on).
func (r *Runtime) Reconcile(enabled map[string]bool, config map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	want := map[string]bool{}
	for _, m := range r.manifests {
		on, set := enabled[m.ID]
		if !set {
			on = true
		}
		n := 0
		if m.InUse != nil {
			if c, err := m.InUse(); err != nil || c > 0 {
				n = c
				if err != nil {
					n = 1
				}
				on = true // in use: stays on whatever the switch says
			}
		}
		want[m.ID] = on
		st := r.state(m)
		st.Enabled, st.InUse, st.Locked = on, n, n > 0
		cfg := defaults(m)
		if c, ok := config[m.ID].(map[string]any); ok {
			for k, v := range c {
				if _, known := cfg[k]; known {
					cfg[k] = v
				}
			}
		}
		st.Config = cfg
	}
	// Off first, newest first.
	for i := len(r.manifests) - 1; i >= 0; i-- {
		m := r.manifests[i]
		if c, ok := r.active[m.ID]; ok && !want[m.ID] {
			r.dispose(m.ID, c)
			r.states[m.ID].State = "off"
		}
	}
	// On, repeatedly until nothing more can start.
	for changed := true; changed; {
		changed = false
		for _, m := range r.manifests {
			if !want[m.ID] || r.active[m.ID] != nil || r.states[m.ID].State == "failed" {
				continue
			}
			if !compatible(m.API) {
				r.states[m.ID].State, r.states[m.ID].Reason = "failed", "需要宿主 API "+m.API
				continue
			}
			missing := ""
			for _, req := range m.Requires {
				if _, ok := r.services[req]; !ok {
					missing = req
				}
			}
			if missing != "" {
				r.states[m.ID].State, r.states[m.ID].Reason = "pending", "等待服务 "+missing
				continue
			}
			ctx := &Ctx{Config: r.states[m.ID].Config}
			var provided []string
			ctx.provide = func(name string, v any) { r.services[name] = v; provided = append(provided, name) }
			ctx.service = func(name string) any { return r.services[name] }
			err := safeApply(m, ctx)
			if err != nil {
				for _, p := range provided {
					delete(r.services, p)
				}
				for i := len(ctx.disposes) - 1; i >= 0; i-- {
					safe(ctx.disposes[i])
				}
				r.states[m.ID].State, r.states[m.ID].Reason = "failed", err.Error()
				continue
			}
			for _, p := range m.Provides {
				if _, ok := r.services[p]; !ok {
					r.services[p] = true
				}
			}
			ctx.OnDispose(func() {
				for _, p := range append(provided, m.Provides...) {
					delete(r.services, p)
				}
			})
			r.active[m.ID] = ctx
			r.states[m.ID].State, r.states[m.ID].Reason = "active", ""
			changed = true
		}
	}
}

func (r *Runtime) state(m Manifest) *State {
	st, ok := r.states[m.ID]
	if !ok {
		st = &State{ID: m.ID, Name: m.Name, Desc: m.Desc, State: "off", Pages: m.Pages, Settings: m.Settings, Builtin: true}
		r.states[m.ID] = st
	}
	return st
}

func (r *Runtime) dispose(id string, c *Ctx) {
	for i := len(c.disposes) - 1; i >= 0; i-- {
		safe(c.disposes[i])
	}
	delete(r.active, id)
}

func safe(f func()) {
	defer func() { _ = recover() }()
	f()
}

func safeApply(m Manifest, c *Ctx) (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("启动时崩溃：%v", rec)
		}
	}()
	if m.Apply == nil {
		return nil
	}
	return m.Apply(c)
}

// States lists built-in plugins in registration order.
func (r *Runtime) States() []State {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []State
	for _, m := range r.manifests {
		if st, ok := r.states[m.ID]; ok {
			out = append(out, *st)
		}
	}
	return out
}

// Active reports whether a built-in plugin is on.
func (r *Runtime) Active(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active[id] != nil
}

// CanDisable refuses switching off a plugin that is in use.
func (r *Runtime) CanDisable(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if st, ok := r.states[id]; ok && st.Locked {
		return fmt.Errorf("%s 正在使用中（%d 项数据），不能关闭", st.Name, st.InUse)
	}
	return nil
}

// ValidateConfig checks a config against a plugin's settings schema.
func (r *Runtime) ValidateConfig(id string, cfg map[string]any) (map[string]any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var m *Manifest
	for i := range r.manifests {
		if r.manifests[i].ID == id {
			m = &r.manifests[i]
		}
	}
	if m == nil {
		return nil, fmt.Errorf("没有插件 %s", id)
	}
	out := map[string]any{}
	for _, s := range m.Settings {
		v, ok := cfg[s.Key]
		if !ok {
			continue
		}
		switch s.Type {
		case "bool":
			if _, ok := v.(bool); !ok {
				return nil, fmt.Errorf("%s 需要开关值", s.Title)
			}
		case "int":
			f, ok := v.(float64)
			if !ok || f != float64(int(f)) {
				return nil, fmt.Errorf("%s 需要整数", s.Title)
			}
			if (s.Min != nil && int(f) < *s.Min) || (s.Max != nil && int(f) > *s.Max) {
				return nil, fmt.Errorf("%s 超出范围", s.Title)
			}
		case "enum":
			sv, _ := v.(string)
			found := false
			for _, e := range s.Enum {
				if e == sv {
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("%s 取值无效", s.Title)
			}
		case "string":
			if _, ok := v.(string); !ok {
				return nil, fmt.Errorf("%s 需要文字", s.Title)
			}
		}
		out[s.Key] = v
	}
	return out, nil
}

// ---------- community plugins ----------

// Permission names a host capability a community plugin may use.
var KnownPermissions = map[string]string{
	"resources:read":     "读取画风、图型、主题色等资源",
	"galleries:read":     "读取宿主全部画廊（画风、图型、主题色、影调及发型/姿势等扩展画廊）",
	"galleries:register": "向宿主注册新的扩展画廊供画册和其他插件调用",
	"models:text":        "调用宿主配置的文字模型",
	"models:vision":      "调用宿主配置的视觉理解模型",
	"models:image":       "调用宿主配置的生图模型（受单次费用上限保护）",
	"works:read":         "读取本地作品列表和图片",
	"recipes:read":       "读取配方",
	"generate":           "发起生图（会按所选模型计费）",
	"image:save":         "把图片保存到本地作品",
	"clipboard":          "复制文字或图片到剪贴板",
	"open:url":           "在浏览器中打开网址",
	"provider":           "注册新的生图接口",
}

type Page struct {
	File   string            `json:"file"`
	Title  string            `json:"title"`
	Titles map[string]string `json:"titles,omitempty"`
	Icon   string            `json:"icon,omitempty"`
}

type Panel struct {
	Slot  string `json:"slot"` // work-detail | create-footer | home | settings
	File  string `json:"file"`
	Title string `json:"title"`
}

type Action struct {
	ID    string `json:"id"`
	Menu  string `json:"menu"` // work | style | layout
	Title string `json:"title"`
}

type ProviderSpec struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Endpoint string `json:"endpoint"` // a local URL the plugin's service listens on (OpenAI-compatible)
}

type Community struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind,omitempty"`       // handraw | dsh
	TrustLevel  string         `json:"trustLevel,omitempty"` // L1 | L2
	Name        string         `json:"name"`
	Version     string         `json:"version"`
	Description string         `json:"description"`
	Author      string         `json:"author"`
	Homepage    string         `json:"homepage"`
	API         string         `json:"api"`
	Permissions []string       `json:"permissions"`
	Page        *Page          `json:"page,omitempty"`
	Panels      []Panel        `json:"panels,omitempty"`
	Actions     []Action       `json:"actions,omitempty"`
	Providers   []ProviderSpec `json:"providers,omitempty"`
	DSH         *DSHMeta       `json:"dsh,omitempty"`
	Enabled     bool           `json:"enabled"`
	Dir         string         `json:"-"`
	Source      string         `json:"source"`
	Error       string         `json:"error,omitempty"`
}

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,40}$`)
var slots = map[string]bool{"work-detail": true, "create-footer": true, "home": true, "settings": true}
var menus = map[string]bool{"work": true, "style": true, "layout": true}

// ReadCommunity parses a plugin folder's package.json (supports native handraw and DSH plugins, plus .link pointers).
func ReadCommunity(dir string) (Community, error) {
	targetDir, linked := resolveLinkedDir(dir)
	b, err := os.ReadFile(filepath.Join(targetDir, "package.json"))
	if err != nil {
		return Community{}, errors.New("缺少 package.json")
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return Community{}, fmt.Errorf("package.json 无法解析：%w", err)
	}
	_, hasHandraw := raw["handraw"]
	_, hasDSH := raw["dsh"]
	if !hasHandraw && hasDSH {
		return readDSHCommunity(targetDir, linked, raw)
	}

	var pkg struct {
		Name        string    `json:"name"`
		Version     string    `json:"version"`
		Description string    `json:"description"`
		Author      any       `json:"author"`
		Homepage    string    `json:"homepage"`
		Handraw     Community `json:"handraw"`
	}
	if err := json.Unmarshal(b, &pkg); err != nil {
		return Community{}, fmt.Errorf("package.json 无法解析：%w", err)
	}
	c := pkg.Handraw
	c.Kind = "handraw"
	c.TrustLevel = "L1"
	c.Dir = targetDir
	if c.ID == "" {
		c.ID = strings.TrimPrefix(strings.ToLower(pkg.Name), "@")
		c.ID = strings.NewReplacer("/", "-", "_", "-").Replace(c.ID)
	}
	if !idRe.MatchString(c.ID) {
		return c, fmt.Errorf("插件 id %q 无效", c.ID)
	}
	if c.Name == "" {
		c.Name = pkg.Name
	}
	c.Version, c.Description, c.Homepage = pkg.Version, firstNon(c.Description, pkg.Description), pkg.Homepage
	switch a := pkg.Author.(type) {
	case string:
		c.Author = a
	case map[string]any:
		c.Author, _ = a["name"].(string)
	}
	if c.API == "" {
		c.API = "^1"
	}
	if !compatible(c.API) {
		return c, fmt.Errorf("需要宿主 API %s", c.API)
	}
	for _, p := range c.Permissions {
		if _, ok := KnownPermissions[p]; !ok {
			return c, fmt.Errorf("未知权限 %s", p)
		}
	}
	if c.Page != nil && !inside(targetDir, c.Page.File) {
		return c, errors.New("页面文件必须在插件目录内")
	}
	if len(c.Panels) > 8 {
		return c, errors.New("面板最多 8 个")
	}
	for _, p := range c.Panels {
		if !slots[p.Slot] || !inside(targetDir, p.File) {
			return c, fmt.Errorf("面板 %s 无效", p.Slot)
		}
	}
	if len(c.Actions) > 8 {
		return c, errors.New("菜单项最多 8 个")
	}
	for _, a := range c.Actions {
		if !menus[a.Menu] || !idRe.MatchString(a.ID) {
			return c, fmt.Errorf("菜单项 %s 无效", a.ID)
		}
		if c.Page == nil {
			return c, errors.New("菜单项需要插件有页面")
		}
	}
	for _, p := range c.Providers {
		if !strings.HasPrefix(p.Endpoint, "http://127.0.0.1:") && !strings.HasPrefix(p.Endpoint, "http://localhost:") {
			return c, errors.New("生图接口插件只能指向本机地址")
		}
	}
	if len(c.Providers) > 0 && !c.Has("provider") {
		return c, errors.New("注册生图接口需要声明 provider 权限")
	}
	return c, nil
}

func firstNon(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func inside(dir, rel string) bool {
	if rel == "" || filepath.IsAbs(rel) || strings.Contains(rel, "..") {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel)))
	return err == nil
}

func (c Community) Has(perm string) bool {
	for _, p := range c.Permissions {
		if p == perm {
			return true
		}
	}
	return false
}

// ListCommunity reads every installed community plugin.
func (r *Runtime) ListCommunity(enabled map[string]bool) []Community {
	entries, _ := os.ReadDir(r.Dir)
	var out []Community
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(r.Dir, e.Name())
		c, err := ReadCommunity(dir)
		if err != nil {
			c.ID = e.Name()
			c.Error = err.Error()
		}
		c.Enabled = err == nil && enabled["community:"+c.ID]
		src, _ := os.ReadFile(filepath.Join(dir, ".source"))
		c.Source = string(src)
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (r *Runtime) Community(id string) (Community, error) {
	if !idRe.MatchString(id) {
		return Community{}, errors.New("插件 id 无效")
	}
	return ReadCommunity(filepath.Join(r.Dir, id))
}

var ghRe = regexp.MustCompile(`^(?:https://github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$`)

// Install installs a plugin from a local directory (or link:), npm:<pkg>[@ver],
// a Git repository (GitHub owner/repo, https://...git, Gitee/GitLab), or a
// direct .tar.gz / .tgz / .zip URL. It returns the plugin, not yet enabled.
func (r *Runtime) Install(ctx context.Context, source string) (Community, error) {
	source = strings.TrimSpace(source)
	if strings.HasPrefix(source, "link:") {
		return r.InstallLocal(source)
	}
	trimmedPath := strings.Trim(source, `"'`)
	if st, err := os.Stat(trimmedPath); err == nil && st.IsDir() {
		return r.InstallLocal(trimmedPath)
	}
	if strings.HasPrefix(source, "npm:") {
		spec := strings.TrimSpace(strings.TrimPrefix(source, "npm:"))
		pkgName, ver := spec, "latest"
		if i := strings.LastIndexByte(spec, '@'); i > 0 {
			pkgName, ver = spec[:i], spec[i+1:]
		}
		if pkgName == "" {
			return Community{}, errors.New("请填写有效的 npm 包名（例如 npm:dsh-media-desk）")
		}
		return r.InstallNPM(ctx, pkgName, ver, "", source)
	}
	if m := ghRe.FindStringSubmatch(source); m != nil {
		repoURL := fmt.Sprintf("https://github.com/%s/%s.git", m[1], m[2])
		return r.InstallGit(ctx, repoURL, "HEAD", "", source)
	}
	if !strings.HasPrefix(source, "https://") {
		return Community{}, errors.New("请填写本地目录、Git 仓库（owner/repo 或 https://...git）、npm:<包名>，或 .tar.gz / .zip 链接")
	}
	lower := strings.ToLower(source)
	switch {
	case strings.HasSuffix(lower, ".tgz"), strings.HasSuffix(lower, ".tar.gz"):
		return r.InstallTarGzURL(ctx, source, "", source)
	case strings.HasSuffix(lower, ".zip"):
		return r.InstallZipURL(ctx, source, "", source)
	case strings.HasSuffix(lower, ".git"), strings.Contains(lower, "github.com/"), strings.Contains(lower, "gitee.com/"), strings.Contains(lower, "gitlab.com/"):
		return r.InstallGit(ctx, source, "HEAD", "", source)
	default:
		return r.InstallZipURL(ctx, source, "", source)
	}
}

// InstallZip validates and unpacks a plugin archive.
func (r *Runtime) InstallZip(data []byte, source string) (Community, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Community{}, errors.New("插件包不是有效的 zip")
	}
	tmp, err := os.MkdirTemp(r.Dir, ".install-")
	if err != nil {
		return Community{}, err
	}
	defer os.RemoveAll(tmp)
	// GitHub zips wrap everything in one top folder; strip it.
	prefix := ""
	if len(zr.File) > 0 {
		first := zr.File[0].Name
		if i := strings.IndexByte(first, '/'); i > 0 {
			prefix = first[:i+1]
			for _, f := range zr.File {
				if !strings.HasPrefix(f.Name, prefix) {
					prefix = ""
					break
				}
			}
		}
	}
	var total int64
	for _, f := range zr.File {
		name := strings.TrimPrefix(f.Name, prefix)
		if name == "" || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > 100<<20 {
			return Community{}, errors.New("插件包过大")
		}
		dst := filepath.Join(tmp, filepath.FromSlash(name))
		if f.FileInfo().IsDir() {
			os.MkdirAll(dst, 0o755)
			continue
		}
		os.MkdirAll(filepath.Dir(dst), 0o755)
		rc, err := f.Open()
		if err != nil {
			return Community{}, err
		}
		b, err := io.ReadAll(io.LimitReader(rc, 50<<20))
		rc.Close()
		if err != nil {
			return Community{}, err
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return Community{}, err
		}
	}
	c, err := ReadCommunity(tmp)
	if err != nil {
		return c, err
	}
	final := filepath.Join(r.Dir, c.ID)
	_ = os.RemoveAll(final + ".old")
	if _, err := os.Stat(final); err == nil {
		if err := os.Rename(final, final+".old"); err != nil {
			return c, err
		}
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Rename(final+".old", final)
		return c, err
	}
	_ = os.RemoveAll(final + ".old")
	_ = os.WriteFile(filepath.Join(final, ".source"), []byte(source), 0o644)
	c.Dir = final
	c.Source = source
	return c, nil
}

func (r *Runtime) Remove(id string) error {
	if !idRe.MatchString(id) {
		return errors.New("插件 id 无效")
	}
	return os.RemoveAll(filepath.Join(r.Dir, id))
}

// FilePath resolves a file inside a community plugin's folder (following .link pointers).
func (r *Runtime) FilePath(id, rel string) (string, bool) {
	if !idRe.MatchString(id) || strings.Contains(rel, "..") {
		return "", false
	}
	base, _ := resolveLinkedDir(filepath.Join(r.Dir, id))
	p := filepath.Join(base, filepath.FromSlash(rel))
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return "", false
	}
	return p, true
}
