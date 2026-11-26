package resources

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

//go:embed all:builtin
var builtinPackFS embed.FS

type builtinMeta struct {
	Version string `json:"version"`
}

// BuiltinVersion returns the version of the embedded official reference snapshot.
func BuiltinVersion() string {
	b, err := builtinPackFS.ReadFile("builtin/references/version.json")
	if err != nil {
		return "0.0.0"
	}
	var m builtinMeta
	if json.Unmarshal(b, &m) == nil && strings.TrimSpace(m.Version) != "" {
		return strings.TrimSpace(m.Version)
	}
	return "0.0.0"
}

// HasBuiltinMarker reports whether dir was populated by EnsureBuiltin (and not
// replaced by a signed remote/bundled manifest pack).
func HasBuiltinMarker(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err == nil {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, "builtin_version.json"))
	return err == nil
}

// EnsureBuiltin materializes the embedded official reference pack (styles,
// layouts, colors, tones, capabilities, aliases, and layout prompts) into dir
// when no resource pack is installed yet, and seamlessly upgrades older
// builtin-seeded copies without disturbing cached images or signed packs (#178).
func EnsureBuiltin(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return errors.New("empty resource pack directory")
	}
	// Never overwrite a signed remote or bundled pack that carries manifest.json.
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err == nil {
		if _, err2 := os.Stat(filepath.Join(dir, "references", "styles.json")); err2 == nil {
			return nil
		}
	}

	embeddedVer := BuiltinVersion()
	stylesPath := filepath.Join(dir, "references", "styles.json")
	markerPath := filepath.Join(dir, "builtin_version.json")

	if _, err := os.Stat(stylesPath); err == nil {
		if mb, mErr := os.ReadFile(markerPath); mErr == nil {
			var installed builtinMeta
			if json.Unmarshal(mb, &installed) == nil && compareBuiltinSemver(installed.Version, embeddedVer) >= 0 {
				return nil
			}
		} else {
			// Existing non-builtin pack without manifest.json (e.g. user-placed pack): keep intact.
			return nil
		}
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	err := fs.WalkDir(builtinPackFS, "builtin", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel := strings.TrimPrefix(path, "builtin")
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" {
			return nil
		}
		dst := filepath.Join(dir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := builtinPackFS.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		tmp := dst + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, dst); err != nil {
			_ = os.Remove(tmp)
			return os.WriteFile(dst, data, 0o644)
		}
		return nil
	})
	if err != nil {
		return err
	}

	metaBytes, _ := json.MarshalIndent(builtinMeta{Version: embeddedVer}, "", "  ")
	return os.WriteFile(markerPath, append(metaBytes, '\n'), 0o644)
}

func compareBuiltinSemver(a, b string) int {
	parse := func(v string) []int {
		v = strings.TrimPrefix(strings.TrimSpace(v), "v")
		if i := strings.IndexAny(v, "-+"); i >= 0 {
			v = v[:i]
		}
		parts := strings.Split(v, ".")
		out := make([]int, len(parts))
		for i, p := range parts {
			n, _ := strconv.Atoi(p)
			out[i] = n
		}
		return out
	}
	pa, pb := parse(a), parse(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x < y {
			return -1
		}
		if x > y {
			return 1
		}
	}
	return 0
}
