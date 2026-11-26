package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Manifest lists every file of a resource pack.
type Manifest struct {
	Version     string         `json:"version"`
	GeneratedAt string         `json:"generated_at"`
	Files       []ManifestFile `json:"files"`
}

type ManifestFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// ResourceFeed is the base URL of the published resource pack: <base>/manifest.json,
// <base>/manifest.json.sig, <base>/<path>.
var ResourceFeed = []string{
	"https://gitee.com/yang02010/handraw-client/releases/download/resources",
	"https://handraw-style.com/static/client/resources",
	"https://github.com/yang0/handraw-client/releases/download/resources",
}

type Plan struct {
	Base    string         `json:"base"`
	Remote  Manifest       `json:"-"`
	Changed []ManifestFile `json:"changed"`
	Removed []string       `json:"removed"`
	Bytes   int64          `json:"bytes"`
	Version string         `json:"version"`
	sig     []byte
	raw     []byte
}

func readManifest(dir string) Manifest {
	var m Manifest
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

// LocalResourceVersion reads the installed pack's version.
func LocalResourceVersion(dir string) string { return readManifest(dir).Version }

// PlanResources compares the remote manifest with local files by SHA-256.
// Signature verification is strictly fail-closed: without a valid PublicKey
// and matching signature, remote resource packs are refused (#176).
func (u *Updater) PlanResources(ctx context.Context, dir string) (*Plan, error) {
	var lastErr error
	for _, base := range ResourceFeed {
		raw, err := u.getLimit(ctx, base+"/manifest.json", maxMetadataBytes, nil)
		if err != nil {
			lastErr = err
			continue
		}
		sig, err := u.getLimit(ctx, base+"/manifest.json.sig", maxSigBytes, nil)
		if err != nil {
			lastErr = err
			continue
		}
		var remote Manifest
		if err := json.Unmarshal(raw, &remote); err != nil {
			lastErr = err
			continue
		}
		if _, err := VerifySums("resources-"+remote.Version, raw, sig, PublicKey); err != nil {
			lastErr = err
			continue
		}
		local := readManifest(dir)
		have := map[string]string{}
		for _, f := range local.Files {
			have[f.Path] = f.SHA256
		}
		p := &Plan{Base: base, Remote: remote, Version: remote.Version, raw: raw, sig: sig}
		want := map[string]bool{}
		for _, f := range remote.Files {
			want[f.Path] = true
			if have[f.Path] == f.SHA256 && fileHashOK(filepath.Join(dir, filepath.FromSlash(f.Path)), f.Size, f.SHA256) {
				continue
			}
			p.Changed = append(p.Changed, f)
			p.Bytes += f.Size
		}
		for _, f := range local.Files {
			if !want[f.Path] {
				p.Removed = append(p.Removed, f.Path)
			}
		}
		newVer := ""
		if len(p.Changed) > 0 || len(p.Removed) > 0 {
			newVer = remote.Version
		}
		u.set(func(s *Status) {
			s.ResourceLocal = local.Version
			s.ResourceNew = newVer
			s.ResourceFiles = len(p.Changed)
			s.ResourceBytes = p.Bytes
		})
		return p, nil
	}
	if lastErr == nil {
		lastErr = errors.New("无法获取资源包清单")
	}
	return nil, lastErr
}

// fileHashOK verifies both size and actual SHA-256 content digest of the local
// file so same-size corrupted or modified files are detected and repaired (#176).
func fileHashOK(path string, size int64, wantSHA256 string) bool {
	if strings.TrimSpace(wantSHA256) == "" {
		return false
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() || st.Size() != size {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	return strings.EqualFold(hex.EncodeToString(h.Sum(nil)), strings.TrimSpace(wantSHA256))
}

// ApplyResources downloads changed files into a staging dir, verifies each,
// then moves them in. A failure leaves the installed pack untouched.
func (u *Updater) ApplyResources(ctx context.Context, dir string, p *Plan, progress func(done, total int)) error {
	stage := dir + ".staging"
	_ = os.RemoveAll(stage)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	for i, f := range p.Changed {
		dst := filepath.Join(stage, filepath.FromSlash(f.Path))
		if strings.Contains(f.Path, "..") || filepath.IsAbs(f.Path) || !isWithinDir(stage, dst) || dst == filepath.Clean(stage) {
			return fmt.Errorf("资源路径非法：%s", f.Path)
		}
		var data []byte
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			data, err = u.getLimit(ctx, p.Base+"/"+f.Path, maxResourceFileBytes, nil)
			if err == nil {
				break
			}
			time.Sleep(time.Second)
		}
		if err != nil {
			return fmt.Errorf("下载 %s 失败：%w", f.Path, err)
		}
		sum := sha256.Sum256(data)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), strings.TrimSpace(f.SHA256)) {
			return fmt.Errorf("%s 校验失败", f.Path)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
		if progress != nil {
			progress(i+1, len(p.Changed))
		}
	}
	for _, f := range p.Changed {
		src := filepath.Join(stage, filepath.FromSlash(f.Path))
		dst := filepath.Join(dir, filepath.FromSlash(f.Path))
		os.MkdirAll(filepath.Dir(dst), 0o755)
		if err := os.Rename(src, dst); err != nil {
			if err := copyFile(src, dst, 0o644); err != nil {
				return err
			}
		}
	}
	for _, r := range p.Removed {
		if !strings.Contains(r, "..") {
			_ = os.Remove(filepath.Join(dir, filepath.FromSlash(r)))
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), p.raw, 0o644); err != nil {
		return err
	}
	u.set(func(s *Status) { s.ResourceLocal = p.Version; s.ResourceNew = ""; s.ResourceFiles = 0; s.ResourceBytes = 0 })
	return nil
}

// InstallBundled copies a bundled pack into dir when dir has none (first run).
func InstallBundled(src, dir string) error {
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err == nil {
		if _, err2 := os.Stat(filepath.Join(dir, "references", "styles.json")); err2 == nil {
			return nil
		}
	}
	if _, err := os.Stat(filepath.Join(src, "manifest.json")); err != nil {
		return errors.New("no bundled pack")
	}
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		dst := filepath.Join(dir, rel)
		if info.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.Create(dst)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		out.Close()
		return err
	})
}

// HTTPGet is exposed for tests.
var _ = http.MethodGet
