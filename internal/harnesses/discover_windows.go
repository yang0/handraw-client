//go:build windows

package harnesses

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows/registry"
)

var winLoginCache struct {
	sync.Mutex
	dirs []string
	at   time.Time
}

func resetLoginPathCache() {
	winLoginCache.Lock()
	winLoginCache.dirs = nil
	winLoginCache.at = time.Time{}
	winLoginCache.Unlock()
}

// loginPathDirs reads the live Windows Machine + User PATH from the registry
// (expanding %VAR% entries via registry.ExpandString), mirroring Magpie's
// proc.LoginPath so GUI launches see CLIs installed after the app started.
func loginPathDirs() []string {
	winLoginCache.Lock()
	if winLoginCache.dirs != nil && time.Since(winLoginCache.at) < 30*time.Second {
		out := append([]string(nil), winLoginCache.dirs...)
		winLoginCache.Unlock()
		return out
	}
	winLoginCache.Unlock()

	var dirs []string
	for _, k := range []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`},
		{registry.CURRENT_USER, `Environment`},
	} {
		key, err := registry.OpenKey(k.root, k.path, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		if v, _, err := key.GetStringValue("Path"); err == nil {
			if expanded, err := registry.ExpandString(v); err == nil {
				v = expanded
			}
			for _, d := range strings.Split(v, ";") {
				if d = strings.TrimSpace(d); d != "" {
					dirs = append(dirs, d)
				}
			}
		}
		_ = key.Close()
	}

	winLoginCache.Lock()
	winLoginCache.dirs = dirs
	winLoginCache.at = time.Now()
	winLoginCache.Unlock()
	return dirs
}

// platformToolDirs lists Windows user/package-manager/version-manager binary
// directories in Magpie's lookup order.
func platformToolDirs() []searchDir {
	home, _ := os.UserHomeDir()
	localApp := os.Getenv("LOCALAPPDATA")
	appData := os.Getenv("APPDATA")
	if appData == "" && home != "" {
		appData = filepath.Join(home, "AppData", "Roaming")
	}
	if localApp == "" && home != "" {
		localApp = filepath.Join(home, "AppData", "Local")
	}

	var out []searchDir
	addIfDir := func(d, source string) {
		if d == "" || !filepath.IsAbs(d) {
			return
		}
		if isDirPath(d) {
			out = append(out, searchDir{dir: d, source: source})
		}
	}

	// npm custom prefix (~/.npmrc) & default %APPDATA%\npm
	addIfDir(npmPrefixDir(home), "npm 全局目录")
	addIfDir(filepath.Join(appData, "npm"), "npm 全局目录")

	// Standalone user binaries (~/.local/bin)
	if home != "" {
		addIfDir(filepath.Join(home, ".local", "bin"), "用户本地目录")
	}

	// Bun (%BUN_INSTALL%\bin & ~\.bun\bin)
	addIfDir(bunBinDir(), "Bun 全局目录")
	if home != "" {
		addIfDir(filepath.Join(home, ".bun", "bin"), "Bun 全局目录")
	}

	// Volta & pnpm
	addIfDir(filepath.Join(localApp, "Volta", "bin"), "Volta")
	if d := strings.TrimSpace(os.Getenv("PNPM_HOME")); filepath.IsAbs(d) {
		addIfDir(d, "pnpm")
	}
	addIfDir(filepath.Join(localApp, "pnpm"), "pnpm")

	// mise shims
	mise := filepath.Join(localApp, "mise")
	if d := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); filepath.IsAbs(d) {
		mise = filepath.Join(d, "mise")
	}
	if d := strings.TrimSpace(os.Getenv("MISE_DATA_DIR")); filepath.IsAbs(d) {
		mise = d
	}
	addIfDir(filepath.Join(mise, "shims"), "mise")

	// fnm (default alias first, then newest node versions)
	for _, root := range fnmWinRoots(home, appData, os.Getenv("FNM_DIR")) {
		for _, binDir := range fnmWinBins(root) {
			addIfDir(binDir, "fnm")
		}
	}

	// nvm-windows
	if d := strings.TrimSpace(os.Getenv("NVM_SYMLINK")); filepath.IsAbs(d) {
		addIfDir(d, "nvm")
	}
	if nvmHome := strings.TrimSpace(os.Getenv("NVM_HOME")); filepath.IsAbs(nvmHome) {
		for _, d := range nodeVersionDirs(nvmHome, "") {
			addIfDir(d, "nvm")
		}
	}

	// Scoop, WinGet, Chocolatey
	if scoop := strings.TrimSpace(os.Getenv("SCOOP")); filepath.IsAbs(scoop) {
		addIfDir(filepath.Join(scoop, "shims"), "Scoop")
	}
	if home != "" {
		addIfDir(filepath.Join(home, "scoop", "shims"), "Scoop")
	}
	addIfDir(filepath.Join(localApp, "Microsoft", "WinGet", "Links"), "WinGet")
	if !isIsolated() {
		addIfDir(`C:\ProgramData\chocolatey\bin`, "Chocolatey")
	}

	// Cargo, Go, uv/Python user scripts
	if home != "" {
		addIfDir(filepath.Join(home, ".cargo", "bin"), "Cargo")
		addIfDir(filepath.Join(home, "go", "bin"), "Go")
	}
	if gopath := strings.TrimSpace(os.Getenv("GOPATH")); filepath.IsAbs(gopath) {
		addIfDir(filepath.Join(gopath, "bin"), "Go")
	}
	return out
}

func fnmWinRoots(home, appData, fnmDir string) []string {
	var roots []string
	if filepath.IsAbs(fnmDir) {
		roots = append(roots, fnmDir)
	}
	if filepath.IsAbs(appData) {
		roots = append(roots, filepath.Join(appData, "fnm"))
	}
	if filepath.IsAbs(home) {
		roots = append(roots,
			filepath.Join(home, "AppData", "Roaming", "fnm"),
			filepath.Join(home, ".fnm"),
		)
	}
	var have []string
	for _, r := range roots {
		if isDirPath(r) && !slices.ContainsFunc(have, func(h string) bool { return strings.EqualFold(h, r) }) {
			have = append(have, r)
		}
	}
	return have
}

func fnmWinBins(dir string) []string {
	var bins []string
	if def := filepath.Join(dir, "aliases", "default"); isDirPath(def) {
		bins = append(bins, def)
	}
	root := filepath.Join(dir, "node-versions")
	bins = append(bins, nodeVersionDirs(root, "installation")...)
	return bins
}

// toolInDir resolves a Windows executable in dir: prefers .exe, then .cmd,
// then .bat, and finally parses an extensionless npm sh-shim (npmShimExe).
// Never returns a bare extensionless file on Windows (CreateProcess rejects it).
func toolInDir(dir, name string) string {
	if dir == "" || name == "" {
		return ""
	}
	if filepath.Ext(name) != "" {
		cand := filepath.Join(dir, name)
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand
		}
		return ""
	}
	for _, ext := range []string{".exe", ".cmd", ".bat"} {
		cand := filepath.Join(dir, name+ext)
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand
		}
	}
	if exe := npmShimExe(filepath.Join(dir, name)); exe != "" {
		return exe
	}
	return ""
}
