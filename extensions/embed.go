package extensions

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:handraw-clipper
var ClipperFS embed.FS

// ClipperDefaults is written into the extracted extension folder as defaults.json
// so single-binary installs work immediately after loading in Chrome/Edge without
// manually copying and pasting the pairing token (#185).
type ClipperDefaults struct {
	ClientURL string `json:"clientUrl"`
	ClipToken string `json:"clipToken"`
	SiteBase  string `json:"siteBase,omitempty"`
	PairedAt  string `json:"pairedAt,omitempty"`
}

// EnsureClipper materializes the embedded handraw-clipper Chrome/Edge extension
// into dstDir (updating any changed extension files) and writes pre-paired
// defaults.json with mode 0600 (#185).
func EnsureClipper(dstDir string, defs ClipperDefaults) error {
	dstDir = strings.TrimSpace(dstDir)
	if dstDir == "" {
		return errors.New("empty clipper destination directory")
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	err := fs.WalkDir(ClipperFS, "handraw-clipper", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel := strings.TrimPrefix(path, "handraw-clipper")
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" {
			return nil
		}
		// Never copy any stray defaults.json from embedded assets; always generate fresh below.
		if strings.EqualFold(filepath.Base(rel), "defaults.json") {
			return nil
		}
		dst := filepath.Join(dstDir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := ClipperFS.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if cur, rErr := os.ReadFile(dst); rErr == nil && bytes.Equal(cur, data) {
			return nil
		}
		return writeAtomic(dst, data, 0o644)
	})
	if err != nil {
		return err
	}
	return WriteClipperDefaults(dstDir, defs)
}

// WriteClipperDefaults writes or updates defaults.json in dstDir with 0600 permissions.
func WriteClipperDefaults(dstDir string, defs ClipperDefaults) error {
	dstDir = strings.TrimSpace(dstDir)
	if dstDir == "" {
		return errors.New("empty clipper directory")
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	defs.ClientURL = strings.TrimRight(strings.TrimSpace(defs.ClientURL), "/")
	if defs.ClientURL == "" {
		defs.ClientURL = "http://127.0.0.1:18520"
	}
	defs.ClipToken = strings.TrimSpace(defs.ClipToken)
	defs.SiteBase = strings.TrimRight(strings.TrimSpace(defs.SiteBase), "/")
	if defs.SiteBase == "" {
		defs.SiteBase = "https://handraw-style.com"
	}
	target := filepath.Join(dstDir, "defaults.json")
	// Preserve PairedAt if the effective fields have not changed so we avoid churning disk.
	if raw, err := os.ReadFile(target); err == nil {
		var prev ClipperDefaults
		if json.Unmarshal(raw, &prev) == nil &&
			prev.ClientURL == defs.ClientURL &&
			prev.ClipToken == defs.ClipToken &&
			prev.SiteBase == defs.SiteBase &&
			prev.PairedAt != "" {
			return nil
		}
	}
	if defs.PairedAt == "" {
		defs.PairedAt = time.Now().UTC().Format(time.RFC3339)
	}
	b, err := json.MarshalIndent(defs, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(target, append(b, '\n'), 0o600)
}

func writeAtomic(dst string, data []byte, perm os.FileMode) error {
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return os.WriteFile(dst, data, perm)
	}
	return nil
}
