// Package appdir resolves the per-user directories the client writes to.
package appdir

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

const AppName = "handraw-client"

var (
	once sync.Once
	root string
)

// Root is the data directory: %APPDATA%\handraw-client on Windows,
// ~/Library/Application Support/handraw-client on macOS, ~/.local/share
// elsewhere. HANDRAW_HOME overrides it (tests, portable installs).
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
		if v := os.Getenv("APPDATA"); v != "" {
			return filepath.Join(v, AppName)
		}
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

func sub(name string) string {
	p := filepath.Join(Root(), name)
	_ = os.MkdirAll(p, 0o755)
	return p
}

func Resources() string { return sub("resources") }
func Galleries() string { return sub("galleries") }
func Library() string   { return sub("library") }
func Cache() string     { return sub("cache") }
func Plugins() string   { return sub("plugins") }
func Logs() string      { return sub("logs") }
func Updates() string   { return sub("updates") }
func DBPath() string    { return filepath.Join(Root(), "db.sqlite") }
func Settings() string  { return filepath.Join(Root(), "settings.json") }

// DefaultWorks is the default folder for generated images. Users can move it.
func DefaultWorks() string {
	if home, err := os.UserHomeDir(); err == nil {
		pics := filepath.Join(home, "Pictures")
		if st, err := os.Stat(pics); err == nil && st.IsDir() {
			return filepath.Join(pics, "手绘风作品")
		}
	}
	return filepath.Join(Root(), "works")
}
