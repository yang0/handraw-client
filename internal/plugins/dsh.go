package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// DSHMeta describes a DeepSeek Harness (DSH) compatible plugin (Scheme A).
type DSHMeta struct {
	PackageName   string         `json:"packageName"`
	PluginID      string         `json:"pluginId,omitempty"`
	HostEntry     string         `json:"hostEntry,omitempty"`
	ClientEntry   string         `json:"clientEntry,omitempty"`
	PatchFile     string         `json:"patchFile,omitempty"`
	Config        map[string]any `json:"config,omitempty"`
	ClientInject  []string       `json:"clientInject,omitempty"`
	Compat        string         `json:"compat"` // full | partial | unsupported
	CompatReasons []string       `json:"compatReasons,omitempty"`
	Linked        bool           `json:"linked,omitempty"`
	TargetDir     string         `json:"targetDir,omitempty"`
}

// DSHDiscoveryItem represents a plugin found in the user's local ~/.dsh profile.
type DSHDiscoveryItem struct {
	ID            string   `json:"id"`
	PackageName   string   `json:"packageName"`
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	Description   string   `json:"description,omitempty"`
	Dir           string   `json:"dir"`
	Compat        string   `json:"compat"`
	CompatReasons []string `json:"compatReasons,omitempty"`
	Installed     bool     `json:"installed"`
}

type rawDSHManifest struct {
	Bundle *struct {
		Patch string `json:"patch"`
	} `json:"bundle"`
	Client *struct {
		Platform string   `json:"platform"`
		Inject   []string `json:"inject"`
	} `json:"client"`
}

// resolveLinkedDir follows a `.link` pointer file if present inside dir.
func resolveLinkedDir(dir string) (string, bool) {
	b, err := os.ReadFile(filepath.Join(dir, ".link"))
	if err != nil {
		return dir, false
	}
	target := strings.TrimSpace(string(b))
	if target == "" {
		return dir, false
	}
	if abs, err := filepath.Abs(target); err == nil {
		return abs, true
	}
	return target, true
}

func resolvePackageExport(exports map[string]any, key string) string {
	if exports == nil {
		return ""
	}
	v, ok := exports[key]
	if !ok {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimPrefix(strings.TrimSpace(x), "./")
	case map[string]any:
		for _, k := range []string{"import", "default", "browser", "node"} {
			if s, ok := x[k].(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimPrefix(strings.TrimSpace(s), "./")
			}
		}
	}
	return ""
}

// readDSHCommunity parses a DSH plugin directory from its package.json + cordis.patch.yml.
func readDSHCommunity(targetDir string, linked bool, rawPkg map[string]any) (Community, error) {
	pkgBytes, err := json.Marshal(rawPkg)
	if err != nil {
		return Community{}, err
	}
	var pkg struct {
		Name        string         `json:"name"`
		Version     string         `json:"version"`
		Description string         `json:"description"`
		Author      any            `json:"author"`
		Homepage    string         `json:"homepage"`
		Main        string         `json:"main"`
		Exports     map[string]any `json:"exports"`
		DSH         rawDSHManifest `json:"dsh"`
	}
	if err := json.Unmarshal(pkgBytes, &pkg); err != nil {
		return Community{}, err
	}

	id := sanitizePluginID(pkg.Name)
	if !idRe.MatchString(id) {
		return Community{}, fmt.Errorf("DSH 插件名称 %q 无法映射为有效 id", pkg.Name)
	}

	hostEntry := resolvePackageExport(pkg.Exports, ".")
	if hostEntry == "" && pkg.Main != "" {
		hostEntry = strings.TrimPrefix(strings.TrimSpace(pkg.Main), "./")
	}
	if hostEntry != "" && !inside(targetDir, hostEntry) {
		return Community{}, fmt.Errorf("DSH 插件入口文件不存在：%s", hostEntry)
	}

	clientEntry := resolvePackageExport(pkg.Exports, "./client")
	if clientEntry != "" && !inside(targetDir, clientEntry) {
		clientEntry = ""
	}

	meta := &DSHMeta{
		PackageName: pkg.Name,
		HostEntry:   hostEntry,
		ClientEntry: clientEntry,
		Linked:      linked,
		TargetDir:   targetDir,
	}
	if pkg.DSH.Client != nil {
		meta.ClientInject = pkg.DSH.Client.Inject
	}
	if pkg.DSH.Bundle != nil && strings.TrimSpace(pkg.DSH.Bundle.Patch) != "" {
		patchRel := strings.TrimPrefix(strings.TrimSpace(pkg.DSH.Bundle.Patch), "./")
		meta.PatchFile = patchRel
		if inside(targetDir, patchRel) {
			if pb, err := os.ReadFile(filepath.Join(targetDir, filepath.FromSlash(patchRel))); err == nil {
				pid, cfg := parseCordisPatchYAML(string(pb))
				meta.PluginID = pid
				meta.Config = cfg
			}
		}
	}

	compat, reasons := analyzeDSHCompat(targetDir, meta)
	meta.Compat = compat
	meta.CompatReasons = reasons

	displayName := pkg.Name
	if meta.PluginID != "" {
		displayName = friendlyDSHName(pkg.Name, meta.PluginID)
	}

	c := Community{
		ID:          id,
		Kind:        "dsh",
		TrustLevel:  "L2",
		Name:        displayName,
		Version:     pkg.Version,
		Description: pkg.Description,
		Homepage:    pkg.Homepage,
		API:         "^1",
		Dir:         targetDir,
		DSH:         meta,
	}
	switch a := pkg.Author.(type) {
	case string:
		c.Author = a
	case map[string]any:
		c.Author, _ = a["name"].(string)
	}
	if clientEntry != "" {
		c.Page = &Page{File: clientEntry, Title: displayName}
	}
	return c, nil
}

