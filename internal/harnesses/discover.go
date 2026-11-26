package harnesses

import (
	"bytes"
	"context"
	"debug/buildinfo"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// searchDir pairs a directory to probe with a user-facing label explaining
// where the binary was discovered (mirroring Magpie's proc/find architecture).
type searchDir struct {
	dir    string
	source string
}

// lookupResult records the primary resolved executable path, its discovery
// source label, and all distinct installations discovered across PATH and
// package-manager/native directories.
type lookupResult struct {
	Path       string
	Source     string
	Candidates []string
}

const (
	lookFresh  = 2 * time.Second
	lookSettle = 100 * time.Millisecond
	wrapperMax = 8 << 10
)

var (
	// testSandbox disables host registry/shell/system-dir probes during unit tests
	// when set (via env HANDRAW_HARNESS_TEST_ISOLATE or in-process helper).
	testSandboxMu sync.RWMutex
	testSandbox   bool

	lookCache struct {
		sync.Mutex
		gen     int
		env     string
		stamp   string
		checked time.Time
		m       map[string]lookupResult
	}
)

func isIsolated() bool {
	if os.Getenv("HANDRAW_HARNESS_TEST_ISOLATE") != "" {
		return true
	}
	testSandboxMu.RLock()
	v := testSandbox
	testSandboxMu.RUnlock()
	return v
}

// Rescan clears all cached executable, PATH, and login-shell discovery state so
// the next Discover/Find call re-probes the local machine immediately.
func Rescan() {
	lookCache.Lock()
	lookCache.m = nil
	lookCache.env = ""
	lookCache.stamp = ""
	lookCache.checked = time.Time{}
	lookCache.gen++
	lookCache.Unlock()
	resetLoginPathCache()
}

// resolveBinaryRich resolves an explicit command override or candidate binary
// names across process PATH, live OS registry/login-shell PATH, package/version
// managers, and per-harness native install directories.
func resolveBinaryRich(customCmd string, candidates []string, extraDirs []string, reject func(string) bool) lookupResult {
	customCmd = strings.TrimSpace(customCmd)
	if customCmd != "" {
		p := lookupExplicitOrAny(customCmd, extraDirs, reject)
		if p.Path != "" {
			if p.Source == "" {
				p.Source = "手动配置"
			}
			return p
		}
		return lookupResult{}
	}

	var first lookupResult
	seenReal := map[string]bool{}
	var allCands []string

	for _, name := range candidates {
		res := findToolCached(name, extraDirs, reject)
		for _, c := range res.Candidates {
			rk := realPathKey(c)
			if !seenReal[rk] {
				seenReal[rk] = true
				allCands = append(allCands, c)
			}
		}
		if first.Path == "" && res.Path != "" {
			first = res
		}
	}
	if first.Path == "" {
		return lookupResult{}
	}
	if len(allCands) > 1 {
		first.Candidates = allCands
	} else {
		first.Candidates = nil
	}
	return first
}

func lookupExplicitOrAny(name string, extraDirs []string, reject func(string) bool) lookupResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return lookupResult{}
	}
	if filepath.IsAbs(name) || strings.ContainsAny(name, `/\`) {
		if p := resolveDirectPath(name); p != "" {
			return lookupResult{Path: p, Source: "手动配置", Candidates: []string{p}}
		}
		return lookupResult{}
	}
	res := findToolCached(name, extraDirs, reject)
	if res.Path != "" {
		res.Source = "手动配置 (" + res.Source + ")"
	}
	return res
}

func resolveDirectPath(name string) string {
	if st, err := os.Stat(name); err == nil && !st.IsDir() {
		if runtime.GOOS != "windows" || filepath.Ext(name) != "" {
			if abs, err := filepath.Abs(name); err == nil {
				return abs
			}
			return name
		}
		// On Windows, if a path has no extension, try executable extensions first
		// and fall back to npm sh-shim parsing (never return a raw extensionless sh file).
		if p := npmShimExe(name); p != "" {
			return p
		}
	}
	if runtime.GOOS == "windows" && filepath.Ext(name) == "" {
		for _, ext := range []string{".exe", ".cmd", ".bat"} {
			cand := name + ext
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				if abs, err := filepath.Abs(cand); err == nil {
					return abs
				}
				return cand
			}
		}
	}
	return ""
}

func findToolCached(name string, extraDirs []string, reject func(string) bool) lookupResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return lookupResult{}
	}
	// Cache key includes name + extraDirs + reject pointer identity (via bool/nil).
	// When reject != nil or extraDirs is non-empty, key uniquely by extraDirs joined.
	key := name + "\x00" + strings.Join(extraDirs, "\x01")
	if reject != nil {
		key += "\x00filtered"
	}

	useCache := !isIsolated() && reject == nil
	if useCache {
		env := os.Getenv("PATH") + "\x00" + os.Getenv("PATHEXT")
		lookCache.Lock()
		if lookCache.env != env || lookCache.checked.IsZero() || time.Since(lookCache.checked) >= lookFresh {
			lookCache.Unlock()
			stamp, settled := buildLookStamp(extraDirs)
			lookCache.Lock()
			if !settled {
				stamp = ""
			}
			if stamp != lookCache.stamp || stamp == "" {
				lookCache.m = nil
				lookCache.stamp = stamp
			}
			lookCache.env = env
			lookCache.checked = time.Now()
			if !settled {
				lookCache.checked = time.Time{}
			}
		}
		if res, ok := lookCache.m[key]; ok {
			lookCache.Unlock()
			return res
		}
		gen, stamp := lookCache.gen, lookCache.stamp
		lookCache.Unlock()

		res := findToolUncached(name, extraDirs, reject)

		lookCache.Lock()
		if lookCache.gen == gen && lookCache.stamp == stamp && stamp != "" {
			if lookCache.m == nil {
				lookCache.m = map[string]lookupResult{}
			}
			lookCache.m[key] = res
		}
		lookCache.Unlock()
		return res
	}
	return findToolUncached(name, extraDirs, reject)
}

func buildLookStamp(extraDirs []string) (string, bool) {
	now := time.Now()
	settled := true
	var b strings.Builder
	b.WriteString(os.Getenv("PATH"))
	b.WriteByte(0)
	b.WriteString(os.Getenv("PATHEXT"))

	seen := map[string]bool{}
	dirs := collectAllSearchDirs(extraDirs)
	for _, sd := range dirs {
		d := sd.dir
		if d == "" || seen[d] {
			continue
		}
		seen[d] = true
		b.WriteByte(0)
		b.WriteString(d)
		if st, err := os.Stat(d); err == nil {
			b.WriteByte('@')
			b.WriteString(strconv.FormatInt(st.ModTime().UnixNano(), 36))
			if delta := now.Sub(st.ModTime()); delta >= 0 && delta < lookSettle {
				settled = false
			}
		}
	}
	return b.String(), settled
}

func collectAllSearchDirs(extraDirs []string) []searchDir {
	var out []searchDir
	seen := map[string]bool{}
	add := func(dir, source string) {
		dir = strings.TrimSpace(dir)
		if dir == "" || dir == "." {
			return
		}
		cleaned := filepath.Clean(dir)
		key := cleaned
		if runtime.GOOS == "windows" {
			key = strings.ToLower(cleaned)
		}
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, searchDir{dir: cleaned, source: source})
	}

	// 1. Current process PATH.
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		add(d, "PATH")
	}
	// 2. Live OS login / registry PATH (catches installs done after GUI launch).
	if !isIsolated() {
		loginLabel := "登录 Shell PATH"
		if runtime.GOOS == "windows" {
			loginLabel = "系统注册表 PATH"
		}
		for _, d := range loginPathDirs() {
			add(d, loginLabel)
		}
	}
	// 3. Package managers, version managers, and standard user tool directories.
	for _, sd := range platformToolDirs() {
		add(sd.dir, sd.source)
	}
	// 4. Per-harness native installation directories.
	for _, d := range extraDirs {
		add(d, "官方默认目录")
	}
	return out
}

func findToolUncached(name string, extraDirs []string, reject func(string) bool) lookupResult {
	var firstPath, firstSource string
	var candidates []string
	seenReal := map[string]bool{}

	for _, sd := range collectAllSearchDirs(extraDirs) {
		p := toolInDir(sd.dir, name)
		if p == "" {
			continue
		}
		p = unwrapMiseWrapper(name, p)
		if p == "" {
			continue
		}
		if reject != nil && reject(p) {
			continue
		}
		rk := realPathKey(p)
		if seenReal[rk] {
			continue
		}
		seenReal[rk] = true
		candidates = append(candidates, p)
		if firstPath == "" {
			firstPath = p
			firstSource = sd.source
		}
	}
	if firstPath == "" {
		return lookupResult{}
	}
	return lookupResult{
		Path:       firstPath,
		Source:     firstSource,
		Candidates: candidates,
	}
}

func realPathKey(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil && r != "" {
		p = r
	}
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

// npmPrefixDir reads custom `prefix=...` from ~/.npmrc. On Windows npm places
// global shims directly inside prefix; on Unix it places them in prefix/bin.
func npmPrefixDir(home string) string {
	if home == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(home, ".npmrc"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != "prefix" {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if strings.HasPrefix(v, "~/") || strings.HasPrefix(v, `~\`) {
			v = filepath.Join(home, v[2:])
		}
		if !filepath.IsAbs(v) {
			continue
		}
		if runtime.GOOS == "windows" {
			return v
		}
		return filepath.Join(v, "bin")
	}
	return ""
}

// bunBinDir returns $BUN_INSTALL/bin when BUN_INSTALL is set to an absolute path.
func bunBinDir() string {
	if d := strings.TrimSpace(os.Getenv("BUN_INSTALL")); filepath.IsAbs(d) {
		return filepath.Join(d, "bin")
	}
	return ""
}

// nodeVersionDirs lists version subdirectories under root containing binSub
// (or the version dir itself when binSub == ""), sorted highest semver first.
func nodeVersionDirs(root, binSub string) []string {
	es, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range es {
		target := filepath.Join(root, e.Name())
		if binSub != "" {
			target = filepath.Join(target, binSub)
		}
		if isDirPath(target) {
			names = append(names, e.Name())
		}
	}
	slices.SortStableFunc(names, func(a, b string) int {
		switch {
		case nodeVersionLess(b, a):
			return -1
		case nodeVersionLess(a, b):
			return 1
		}
		return strings.Compare(a, b)
	})
	out := make([]string, 0, len(names))
	for _, n := range names {
		if binSub != "" {
			out = append(out, filepath.Join(root, n, binSub))
		} else {
			out = append(out, filepath.Join(root, n))
		}
	}
	return out
}

func parseNodeVersion(s string) ([3]int, bool) {
	var v [3]int
	parts := strings.Split(strings.TrimPrefix(s, "v"), ".")
	if len(parts) > 3 || parts[0] == "" {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return v, false
		}
		v[i] = n
	}
	return v, true
}

func nodeVersionLess(a, b string) bool {
	va, oka := parseNodeVersion(a)
	vb, okb := parseNodeVersion(b)
	if oka != okb {
		return okb
	}
	return oka && slices.Compare(va[:], vb[:]) < 0
}

func isDirPath(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// npmShimLine matches npm's Unix-style cmd-shim line that delegates directly
// to a Windows .exe inside node_modules (Magpie proc/find.go).
var npmShimLine = regexp.MustCompile(`(?m)^\s*exec "\$basedir/([^"$]+\.exe)"\s+"\$@"`)

