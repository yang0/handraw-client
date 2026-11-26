// Package ziputil provides a single hardened ZIP extraction implementation
// shared across all extension installers (plugins, skills, galleries, obsidian)
// so every market enforces consistent path-traversal, symlink, file-count, and
// actual-written byte limits (#180).
package ziputil

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Options configures safe extraction bounds and entry filtering.
type Options struct {
	// Prefix, when non-empty, restricts extraction to entries starting with
	// Prefix and strips Prefix from extracted relative paths.
	Prefix string
	// MaxFiles caps the number of extracted regular files (0 uses default 5000).
	MaxFiles int
	// MaxFileBytes caps actual written bytes per extracted file (required > 0).
	MaxFileBytes int64
	// MaxTotalBytes caps cumulative actual written bytes across all extracted files (required > 0).
	MaxTotalBytes int64
	// SkipMacOSX skips macOS archive metadata entries under __MACOSX/.
	SkipMacOSX bool
	// RejectUnsafePath causes entries with ".." or leading "/" to return an error
	// instead of being silently skipped.
	RejectUnsafePath bool
	// TransformRel optionally rewrites a sanitized slash-separated relative path
	// (e.g. normalizing "skill.md" to "SKILL.md"). Returning "" skips the entry.
	TransformRel func(rel string) string
}

// Result reports extraction statistics.
type Result struct {
	Files int
	Bytes int64
}

const defaultMaxFiles = 5000

// ExtractFiles safely extracts zip entries into destRoot while enforcing
// normalized relative paths, symlink skipping, EvalSymlinks parent verification,
// and actual-written byte caps (never trusting spoofable zip header sizes).
func ExtractFiles(files []*zip.File, destRoot string, opts Options) (Result, error) {
	var res Result
	cleanRoot := filepath.Clean(destRoot)
	if err := os.MkdirAll(cleanRoot, 0o755); err != nil {
		return res, err
	}
	resolvedRoot, _ := filepath.EvalSymlinks(cleanRoot)

	maxFiles := opts.MaxFiles
	if maxFiles <= 0 {
		maxFiles = defaultMaxFiles
	}
	maxFile := opts.MaxFileBytes
	if maxFile <= 0 {
		maxFile = 32 << 20
	}
	maxTotal := opts.MaxTotalBytes
	if maxTotal <= 0 {
		maxTotal = 128 << 20
	}

	prefix := strings.ReplaceAll(opts.Prefix, `\`, "/")
	for _, f := range files {
		if f.Mode()&os.ModeSymlink != 0 {
			continue
		}
		rawName := strings.ReplaceAll(f.Name, `\`, "/")
		if opts.SkipMacOSX && (strings.HasPrefix(rawName, "__MACOSX/") || strings.Contains(rawName, "/__MACOSX/")) {
			continue
		}
		// Reject/skip raw path traversal before prefix stripping.
		if strings.HasPrefix(rawName, "/") || hasParentSegment(rawName) {
			if opts.RejectUnsafePath {
				return res, errors.New("ZIP 包含不安全路径，已拒绝安装")
			}
			continue
		}
		clean := path.Clean(rawName)
		if clean == "." || clean == "" || strings.HasPrefix(clean, "../") || clean == ".." {
			if opts.RejectUnsafePath {
				return res, errors.New("ZIP 包含不安全路径，已拒绝安装")
			}
			continue
		}
		if prefix != "" {
			if !strings.HasPrefix(clean, prefix) {
				continue
			}
			clean = strings.TrimPrefix(clean, prefix)
		}
		clean = strings.TrimPrefix(clean, "./")
		clean = strings.TrimLeft(clean, "/")
		if clean == "" || clean == "." || hasParentSegment(clean) {
			if opts.RejectUnsafePath && hasParentSegment(clean) {
				return res, errors.New("ZIP 包含越界路径，已拒绝安装")
			}
			continue
		}
		if opts.TransformRel != nil {
			clean = opts.TransformRel(clean)
			if clean == "" || strings.HasPrefix(clean, "/") || hasParentSegment(clean) {
				continue
			}
		}

		dst := filepath.Join(cleanRoot, filepath.FromSlash(clean))
		if dst == cleanRoot || !strings.HasPrefix(dst, cleanRoot+string(os.PathSeparator)) {
			return res, errors.New("ZIP 包含越界路径，已拒绝安装")
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return res, err
			}
			continue
		}
		if res.Files >= maxFiles {
			return res, fmt.Errorf("ZIP 文件数量超过上限（%d）", maxFiles)
		}

		parent := filepath.Dir(dst)
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return res, err
		}
		if resolvedRoot != "" {
			if resolvedParent, err := filepath.EvalSymlinks(parent); err == nil {
				if resolvedParent != resolvedRoot && !strings.HasPrefix(resolvedParent, resolvedRoot+string(os.PathSeparator)) {
					return res, errors.New("ZIP 解压路径存在符号链接越界")
				}
			}
		}

		remaining := maxTotal - res.Bytes
		if remaining < 0 {
			return res, errors.New("ZIP 解压总体积超过安全上限")
		}
		limit := maxFile
		if remaining < limit {
			limit = remaining
		}

		rc, err := f.Open()
		if err != nil {
			return res, err
		}
		outF, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			rc.Close()
			return res, err
		}
		n, cpErr := io.Copy(outF, io.LimitReader(rc, limit+1))
		closeErr := outF.Close()
		rc.Close()
		if cpErr != nil {
			_ = os.Remove(dst)
			return res, cpErr
		}
		if closeErr != nil {
			_ = os.Remove(dst)
			return res, closeErr
		}
		if n > maxFile {
			_ = os.Remove(dst)
			return res, errors.New("ZIP 内单文件超过体积限制")
		}
		if res.Bytes+n > maxTotal {
			_ = os.Remove(dst)
			return res, errors.New("ZIP 解压总体积超过安全上限")
		}
		res.Files++
		res.Bytes += n
	}
	return res, nil
}

func hasParentSegment(slashPath string) bool {
	for _, seg := range strings.Split(slashPath, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}