func sanitizePluginID(name string) string {
	s := strings.TrimSpace(strings.ToLower(name))
	s = strings.TrimPrefix(s, "@")
	s = strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(s)
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 40 {
		out = strings.TrimRight(out[:40], "-")
	}
	return out
}

func friendlyDSHName(pkgName, pluginID string) string {
	known := map[string]string{
		"dsh-plugin-pose-studio":     "AI 写真工作台",
		"dsh-plugin-creative-flow":   "创意分镜工作流",
		"dsh-plugin-chatgpt2api":     "ChatGPT2API 号池",
		"dsh-plugin-handraw-style":   "手绘风 DSH 插件",
		"dsh-plugin-image-workbench": "生图工作台",
		"dsh-media-desk":             "自媒体工作台",
		"dsh-workbench":              "DSH Workbench",
	}
	if v, ok := known[pkgName]; ok {
		return v
	}
	if pluginID != "" {
		return pluginID
	}
	return pkgName
}

// parseCordisPatchYAML extracts the first insert item's id and flat config map
// from a DSH cordis.patch.yml without requiring an external YAML parser.
func parseCordisPatchYAML(src string) (string, map[string]any) {
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	pluginID := ""
	cfg := map[string]any{}
	inConfig := false
	configIndent := -1

	for _, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " \t"))
		if inConfig {
			if indent <= configIndent {
				inConfig = false
			} else if idx := strings.IndexByte(trimmed, ':'); idx > 0 {
				k := strings.TrimSpace(trimmed[:idx])
				v := strings.TrimSpace(trimmed[idx+1:])
				if k != "" {
					cfg[k] = parseYAMLScalar(v)
				}
				continue
			}
		}
		clean := strings.TrimPrefix(trimmed, "- ")
		clean = strings.TrimSpace(clean)
		if strings.HasPrefix(clean, "id:") && pluginID == "" {
			pluginID = unquoteYAML(strings.TrimSpace(strings.TrimPrefix(clean, "id:")))
		} else if clean == "config:" {
			inConfig = true
			configIndent = indent
		}
	}
	if len(cfg) == 0 {
		cfg = nil
	}
	return pluginID, cfg
}

func unquoteYAML(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		return s[1 : len(s)-1]
	}
	return s
}

func parseYAMLScalar(s string) any {
	if i := strings.Index(s, " #"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	if s == "true" {
		return true
	}
	if s == "false" {
		return false
	}
	if s == "null" || s == "~" {
		return nil
	}
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		return s[1 : len(s)-1]
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f
	}
	return s
}

