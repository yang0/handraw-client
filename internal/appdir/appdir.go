// Package appdir resolves the per-user directories the client writes to.
package appdir

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const (
	AppName         = "handraw-client"
	pointerFileName = "data-dir.txt"
)

type driveInfo struct {
	Root       string
	FreeBytes  uint64
	TotalBytes uint64
}

var (
	once sync.Once
	root string
)

// Root is the data directory:
//   - On Windows: scans all local fixed drives and selects the writable drive
//     with the largest available free space (<Drive>:\handraw-client), pinning
//     the choice in %APPDATA%\handraw-client\data-dir.txt so later launches do
//     not drift when disk usage changes. Existing %APPDATA%\handraw-client data
//     is preserved on upgrade (#125).
//   - On macOS: ~/Library/Application Support/handraw-client.
//   - Elsewhere: $XDG_DATA_HOME/handraw-client or ~/.local/share/handraw-client.
//
// HANDRAW_HOME always overrides it (tests, portable installs).
func Root() string {
	once.Do(func() {
		if v := os.Getenv("HANDRAW_HOME"); v != "" {
			root = v
		} else {
			root = defaultRoot()
		}
		_ = os.MkdirAll(root, 0o755)
	})
	return root
}

// SetRoot overrides the root (tests only); must run before Root is used.
func SetRoot(dir string) {
	once.Do(func() {})
	root = dir
	_ = os.MkdirAll(root, 0o755)
}

func defaultRoot() string {
	switch runtime.GOOS {
	case "windows":
		appdataBase := ""
		if v := strings.TrimSpace(os.Getenv("APPDATA")); v != "" {
			appdataBase = filepath.Join(v, AppName)
		} else if home, err := os.UserHomeDir(); err == nil {
			appdataBase = filepath.Join(home, "AppData", "Roaming", AppName)
		}
		return selectWindowsRoot(windowsRootConfig{
			appdataDir:    appdataBase,
			systemDrive:   systemDriveRoot(),
			drives:        listFixedDrives(),
			hasData:       hasExistingData,
			probeWritable: probeDirWritable,
			readPointer:   readPointerFile,
			writePointer:  writePointerFile,
		})
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", AppName)
		}
	}
	if v := os.Getenv("XDG_DATA_HOME"); v != "" {
		return filepath.Join(v, AppName)
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", AppName)
}

type windowsRootConfig struct {
	appdataDir    string
	systemDrive   string
	drives        []driveInfo
	hasData       func(dir string) bool
	probeWritable func(dir string) bool
	readPointer   func(path string) string
	writePointer  func(path, dir string)
}

