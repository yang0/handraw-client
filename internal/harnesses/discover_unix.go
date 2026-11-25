//go:build !windows

package harnesses

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

var unixLoginCache struct {
	sync.Mutex
	dirs []string
	at   time.Time
}

func resetLoginPathCache() {
	unixLoginCache.Lock()
	unixLoginCache.dirs = nil
	unixLoginCache.at = time.Time{}
	unixLoginCache.Unlock()
}

// loginPathDirs asks the user's login shell (and fish/nu when configured) for
// its PATH, mirroring Magpie's proc/path_other.go so macOS .app / Linux desktop
// launches discover CLIs added in .zshrc / .bashrc / config.fish.
func loginPathDirs() []string {
	unixLoginCache.Lock()
	if unixLoginCache.dirs != nil && time.Since(unixLoginCache.at) < time.Minute {
		out := append([]string(nil), unixLoginCache.dirs...)
		unixLoginCache.Unlock()
		return out
	}
	unixLoginCache.Unlock()

	sh := os.Getenv("SHELL")
	if sh == "" || !filepath.IsAbs(sh) {
		sh = "/bin/zsh"
		if _, err := os.Stat(sh); err != nil {
			sh = "/bin/sh"
		}
	}
	shells := []string{sh}
	for _, extra := range extraConfiguredShells(sh) {
		shells = append(shells, extra)
	}

	var dirs []string
	seen := map[string]bool{}
	for _, s := range shells {
		for _, d := range probeShellPath(s) {
			if d != "" && filepath.IsAbs(d) && !seen[d] {
				seen[d] = true
				dirs = append(dirs, d)
			}
		}
	}

	unixLoginCache.Lock()
	unixLoginCache.dirs = dirs
	unixLoginCache.at = time.Now()
	unixLoginCache.Unlock()
	return dirs
}

func extraConfiguredShells(primary string) []string {
	home, _ := os.UserHomeDir()
	if home == "" {
		return nil
	}
	cfg := os.Getenv("XDG_CONFIG_HOME")
	if !filepath.IsAbs(cfg) {
		cfg = filepath.Join(home, ".config")
	}
	var out []string
	if filepath.Base(primary) != "fish" && isDirPath(filepath.Join(cfg, "fish")) {
		if p := findShellBinary("fish"); p != "" {
			out = append(out, p)
		}
	}
	if filepath.Base(primary) != "nu" && (isDirPath(filepath.Join(cfg, "nushell")) || isDirPath(filepath.Join(home, "Library", "Application Support", "nushell"))) {
		if p := findShellBinary("nu"); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func findShellBinary(name string) string {
	for _, d := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"} {
		cand := filepath.Join(d, name)
		if st, err := os.Stat(cand); err == nil && !st.IsDir() && (st.Mode()&0o111) != 0 {
			return cand
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return ""
}

func probeShellPath(shellPath string) []string {
	base := filepath.Base(shellPath)
	const marker = "__HANDRAW_PATH__="
	var args []string
	switch base {
	case "fish":
		args = []string{"-l", "-c", "printf '" + marker + "%s\\n' (string join : $PATH)"}
	case "nu":
		args = []string{"-l", "-c", "print ('" + marker + "' + ($env.PATH | str join ':'))"}
	default:
		args = []string{"-l", "-c", "printf '" + marker + "%s\\n' \"$PATH\""}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shellPath, args...)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(out), "\n") {
		if idx := strings.Index(line, marker); idx >= 0 {
			val := strings.TrimSpace(line[idx+len(marker):])
			return filepath.SplitList(val)
		}
	}
	return nil
}

// platformToolDirs lists macOS/Linux package-manager and version-manager
// binary directories in Magpie's lookup order.
func platformToolDirs() []searchDir {
	home, _ := os.UserHomeDir()
	var out []searchDir
	addIfDir := func(d, source string) {
		if d == "" || !filepath.IsAbs(d) {
			return
		}
		if isDirPath(d) {
			out = append(out, searchDir{dir: d, source: source})
		}
	}

	if home != "" {
		addIfDir(filepath.Join(home, ".local", "bin"), "用户本地目录")
		addIfDir(npmPrefixDir(home), "npm 全局目录")
		addIfDir(filepath.Join(home, ".npm-global", "bin"), "npm 全局目录")
		addIfDir(filepath.Join(home, ".npm", "bin"), "npm 全局目录")
		addIfDir(bunBinDir(), "Bun 全局目录")
		addIfDir(filepath.Join(home, ".bun", "bin"), "Bun 全局目录")
		addIfDir(filepath.Join(home, ".volta", "bin"), "Volta")
		if d := strings.TrimSpace(os.Getenv("PNPM_HOME")); filepath.IsAbs(d) {
			addIfDir(d, "pnpm")
		}
		addIfDir(filepath.Join(home, "Library", "pnpm"), "pnpm")
		addIfDir(filepath.Join(home, ".local", "share", "pnpm"), "pnpm")
		addIfDir(filepath.Join(home, ".asdf", "shims"), "asdf")
		addIfDir(filepath.Join(home, ".local", "share", "mise", "shims"), "mise")
		for _, d := range nodeVersionDirs(filepath.Join(home, ".local", "share", "mise", "installs", "node"), "bin") {
			addIfDir(d, "mise")
		}
		// nvm
		nvmDir := strings.TrimSpace(os.Getenv("NVM_DIR"))
		if !filepath.IsAbs(nvmDir) {
			nvmDir = filepath.Join(home, ".nvm")
		}
		for _, d := range nodeVersionDirs(filepath.Join(nvmDir, "versions", "node"), "bin") {
			addIfDir(d, "nvm")
		}
		// fnm
		fnmRoots := []string{
			filepath.Join(home, ".local", "share", "fnm"),
			filepath.Join(home, "Library", "Application Support", "fnm"),
		}
		if d := strings.TrimSpace(os.Getenv("FNM_DIR")); filepath.IsAbs(d) {
			fnmRoots = append([]string{d}, fnmRoots...)
		}
		for _, r := range slices.Compact(fnmRoots) {
			addIfDir(filepath.Join(r, "aliases", "default", "bin"), "fnm")
			for _, d := range nodeVersionDirs(filepath.Join(r, "node-versions"), filepath.Join("installation", "bin")) {
				addIfDir(d, "fnm")
			}
		}
		addIfDir(filepath.Join(home, ".cargo", "bin"), "Cargo")
		addIfDir(filepath.Join(home, ".deno", "bin"), "Deno")
		addIfDir(filepath.Join(home, "go", "bin"), "Go")
	}
	if gopath := strings.TrimSpace(os.Getenv("GOPATH")); filepath.IsAbs(gopath) {
		addIfDir(filepath.Join(gopath, "bin"), "Go")
	}
	if !isIsolated() {
		addIfDir("/opt/homebrew/bin", "Homebrew")
		addIfDir("/usr/local/bin", "Homebrew")
	}
	return out
}

func toolInDir(dir, name string) string {
	if dir == "" || name == "" {
		return ""
	}
	cand := filepath.Join(dir, name)
	if st, err := os.Stat(cand); err == nil && !st.IsDir() && (st.Mode()&0o111) != 0 {
		return cand
	}
	return ""
}