// npmShimExe extracts the real Windows .exe referenced by an extensionless npm
// sh-shim when a partial npm install left only the sh shim behind.
func npmShimExe(path string) string {
	st, err := os.Stat(path)
	if err != nil || st.IsDir() || st.Size() > wrapperMax {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	m := npmShimLine.FindSubmatch(b)
	if m == nil {
		return ""
	}
	rel := filepath.FromSlash(string(m[1]))
	if !filepath.IsLocal(rel) {
		return ""
	}
	exe := filepath.Join(filepath.Dir(path), rel)
	if st, err := os.Stat(exe); err != nil || st.IsDir() {
		return ""
	}
	return exe
}

// ---- Collision guards (binNot) inspired by Magpie --------------------------

var (
	goBuildInfoMagic = []byte("\xff Go buildinf:")
	goBinCache       struct {
		sync.Mutex
		m map[goBinKey]bool
	}
)

type goBinKey struct {
	path string
	size int64
	mod  time.Time
}

// isGoBinary reports whether bin is a Go-compiled binary (used to reject Go's
// pressly/goose SQL migration CLI when probing for Block's Rust goose CLI).
func isGoBinary(bin string) bool {
	st, err := os.Stat(bin)
	if err != nil || st.IsDir() {
		return false
	}
	key := goBinKey{bin, st.Size(), st.ModTime()}
	goBinCache.Lock()
	if v, ok := goBinCache.m[key]; ok {
		goBinCache.Unlock()
		return v
	}
	goBinCache.Unlock()

	is := hasGoMagic(bin)
	if is {
		_, err = buildinfo.ReadFile(bin)
		is = err == nil
	}

	goBinCache.Lock()
	if goBinCache.m == nil {
		goBinCache.m = map[goBinKey]bool{}
	}
	goBinCache.m[key] = is
	goBinCache.Unlock()
	return is
}

// hasGoMagic streams through bin with a small 256 KiB buffer so probing large
// non-Go binaries (e.g. Block's 260 MB Rust goose) never spikes heap usage.
func hasGoMagic(bin string) bool {
	f, err := os.Open(bin)
	if err != nil {
		return false
	}
	defer f.Close()
	n := len(goBuildInfoMagic)
	buf := make([]byte, 256<<10)
	kept := 0
	for {
		m, err := io.ReadFull(f, buf[kept:])
		if bytes.Contains(buf[:kept+m], goBuildInfoMagic) {
			return true
		}
		if err != nil {
			return false
		}
		kept = n - 1
		copy(buf, buf[len(buf)-kept:])
	}
}

// isEditorCopilotShim rejects IDE-bundled copilot launcher shims (such as VS
// Code's `Microsoft VS Code\bin\copilot-shim\copilot.EXE`) so they are not
// mistaken for the standalone GitHub Copilot CLI (Magpie #3269).
func isEditorCopilotShim(bin string) bool {
	s := normPathLower(bin)
	if real, err := filepath.EvalSymlinks(bin); err == nil && real != "" {
		s += "\x00" + normPathLower(real)
	}
	for _, pat := range []string{
		"/copilot-shim/",
		"/microsoft vs code/",
		"/microsoft vs code insiders/",
		"/visual studio code.app/",
		"/visual studio code - insiders.app/",
	} {
		if strings.Contains(s, pat) {
			return true
		}
	}
	return false
}

// isNonGrokBuildBinary rejects Homebrew's classic regex `grok` formula while
// keeping Grok Build (`~/.grok/bin/grok`, `Caskroom/grok-build`, etc.).
func isNonGrokBuildBinary(bin string) bool {
	s := normPathLower(bin)
	if real, err := filepath.EvalSymlinks(bin); err == nil && real != "" {
		s = normPathLower(real)
	}
	if strings.Contains(s, "/.grok/") || strings.Contains(s, "grok-build") {
		return false
	}
	if strings.Contains(s, "/cellar/grok/") || s == "/usr/bin/grok" || s == "/bin/grok" {
		return true
	}
	return false
}

// isNonCursorAgentBinary prevents `~/.grok/bin/agent.exe` or unrelated `agent`
// commands from being misidentified as Cursor CLI.
func isNonCursorAgentBinary(bin string) bool {
	base := strings.ToLower(filepath.Base(bin))
	if strings.HasPrefix(base, "cursor-agent") {
		return false
	}
	s := normPathLower(bin)
	if real, err := filepath.EvalSymlinks(bin); err == nil && real != "" {
		s += "\x00" + normPathLower(real)
	}
	return !strings.Contains(s, "cursor")
}

// ---- Config directory detection (agentDir + leftover + Taken) --------------

var leftoverDirNames = map[string]bool{
	"logs":        true,
	"log":         true,
	"debug":       true,
	"diagnostics": true,
	"cache":       true,
	"tmp":         true,
	"temp":        true,
}

var ignoredConfigFiles = map[string]bool{
	".ds_store":   true,
	"desktop.ini": true,
	"thumbs.db":   true,
}

// detectConfigDir checks env-override paths and default config directories
// using Magpie's agentDir heuristic: ignores empty folders, skill-installer
// shells (`skills/`), and post-uninstall leftovers (`logs/`, `diagnostics/`,
// `cache/`, `debug/`).
func detectConfigDir(relDirs []string, envVars []string) (string, bool) {
	home, _ := os.UserHomeDir()
	var candidates []string
	for _, ev := range envVars {
		if v := strings.TrimSpace(os.Getenv(ev)); v != "" {
			candidates = append(candidates, v)
		}
	}
	if home != "" {
		for _, rel := range relDirs {
			rel = strings.TrimSpace(rel)
			if rel == "" {
				continue
			}
			if filepath.IsAbs(rel) {
				candidates = append(candidates, rel)
			} else {
				candidates = append(candidates, filepath.Join(home, filepath.FromSlash(rel)))
			}
		}
	}
	for _, dir := range candidates {
		if isGenuineAgentConfigDir(dir) {
			return dir, true
		}
	}
	return "", false
}

// takenPath reports whether p or any of its ancestors is an existing non-directory
// file (so the harness could not have created a config directory there).
func takenPath(p string) bool {
	for d := filepath.Clean(p); ; {
		if st, err := os.Stat(d); err == nil {
			return !st.IsDir()
		}
		up := filepath.Dir(d)
		if up == d {
			return false
		}
		d = up
	}
}

func isGenuineAgentConfigDir(p string) bool {
	if p == "" || takenPath(p) {
		return false
	}
	es, err := os.ReadDir(p)
	if err != nil || len(es) == 0 {
		return false
	}
	for _, e := range es {
		low := strings.ToLower(e.Name())
		if low == "skills" || ignoredConfigFiles[low] {
			continue
		}
		if e.IsDir() && leftoverDirNames[low] {
			continue
		}
		return true
	}
	return false
}

// ---- Unix mise wrapper unwrapping (no-op on Windows) -----------------------

func unwrapMiseWrapper(name, path string) string {
	if runtime.GOOS == "windows" || path == "" {
		return path
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() || st.Size() > wrapperMax {
		return path
	}
	b, err := os.ReadFile(path)
	if err != nil || !bytes.HasPrefix(b, []byte("#!")) || bytes.IndexByte(b, 0) >= 0 {
		return path
	}
	miseBin, ok := parseMiseWrapperCmd(b, name)
	if !ok {
		return path
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, miseBin, "which", name)
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		cmd.Dir = home
	}
	out, err := cmd.Output()
	if err != nil {
		return path
	}
	real := strings.TrimSpace(string(out))
	if i := strings.IndexByte(real, '\n'); i >= 0 {
		real = strings.TrimSpace(real[:i])
	}
	if !filepath.IsAbs(real) {
		return path
	}
	rst, err := os.Stat(real)
	if err != nil || rst.IsDir() || (rst.Mode()&0o111) == 0 {
		return path
	}
	if os.SameFile(st, rst) {
		return path
	}
	return real
}

func parseMiseWrapperCmd(b []byte, name string) (string, bool) {
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) > 0 && f[0] == "exec" {
			f = f[1:]
		}
		if len(f) < 4 {
			continue
		}
		base := filepath.Base(strings.Trim(f[0], `"'`))
		if base != "mise" && base != "rtx" {
			continue
		}
		if f[1] != "x" && f[1] != "exec" {
			continue
		}
		for i := 2; i < len(f)-1; i++ {
			if f[i] == "--" && strings.Trim(f[i+1], `"'`) == name {
				return strings.Trim(f[0], `"'`), true
			}
		}
	}
	return "", false
}

// normPathLower lowercases a path and uses forward slashes regardless of the
// host OS, so Windows-style paths match the same patterns everywhere (#167).
func normPathLower(p string) string {
	return strings.ToLower(strings.ReplaceAll(p, `\`, "/"))
}