func normalizeDriveRoot(raw string) string {
	s := strings.TrimSpace(raw)
	if len(s) >= 2 && s[1] == ':' {
		return strings.ToUpper(s[:2]) + `\`
	}
	return strings.ToUpper(s)
}

func isSameDrive(path, driveRoot string) bool {
	if driveRoot == "" || len(path) < 2 || path[1] != ':' {
		return false
	}
	return strings.EqualFold(normalizeDriveRoot(path[:2]), normalizeDriveRoot(driveRoot))
}

func hasExistingData(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	for _, name := range []string{"db.sqlite", "settings.json"} {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && !st.IsDir() {
			return true
		}
	}
	return false
}

func probeDirWritable(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	f, err := os.CreateTemp(dir, ".handraw-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

func readPointerFile(path string) string {
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func writePointerFile(path, dir string) {
	if path == "" || dir == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = os.WriteFile(path, []byte(dir+"\n"), 0o644)
}

func selectWindowsRoot(cfg windowsRootConfig) string {
	sysDrive := normalizeDriveRoot(cfg.systemDrive)
	if sysDrive == "" {
		sysDrive = `C:\`
	}
	pointerPath := ""
	if cfg.appdataDir != "" {
		pointerPath = filepath.Join(cfg.appdataDir, pointerFileName)
	}

	// 1. Honor pinned data-dir.txt so later launches stay stable even when disk free space changes.
	if pointerPath != "" && cfg.readPointer != nil {
		if pinned := strings.TrimSpace(cfg.readPointer(pointerPath)); pinned != "" {
			if (cfg.hasData != nil && cfg.hasData(pinned)) || (cfg.probeWritable != nil && cfg.probeWritable(pinned)) {
				return pinned
			}
		}
	}

	// 2. Preserve existing legacy data in %APPDATA%\handraw-client for upgrading users.
	if cfg.appdataDir != "" && cfg.hasData != nil && cfg.hasData(cfg.appdataDir) {
		return cfg.appdataDir
	}

	// Sort drives by available free space descending; tie-break prefers non-system drives, then drive letter.
	sorted := make([]driveInfo, len(cfg.drives))
	copy(sorted, cfg.drives)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].FreeBytes != sorted[j].FreeBytes {
			return sorted[i].FreeBytes > sorted[j].FreeBytes
		}
		iSys := isSameDrive(sorted[i].Root, sysDrive)
		jSys := isSameDrive(sorted[j].Root, sysDrive)
		if iSys != jSys {
			return !iSys
		}
		return strings.ToUpper(sorted[i].Root) < strings.ToUpper(sorted[j].Root)
	})

	// 3. Recover existing <Drive>:\handraw-client data if pointer file was cleared/reinstalled.
	if cfg.hasData != nil {
		for _, d := range sorted {
			if isSameDrive(d.Root, sysDrive) {
				continue
			}
			cand := filepath.Join(normalizeDriveRoot(d.Root), AppName)
			if cfg.hasData(cand) {
				if pointerPath != "" && cfg.writePointer != nil {
					cfg.writePointer(pointerPath, cand)
				}
				return cand
			}
		}
	}

	// 4. Fresh install: pick the writable fixed drive with the largest available free space.
	for _, d := range sorted {
		rootNorm := normalizeDriveRoot(d.Root)
		if rootNorm == "" {
			continue
		}
		cand := filepath.Join(rootNorm, AppName)
		if isSameDrive(rootNorm, sysDrive) && cfg.appdataDir != "" {
			// Avoid UAC issues on C:\ root if system drive wins (e.g., single-disk laptop).
			cand = cfg.appdataDir
		}
		if cfg.probeWritable == nil || cfg.probeWritable(cand) {
			if pointerPath != "" && cfg.writePointer != nil && !strings.EqualFold(filepath.Clean(cand), filepath.Clean(cfg.appdataDir)) {
				cfg.writePointer(pointerPath, cand)
			}
			return cand
		}
	}

	// 5. Fallback to %APPDATA%\handraw-client or user home.
	if cfg.appdataDir != "" {
		return cfg.appdataDir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", AppName)
}

func sub(name string) string {
	p := filepath.Join(Root(), name)
	_ = os.MkdirAll(p, 0o755)
	return p
}

func Resources() string       { return sub("resources") }
func Galleries() string       { return sub("galleries") }
func Library() string         { return sub("library") }
func Cache() string           { return sub("cache") }
func Plugins() string         { return sub("plugins") }
func ObsidianPlugins() string { return sub("obsidian-plugins") }
func Skills() string          { return sub("skills") }
func Logs() string            { return sub("logs") }
func Updates() string         { return sub("updates") }
func DBPath() string          { return filepath.Join(Root(), "db.sqlite") }
func Settings() string        { return filepath.Join(Root(), "settings.json") }

// DefaultWorks is the default folder for generated images. Users can move it.
// On Windows, when Root() resides on a non-system drive (e.g. G:\handraw-client),
// generated works default to <Root>\works so bulk images also stay off C:.
func DefaultWorks() string {
	return defaultWorksFor(runtime.GOOS, Root(), systemDriveRoot())
}

func defaultWorksFor(goos, rootDir, sysDrive string) string {
	if goos == "windows" && rootDir != "" && sysDrive != "" && !isSameDrive(rootDir, sysDrive) {
		return filepath.Join(rootDir, "works")
	}
	if home, err := os.UserHomeDir(); err == nil {
		pics := filepath.Join(home, "Pictures")
		if st, err := os.Stat(pics); err == nil && st.IsDir() {
			return filepath.Join(pics, "手绘风作品")
		}
	}
	return filepath.Join(rootDir, "works")
}
