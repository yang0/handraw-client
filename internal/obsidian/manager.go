// Package obsidian manages globally installed Obsidian-compatible plugins for
// the Handraw Article Workbench, including static compatibility analysis,
// local Obsidian vault discovery/import, and per-plugin state/secrets storage.
package obsidian

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxMainJSAnalyzeBytes = 4 << 20  // 4 MiB for static scan
	maxPluginFileBytes    = 32 << 20 // 32 MiB per file on copy/install
	maxTotalPluginBytes   = 64 << 20 // 64 MiB per plugin
)

var validPluginIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`)
var requireCallRe = regexp.MustCompile(`require\(\s*["']([^"'\r\n]+)["']\s*\)`)

// Manifest matches Obsidian's standard manifest.json schema.
type Manifest struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Version       string `json:"version"`
	MinAppVersion string `json:"minAppVersion,omitempty"`
	Description   string `json:"description,omitempty"`
	Author        string `json:"author,omitempty"`
	AuthorURL     string `json:"authorUrl,omitempty"`
	FundingURL    any    `json:"fundingUrl,omitempty"`
	IsDesktopOnly bool   `json:"isDesktopOnly,omitempty"`
}

// InstallMeta records where and when a plugin was installed into Handraw's global dir.
type InstallMeta struct {
	SourceType  string `json:"sourceType"` // market | github | zip | local | obsidian-vault
	Source      string `json:"source,omitempty"`
	Repo        string `json:"repo,omitempty"`
	InstalledAt int64  `json:"installedAt,omitempty"`
	UpdatedAt   int64  `json:"updatedAt,omitempty"`
}

// CompatReport summarizes static compatibility grading of an Obsidian plugin.
type CompatReport struct {
	Level        string   `json:"level"` // full | partial | unsupported
	Reasons      []string `json:"reasons,omitempty"`
	NeedsDesktop bool     `json:"needsDesktop,omitempty"`
	HasCM6       bool     `json:"hasCM6,omitempty"`
	Requires     []string `json:"requires,omitempty"`
}

// InstalledPlugin represents one plugin stored in Handraw's global obsidian-plugins folder.
type InstalledPlugin struct {
	ID             string       `json:"id"`
	Manifest       Manifest     `json:"manifest"`
	Enabled        bool         `json:"enabled"`
	TrustedDesktop bool         `json:"trustedDesktop"`
	LocalPorts     []int        `json:"localPorts,omitempty"`
	HasStyles      bool         `json:"hasStyles"`
	HasData        bool         `json:"hasData"`
	Install        *InstallMeta `json:"install,omitempty"`
	Compat         CompatReport `json:"compat"`
	Dir            string       `json:"dir"`
}

// DiscoveredPlugin represents a plugin found inside a local Obsidian vault or folder.
type DiscoveredPlugin struct {
	ID                string       `json:"id"`
	Manifest          Manifest     `json:"manifest"`
	PluginDir         string       `json:"pluginDir"`
	VaultDir          string       `json:"vaultDir"`
	VaultName         string       `json:"vaultName"`
	HasData           bool         `json:"hasData"`
	EnabledInObsidian bool         `json:"enabledInObsidian"`
	AlreadyInstalled  bool         `json:"alreadyInstalled"`
	InstalledVersion  string       `json:"installedVersion,omitempty"`
	Compat            CompatReport `json:"compat"`
}

// DiscoveredVault groups discovered plugins by their source Obsidian vault/folder.
type DiscoveredVault struct {
	Dir     string             `json:"dir"`
	Name    string             `json:"name"`
	Source  string             `json:"source"` // obsidian-config | article-vault | custom
	Plugins []DiscoveredPlugin `json:"plugins"`
}

// PluginBundle is sent to the sandboxed obsidian-host.html to execute a plugin.
type PluginBundle struct {
	ID             string          `json:"id"`
	Manifest       Manifest        `json:"manifest"`
	MainJS         string          `json:"mainJs"`
	StylesCSS      string          `json:"stylesCss,omitempty"`
	Data           json.RawMessage `json:"data,omitempty"`
	TrustedDesktop bool            `json:"trustedDesktop"`
	LocalPorts     []int           `json:"localPorts,omitempty"`
}

type globalState struct {
	Enabled        map[string]bool  `json:"enabled"`
	TrustedDesktop map[string]bool  `json:"trustedDesktop"`
	LocalPorts     map[string][]int `json:"localPorts"`
}

// Manager handles global Obsidian plugin storage, discovery, compatibility scanning,
// state persistence, and Obsidian 1.11+ secretStorage.
type Manager struct {
	Dir string

	mu           sync.Mutex
	catalogMu    sync.Mutex
	catalogAt    time.Time
	catalogItems []CatalogItem
}

func New(dir string) *Manager {
	_ = os.MkdirAll(dir, 0o755)
	return &Manager{Dir: dir}
}

func ValidatePluginID(id string) error {
	id = strings.TrimSpace(id)
	if !validPluginIDRe.MatchString(id) || strings.Contains(id, "..") {
		return fmt.Errorf("无效的 Obsidian 插件 ID：%q", id)
	}
	return nil
}

func (m *Manager) statePath() string   { return filepath.Join(m.Dir, "state.json") }
func (m *Manager) secretsPath() string { return filepath.Join(m.Dir, "secrets.json") }

func (m *Manager) loadStateLocked() globalState {
	st := globalState{
		Enabled:        map[string]bool{},
		TrustedDesktop: map[string]bool{},
		LocalPorts:     map[string][]int{},
	}
	b, err := os.ReadFile(m.statePath())
	if err != nil {
		return st
	}
	_ = json.Unmarshal(b, &st)
	if st.Enabled == nil {
		st.Enabled = map[string]bool{}
	}
	if st.TrustedDesktop == nil {
		st.TrustedDesktop = map[string]bool{}
	}
	if st.LocalPorts == nil {
		st.LocalPorts = map[string][]int{}
	}
	return st
}

func (m *Manager) saveStateLocked(st globalState) error {
	if err := os.MkdirAll(m.Dir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.statePath(), b, 0o644)
}

func (m *Manager) pluginDir(id string) (string, error) {
	if err := ValidatePluginID(id); err != nil {
		return "", err
	}
	return filepath.Join(m.Dir, id), nil
}

// ReadManifest parses manifest.json in dir and verifies main.js exists.
func ReadManifest(dir string) (Manifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return Manifest{}, fmt.Errorf("缺少 manifest.json：%w", err)
	}
	var mf Manifest
	if err := json.Unmarshal(b, &mf); err != nil {
		return Manifest{}, fmt.Errorf("manifest.json 解析失败：%w", err)
	}
	mf.ID = strings.TrimSpace(mf.ID)
	mf.Name = strings.TrimSpace(mf.Name)
	mf.Version = strings.TrimSpace(mf.Version)
	if err := ValidatePluginID(mf.ID); err != nil {
		return Manifest{}, err
	}
	if mf.Name == "" {
		mf.Name = mf.ID
	}
	if st, err := os.Stat(filepath.Join(dir, "main.js")); err != nil || st.IsDir() {
		return Manifest{}, errors.New("缺少入口文件 main.js")
	}
	return mf, nil
}

func readInstallMeta(dir string) *InstallMeta {
	b, err := os.ReadFile(filepath.Join(dir, ".handraw-install.json"))
	if err != nil {
		return nil
	}
	var meta InstallMeta
	if err := json.Unmarshal(b, &meta); err != nil {
		return nil
	}
	return &meta
}

func writeInstallMeta(dir string, meta InstallMeta) {
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, ".handraw-install.json"), b, 0o644)
}

// AnalyzeCompat performs static inspection on a plugin's main.js & manifest.json.
func AnalyzeCompat(dir string, mf Manifest) CompatReport {
	mainPath := filepath.Join(dir, "main.js")
	f, err := os.Open(mainPath)
	if err != nil {
		return CompatReport{
			Level:   "unsupported",
			Reasons: []string{"找不到入口文件 main.js"},
		}
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxMainJSAnalyzeBytes))
	if err != nil {
		return CompatReport{
			Level:   "unsupported",
			Reasons: []string{"无法读取 main.js：" + err.Error()},
		}
	}
	src := string(raw)

	reqSet := map[string]bool{}
	for _, match := range requireCallRe.FindAllStringSubmatch(src, -1) {
		if len(match) < 2 {
			continue
		}
		mod := strings.TrimSpace(match[1])
		if mod == "" || strings.HasPrefix(mod, ".") || strings.HasPrefix(mod, "/") {
			continue
		}
		reqSet[mod] = true
	}
	var reqs []string
	for k := range reqSet {
		reqs = append(reqs, k)
	}
	sort.Strings(reqs)

	var reasons []string
	needsDesktop := false
	partial := false
	unsupported := false

	hasNativeAddon := false
	hasDesktopFS := false
	hasChildProc := false
	hasElectron := false
	hasCM6 := false

	for _, r := range reqs {
		norm := strings.TrimPrefix(r, "node:")
		switch {
		case norm == "obsidian" || norm == "path" || norm == "buffer" || norm == "url" ||
			norm == "crypto" || norm == "os" || norm == "process" || norm == "events" ||
			norm == "util" || norm == "querystring" || norm == "string_decoder" ||
			norm == "stream" || norm == "punycode" || norm == "zlib" || norm == "timers" ||
			norm == "assert" || norm == "moment" || norm == "lucide":
			// Provided by obsidian-shim / lightweight browser polyfills.
		case norm == "fs" || norm == "fs/promises":
			hasDesktopFS = true
		case norm == "child_process":
			hasChildProc = true
		case norm == "electron" || strings.HasPrefix(norm, "@electron/"):
			hasElectron = true
		case strings.HasPrefix(norm, "@codemirror/") || norm == "codemirror" || strings.HasPrefix(norm, "@lezer/"):
			hasCM6 = true
		case strings.HasSuffix(norm, ".node"):
			hasNativeAddon = true
		case norm == "http" || norm == "https" || norm == "net" || norm == "tls":
			partial = true
			reasons = append(reasons, fmt.Sprintf("直接引用 Node 网络模块 (%s)，非 requestUrl 请求可能受限", r))
		}
	}

	if hasNativeAddon {
		unsupported = true
		reasons = append(reasons, "依赖原生二进制扩展 (.node)，无法在 WebView 兼容层中加载")
	}

	if hasDesktopFS || hasChildProc {
		needsDesktop = true
		partial = true
		var caps []string
		if hasDesktopFS {
			caps = append(caps, "本地文件系统 (fs)")
		}
		if hasChildProc {
			caps = append(caps, "本地命令行工具 (child_process)")
		}
		reasons = append(reasons, "需要桌面本地权限："+strings.Join(caps, "、")+"（在插件卡片开启「信任本地权限」即可运行）")
	}

	if hasElectron {
		partial = true
		reasons = append(reasons, "引用 Electron API（剪贴板/外部打开等常用能力将自动桥接，部分原生窗体 API 不可用）")
	}

	// CodeMirror 6 extensions are supported natively via the live CM6 singleton bridge (#131).
	hasCM6Ext := hasCM6 || strings.Contains(src, "registerEditorExtension")

	if strings.Contains(src, "app.internalPlugins") {
		partial = true
		reasons = append(reasons, "访问 Obsidian 内部私有插件表 (internalPlugins)，相关联动可能降级")
	}

	if !hasDesktopFS && !hasChildProc && mf.IsDesktopOnly && !partial && !unsupported {
		// Desktop-only flag without hard desktop requires is typically fine via requestUrl/FileSystemAdapter.
		reasons = append(reasons, "声明为桌面端插件（已通过本地桥接提供 FileSystemAdapter 与跨域请求支持）")
	}

	level := "full"
	if unsupported {
		level = "unsupported"
	} else if partial {
		level = "partial"
	}
	return CompatReport{
		Level:        level,
		Reasons:      reasons,
		NeedsDesktop: needsDesktop,
		HasCM6:       hasCM6Ext,
		Requires:     reqs,
	}
}

// List returns all globally installed Obsidian plugins sorted by name.
func (m *Manager) List() []InstalledPlugin {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.loadStateLocked()
	entries, err := os.ReadDir(m.Dir)
	if err != nil {
		return []InstalledPlugin{}
	}
	out := make([]InstalledPlugin, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(m.Dir, e.Name())
		mf, err := ReadManifest(dir)
		if err != nil {
			continue
		}
		_, sErr := os.Stat(filepath.Join(dir, "styles.css"))
		_, dErr := os.Stat(filepath.Join(dir, "data.json"))
		out = append(out, InstalledPlugin{
			ID:             mf.ID,
			Manifest:       mf,
			Enabled:        st.Enabled[mf.ID],
			TrustedDesktop: isTrustedInState(st, mf.ID),
			LocalPorts:     st.LocalPorts[mf.ID],
			HasStyles:      sErr == nil,
			HasData:        dErr == nil,
			Install:        readInstallMeta(dir),
			Compat:         AnalyzeCompat(dir, mf),
			Dir:            dir,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Enabled != out[j].Enabled {
			return out[i].Enabled
		}
		return strings.ToLower(out[i].Manifest.Name) < strings.ToLower(out[j].Manifest.Name)
	})
	return out
}

// Get returns a single installed plugin by ID.
func (m *Manager) Get(id string) (InstalledPlugin, error) {
	if err := ValidatePluginID(id); err != nil {
		return InstalledPlugin{}, err
	}
	for _, p := range m.List() {
		if p.ID == id {
			return p, nil
		}
	}
	return InstalledPlugin{}, fmt.Errorf("未找到已安装的 Obsidian 插件：%s", id)
}

// SetPluginState updates enabled / trustedDesktop / localPorts flags for a plugin.
func (m *Manager) SetPluginState(id string, enabled *bool, trustedDesktop *bool, localPorts *[]int) (InstalledPlugin, error) {
	dir, err := m.pluginDir(id)
	if err != nil {
		return InstalledPlugin{}, err
	}
	if _, err := ReadManifest(dir); err != nil {
		return InstalledPlugin{}, fmt.Errorf("未找到已安装的插件 %s：%w", id, err)
	}
	m.mu.Lock()
	st := m.loadStateLocked()
	if enabled != nil {
		st.Enabled[id] = *enabled
	}
	if trustedDesktop != nil {
		st.TrustedDesktop[id] = *trustedDesktop
	}
	if localPorts != nil {
		clean := make([]int, 0, len(*localPorts))
		seen := map[int]bool{}
		for _, p := range *localPorts {
			if p >= 1 && p <= 65535 && !seen[p] {
				seen[p] = true
				clean = append(clean, p)
			}
		}
		sort.Ints(clean)
		if len(clean) == 0 {
			delete(st.LocalPorts, id)
		} else {
			st.LocalPorts[id] = clean
		}
	}
	err = m.saveStateLocked(st)
	m.mu.Unlock()
	if err != nil {
		return InstalledPlugin{}, err
	}
	return m.Get(id)
}

// isTrustedInState returns whether plugin id has local desktop fs/exec access.
// All installed plugins default to trusted unless explicitly revoked (false).
func isTrustedInState(st globalState, id string) bool {
	if v, ok := st.TrustedDesktop[id]; ok {
		return v
	}
	return true
}

// IsTrustedDesktop returns whether enabled plugin id is trusted for desktop fs/spawn access.
func (m *Manager) IsTrustedDesktop(id string) bool {
	if err := ValidatePluginID(id); err != nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.loadStateLocked()
	return st.Enabled[id] && isTrustedInState(st, id)
}

// AllowedLocalPorts returns the user-approved localhost ports for a plugin (plus standard PicGo default if allowed).
func (m *Manager) AllowedLocalPorts(id string) []int {
	if err := ValidatePluginID(id); err != nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.loadStateLocked()
	if !st.Enabled[id] {
		return nil
	}
	return append([]int(nil), st.LocalPorts[id]...)
}

// ReadData reads data.json for a plugin (returns null JSON if absent).
func (m *Manager) ReadData(id string) (json.RawMessage, error) {
	dir, err := m.pluginDir(id)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(dir, "data.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return json.RawMessage("null"), nil
		}
		return nil, err
	}
	if !json.Valid(b) {
		return json.RawMessage("null"), nil
	}
	return json.RawMessage(b), nil
}

// WriteData persists data.json for a plugin.
func (m *Manager) WriteData(id string, data json.RawMessage) error {
	dir, err := m.pluginDir(id)
	if err != nil {
		return err
	}
	if _, err := ReadManifest(dir); err != nil {
		return err
	}
	if len(data) == 0 {
		data = json.RawMessage("null")
	}
	if !json.Valid(data) {
		return errors.New("插件配置数据不是有效的 JSON")
	}
	var pretty any
	if err := json.Unmarshal(data, &pretty); err == nil {
		if b, mErr := json.MarshalIndent(pretty, "", "  "); mErr == nil {
			return os.WriteFile(filepath.Join(dir, "data.json"), b, 0o644)
		}
	}
	return os.WriteFile(filepath.Join(dir, "data.json"), data, 0o644)
}

// LoadBundle reads main.js, styles.css, and data.json for runtime execution in the sandbox host.
func (m *Manager) LoadBundle(id string) (PluginBundle, error) {
	dir, err := m.pluginDir(id)
	if err != nil {
		return PluginBundle{}, err
	}
	mf, err := ReadManifest(dir)
	if err != nil {
		return PluginBundle{}, err
	}
	mainBytes, err := os.ReadFile(filepath.Join(dir, "main.js"))
	if err != nil {
		return PluginBundle{}, fmt.Errorf("读取 main.js 失败：%w", err)
	}
	stylesBytes, _ := os.ReadFile(filepath.Join(dir, "styles.css"))
	dataRaw, _ := m.ReadData(id)

	m.mu.Lock()
	st := m.loadStateLocked()
	trusted := isTrustedInState(st, id)
	ports := append([]int(nil), st.LocalPorts[id]...)
	m.mu.Unlock()

	return PluginBundle{
		ID:             mf.ID,
		Manifest:       mf,
		MainJS:         string(mainBytes),
		StylesCSS:      string(stylesBytes),
		Data:           dataRaw,
		TrustedDesktop: trusted,
		LocalPorts:     ports,
	}, nil
}

// Uninstall removes an installed plugin directory and cleans its state entries.
func (m *Manager) Uninstall(id string) error {
	dir, err := m.pluginDir(id)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.loadStateLocked()
	delete(st.Enabled, id)
	delete(st.TrustedDesktop, id)
	delete(st.LocalPorts, id)
	return m.saveStateLocked(st)
}

// SecretStorage helpers (Obsidian 1.11+ app.secretStorage compatibility).
func (m *Manager) GetSecret(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return "", nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := os.ReadFile(m.secretsPath())
	if err != nil {
		return "", nil
	}
	var bag map[string]string
	if err := json.Unmarshal(b, &bag); err != nil {
		return "", nil
	}
	return bag[key], nil
}

func (m *Manager) SetSecret(key, val string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return errors.New("secret key 不能为空")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	bag := map[string]string{}
	if b, err := os.ReadFile(m.secretsPath()); err == nil {
		_ = json.Unmarshal(b, &bag)
	}
	if val == "" {
		delete(bag, key)
	} else {
		bag[key] = val
	}
	if err := os.MkdirAll(m.Dir, 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(bag, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.secretsPath(), out, 0o600)
}

// ListSecretKeys returns all stored secret names (values are never bulk-exported).
func (m *Manager) ListSecretKeys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := os.ReadFile(m.secretsPath())
	if err != nil {
		return []string{}
	}
	var bag map[string]string
	if err := json.Unmarshal(b, &bag); err != nil {
		return []string{}
	}
	keys := make([]string, 0, len(bag))
	for k := range bag {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// obsidianConfigPath resolves Obsidian desktop's global obsidian.json path.
func obsidianConfigPath() string {
	switch runtime.GOOS {
	case "windows":
		if v := os.Getenv("APPDATA"); v != "" {
			return filepath.Join(v, "obsidian", "obsidian.json")
		}
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "obsidian", "obsidian.json")
		}
	default:
		if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
			return filepath.Join(v, "obsidian", "obsidian.json")
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".config", "obsidian", "obsidian.json")
		}
	}
	return ""
}

func samePath(a, b string) bool {
	ca := filepath.Clean(strings.TrimSpace(a))
	cb := filepath.Clean(strings.TrimSpace(b))
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

// DiscoverObsidianVaults scans local Obsidian vaults (from OS obsidian.json,
// Handraw's configured article vault dirs, and optional custom directories) for
// installable plugins.
func (m *Manager) DiscoverObsidianVaults(articleVaultDirs []string, customDir string) []DiscoveredVault {
	installedMap := map[string]string{}
	for _, p := range m.List() {
		installedMap[p.ID] = p.Manifest.Version
	}

	type candidate struct {
		dir    string
		source string
	}
	var candidates []candidate
	addCand := func(dir, source string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		if abs, err := filepath.Abs(dir); err == nil {
			dir = abs
		}
		for _, c := range candidates {
			if samePath(c.dir, dir) {
				return
			}
		}
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			candidates = append(candidates, candidate{dir: dir, source: source})
		}
	}

	if strings.TrimSpace(customDir) != "" {
		addCand(customDir, "custom")
	}
	for _, d := range articleVaultDirs {
		addCand(d, "article-vault")
	}
	if cfgPath := obsidianConfigPath(); cfgPath != "" {
		if b, err := os.ReadFile(cfgPath); err == nil {
			var cfg struct {
				Vaults map[string]struct {
					Path string `json:"path"`
					TS   int64  `json:"ts"`
				} `json:"vaults"`
			}
			if err := json.Unmarshal(b, &cfg); err == nil {
				type vEntry struct {
					path string
					ts   int64
				}
				var vs []vEntry
				for _, v := range cfg.Vaults {
					if strings.TrimSpace(v.Path) != "" {
						vs = append(vs, vEntry{path: v.Path, ts: v.TS})
					}
				}
				sort.Slice(vs, func(i, j int) bool { return vs[i].ts > vs[j].ts })
				for _, v := range vs {
					addCand(v.path, "obsidian-config")
				}
			}
		}
	}

	var out []DiscoveredVault
	for _, c := range candidates {
		plugins := scanDirForObsidianPlugins(c.dir, installedMap)
		if len(plugins) == 0 && c.source != "custom" {
			continue
		}
		out = append(out, DiscoveredVault{
			Dir:     c.dir,
			Name:    filepath.Base(c.dir),
			Source:  c.source,
			Plugins: plugins,
		})
	}
	return out
}

func readEnabledSet(obsidianDir string) map[string]bool {
	out := map[string]bool{}
	b, err := os.ReadFile(filepath.Join(obsidianDir, "community-plugins.json"))
	if err != nil {
		return out
	}
	var ids []string
	if err := json.Unmarshal(b, &ids); err == nil {
		for _, id := range ids {
			out[id] = true
		}
	}
	return out
}

// scanDirForObsidianPlugins supports:
//   - a Vault root containing .obsidian/plugins/<id>/
//   - a .obsidian directory containing plugins/<id>/
//   - a plugins directory containing <id>/manifest.json
//   - a single plugin directory containing manifest.json directly
func scanDirForObsidianPlugins(rootDir string, installedMap map[string]string) []DiscoveredPlugin {
	vaultName := filepath.Base(rootDir)

	// Case 1: Single plugin folder directly.
	if mf, err := ReadManifest(rootDir); err == nil {
		_, dErr := os.Stat(filepath.Join(rootDir, "data.json"))
		instVer, ok := installedMap[mf.ID]
		return []DiscoveredPlugin{{
			ID:               mf.ID,
			Manifest:         mf,
			PluginDir:        rootDir,
			VaultDir:         rootDir,
			VaultName:        vaultName,
			HasData:          dErr == nil,
			AlreadyInstalled: ok,
			InstalledVersion: instVer,
			Compat:           AnalyzeCompat(rootDir, mf),
		}}
	}

	var pluginsRoot string
	var obsidianDir string
	if st, err := os.Stat(filepath.Join(rootDir, ".obsidian", "plugins")); err == nil && st.IsDir() {
		obsidianDir = filepath.Join(rootDir, ".obsidian")
		pluginsRoot = filepath.Join(obsidianDir, "plugins")
	} else if st, err := os.Stat(filepath.Join(rootDir, "plugins")); err == nil && st.IsDir() && strings.EqualFold(filepath.Base(rootDir), ".obsidian") {
		obsidianDir = rootDir
		pluginsRoot = filepath.Join(rootDir, "plugins")
	} else {
		// Treat rootDir itself as a plugins container folder.
		pluginsRoot = rootDir
	}

	enabledSet := map[string]bool{}
	if obsidianDir != "" {
		enabledSet = readEnabledSet(obsidianDir)
	}

	entries, err := os.ReadDir(pluginsRoot)
	if err != nil {
		return nil
	}
	var found []DiscoveredPlugin
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		pdir := filepath.Join(pluginsRoot, e.Name())
		mf, err := ReadManifest(pdir)
		if err != nil {
			continue
		}
		_, dErr := os.Stat(filepath.Join(pdir, "data.json"))
		instVer, ok := installedMap[mf.ID]
		found = append(found, DiscoveredPlugin{
			ID:                mf.ID,
			Manifest:          mf,
			PluginDir:         pdir,
			VaultDir:          rootDir,
			VaultName:         vaultName,
			HasData:           dErr == nil,
			EnabledInObsidian: enabledSet[mf.ID],
			AlreadyInstalled:  ok,
			InstalledVersion:  instVer,
			Compat:            AnalyzeCompat(pdir, mf),
		})
	}
	sort.Slice(found, func(i, j int) bool {
		return strings.ToLower(found[i].Manifest.Name) < strings.ToLower(found[j].Manifest.Name)
	})
	return found
}

// ImportLocalPlugin copies a local Obsidian plugin directory into Handraw's global directory.
// If copyData is true and source has data.json, it is copied as well; otherwise any
// previously saved global data.json for that plugin is preserved.
func (m *Manager) ImportLocalPlugin(pluginDir string, copyData bool, sourceType string) (InstalledPlugin, error) {
	p := strings.TrimSpace(strings.Trim(pluginDir, `"'`))
	if p == "" {
		return InstalledPlugin{}, errors.New("请指定本地插件目录路径")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return InstalledPlugin{}, fmt.Errorf("无效的插件目录：%w", err)
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return InstalledPlugin{}, fmt.Errorf("找不到插件目录：%s", abs)
	}
	mf, err := ReadManifest(abs)
	if err != nil {
		return InstalledPlugin{}, err
	}
	if sourceType == "" {
		sourceType = "local"
	}

	dstDir, err := m.pluginDir(mf.ID)
	if err != nil {
		return InstalledPlugin{}, err
	}
	var existingData []byte
	if !copyData {
		existingData, _ = os.ReadFile(filepath.Join(dstDir, "data.json"))
	}

	tmpDir, err := os.MkdirTemp(m.Dir, ".tmp-obs-*")
	if err != nil {
		return InstalledPlugin{}, err
	}
	defer os.RemoveAll(tmpDir)

	var total int64
	err = filepath.WalkDir(abs, func(cur string, d os.DirEntry, wErr error) error {
		if wErr != nil {
			return wErr
		}
		rel, rErr := filepath.Rel(abs, cur)
		if rErr != nil {
			return rErr
		}
		if rel == "." {
			return nil
		}
		base := d.Name()
		if d.IsDir() {
			low := strings.ToLower(base)
			if low == ".git" || low == "node_modules" || low == ".github" {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(tmpDir, rel), 0o755)
		}
		if base == ".handraw-install.json" || (!copyData && base == "data.json") {
			return nil
		}
		info, iErr := d.Info()
		if iErr != nil {
			return iErr
		}
		if info.Size() > maxPluginFileBytes {
			return nil // skip oversized unrelated artifacts
		}
		total += info.Size()
		if total > maxTotalPluginBytes {
			return errors.New("插件目录体积超过 64MB 限制")
		}
		return copyFile(cur, filepath.Join(tmpDir, rel))
	})
	if err != nil {
		return InstalledPlugin{}, err
	}
	if len(existingData) > 0 {
		_ = os.WriteFile(filepath.Join(tmpDir, "data.json"), existingData, 0o644)
	}
	now := time.Now().UnixMilli()
	prevMeta := readInstallMeta(dstDir)
	instAt := now
	if prevMeta != nil && prevMeta.InstalledAt > 0 {
		instAt = prevMeta.InstalledAt
	}
	writeInstallMeta(tmpDir, InstallMeta{
		SourceType:  sourceType,
		Source:      abs,
		InstalledAt: instAt,
		UpdatedAt:   now,
	})

	if err := replaceDir(tmpDir, dstDir); err != nil {
		return InstalledPlugin{}, err
	}
	return m.Get(mf.ID)
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, cErr := io.Copy(out, io.LimitReader(in, maxPluginFileBytes+1))
	closeErr := out.Close()
	if cErr != nil {
		return cErr
	}
	return closeErr
}

func replaceDir(srcTmp, dst string) error {
	backup := dst + ".bak-" + fmt.Sprintf("%d", time.Now().UnixNano())
	hadOld := false
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, backup); err != nil {
			return err
		}
		hadOld = true
	}
	if err := os.Rename(srcTmp, dst); err != nil {
		if hadOld {
			_ = os.Rename(backup, dst)
		}
		return err
	}
	if hadOld {
		_ = os.RemoveAll(backup)
	}
	return nil
}