func analyzeDSHCompat(dir string, meta *DSHMeta) (string, []string) {
	var reasons []string
	unsupported := false
	partial := false

	for _, inj := range meta.ClientInject {
		if strings.Contains(inj, "ui-conversation") || strings.Contains(inj, "ui-chat") {
			unsupported = true
			reasons = append(reasons, "依赖完整 DSH 会话界面 ("+inj+")")
		}
	}

	scanFile := func(rel string) string {
		if rel == "" {
			return ""
		}
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			return ""
		}
		if len(b) > 512*1024 {
			b = b[:512*1024]
		}
		return string(b)
	}

	hostText := scanFile(meta.HostEntry)
	clientText := scanFile(meta.ClientEntry)

	if strings.Contains(clientText, "ui-conversation") || strings.Contains(clientText, "useSession(") {
		unsupported = true
		reasons = append(reasons, "前端依赖 DSH 对话会话上下文 (useSession)")
	}
	if strings.Contains(hostText, "remote.session") || strings.Contains(hostText, "'remote'") || strings.Contains(hostText, "\"remote\"") {
		partial = true
		reasons = append(reasons, "包含 remote.session Agent 触发能力（在手绘风中将自动降级）")
	}
	if strings.Contains(hostText, "get('tools')") || strings.Contains(hostText, `get("tools")`) || strings.Contains(hostText, "tools/pre-execute") {
		partial = true
		reasons = append(reasons, "可选调用 DSH 工具注册表（核心面板不受影响）")
	}
	if strings.Contains(hostText, "get('agents')") || strings.Contains(hostText, `get("agents")`) {
		partial = true
		reasons = append(reasons, "包含 DSH Agent 编排接口（将自动降级）")
	}
	if meta.HostEntry == "" && meta.ClientEntry == "" {
		unsupported = true
		reasons = append(reasons, "未发现可加载的 host 或 client 入口文件")
	}

	if unsupported {
		return "unsupported", reasons
	}
	if partial {
		return "partial", reasons
	}
	return "full", nil
}

// InstallLocal links a local plugin folder (native handraw or DSH plugin) into r.Dir
// without duplicating its files.
func (r *Runtime) InstallLocal(localPath string) (Community, error) {
	p := strings.TrimSpace(localPath)
	p = strings.TrimPrefix(p, "link:")
	p = strings.Trim(p, `"'`)
	if p == "" {
		return Community{}, errors.New("请填写本地插件目录路径")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return Community{}, fmt.Errorf("无效目录路径：%w", err)
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return Community{}, fmt.Errorf("插件目录不存在：%s", abs)
	}
	c, err := ReadCommunity(abs)
	if err != nil {
		return c, err
	}
	if c.Kind == "dsh" && c.DSH != nil {
		c.DSH.Linked = true
		c.DSH.TargetDir = abs
	}
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return c, err
	}
	slot := filepath.Join(r.Dir, c.ID)
	_ = os.RemoveAll(slot)
	if err := os.MkdirAll(slot, 0o755); err != nil {
		return c, err
	}
	if err := os.WriteFile(filepath.Join(slot, ".link"), []byte(abs), 0o644); err != nil {
		_ = os.RemoveAll(slot)
		return c, err
	}
	src := "link:" + abs
	_ = os.WriteFile(filepath.Join(slot, ".source"), []byte(src), 0o644)
	c.Source = src
	c.Dir = abs
	return c, nil
}

// DiscoverDSHProfile scans the local ~/.dsh/profiles/desktop/package.json (or DSH_HOME)
// for installed DSH plugins so the user can import them in one click.
func (r *Runtime) DiscoverDSHProfile() []DSHDiscoveryItem {
	dshHome := strings.TrimSpace(os.Getenv("DSH_HOME"))
	if dshHome == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return nil
		}
		dshHome = filepath.Join(home, ".dsh")
	}
	profileDir := filepath.Join(dshHome, "profiles", "desktop")
	b, err := os.ReadFile(filepath.Join(profileDir, "package.json"))
	if err != nil {
		return nil
	}
	var pkg struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(b, &pkg); err != nil {
		return nil
	}
	installed := map[string]bool{}
	for _, c := range r.ListCommunity(nil) {
		installed[c.ID] = true
		if c.DSH != nil && c.DSH.PackageName != "" {
			installed[c.DSH.PackageName] = true
		}
	}

	var out []DSHDiscoveryItem
	for name, spec := range pkg.Dependencies {
		if strings.HasPrefix(name, "@deepseek-ai/") {
			continue
		}
		var dir string
		if strings.HasPrefix(spec, "link:") {
			raw := strings.TrimPrefix(spec, "link:")
			if filepath.IsAbs(raw) {
				dir = raw
			} else {
				dir = filepath.Join(profileDir, filepath.FromSlash(raw))
			}
		} else {
			dir = filepath.Join(profileDir, "node_modules", filepath.FromSlash(name))
		}
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			dir = real
		}
		c, err := ReadCommunity(dir)
		if err != nil || c.Kind != "dsh" || c.DSH == nil {
			continue
		}
		out = append(out, DSHDiscoveryItem{
			ID:            c.ID,
			PackageName:   c.DSH.PackageName,
			Name:          c.Name,
			Version:       c.Version,
			Description:   c.Description,
			Dir:           dir,
			Compat:        c.DSH.Compat,
			CompatReasons: c.DSH.CompatReasons,
			Installed:     installed[c.ID] || installed[c.DSH.PackageName],
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PackageName < out[j].PackageName })
	return out
}
