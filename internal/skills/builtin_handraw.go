package skills

import (
	"context"
	"crypto/sha256"
	"embed"
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

// BuiltinHandrawSkillID is the canonical ID of the official bundled Handraw Skill.
const BuiltinHandrawSkillID = "handraw-skill"

//go:embed builtin/handraw-skill/SKILL.md builtin/handraw-skill/version.json
var builtinFS embed.FS

// BuiltinHandrawMirrors defines ordered remote sources for dynamic hot-updates
// of the built-in Handraw Skill (GitHub Raw primary + jsDelivr CDN fallback).
// Exported as var so tests can point it at an httptest.Server.
var BuiltinHandrawMirrors = []struct {
	SkillURL   string
	VersionURL string
}{
	{
		SkillURL:   "https://raw.githubusercontent.com/yang0/handraw-style/main/skills/handdraw-style-prompter/SKILL.md",
		VersionURL: "https://raw.githubusercontent.com/yang0/handraw-style/main/version.json",
	},
	{
		SkillURL:   "https://cdn.jsdelivr.net/gh/yang0/handraw-style@main/skills/handdraw-style-prompter/SKILL.md",
		VersionURL: "https://cdn.jsdelivr.net/gh/yang0/handraw-style@main/version.json",
	},
}

type UpdateCheckResult struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Builtin         bool   `json:"builtin"`
	Version         string `json:"version"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Updatable       bool   `json:"updatable"`
	Error           string `json:"error,omitempty"`
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func bundledHandrawData() (skillBytes []byte, version string) {
	skillBytes, _ = builtinFS.ReadFile("builtin/handraw-skill/SKILL.md")
	version = "1.0.0"
	if vb, err := builtinFS.ReadFile("builtin/handraw-skill/version.json"); err == nil {
		var vj struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(vb, &vj) == nil && strings.TrimSpace(vj.Version) != "" {
			version = strings.TrimSpace(vj.Version)
		}
	}
	return skillBytes, version
}

// EnsureBuiltin materializes the bundled official Handraw Skill into the
// manager directory if missing, and refreshes bundled metadata without
// overwriting newer dynamically updated versions.
func (m *Manager) EnsureBuiltin() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	rawSkill, bundledVer := bundledHandrawData()
	if len(rawSkill) == 0 {
		return nil
	}
	normalized := strings.TrimSpace(strings.ReplaceAll(string(rawSkill), "\r\n", "\n")) + "\n"
	bundledHash := sha256Hex([]byte(normalized))

	dest := filepath.Join(m.dir, BuiltinHandrawSkillID)
	skillPath := filepath.Join(dest, "SKILL.md")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}

	var existingMeta metaFile
	hasMeta := false
	if mb, err := os.ReadFile(filepath.Join(dest, "meta.json")); err == nil {
		if json.Unmarshal(mb, &existingMeta) == nil {
			hasMeta = true
		}
	}

	_, statErr := os.Stat(skillPath)
	now := time.Now().UnixMilli()

	// Fresh install or missing SKILL.md -> materialize bundled snapshot.
	if statErr != nil {
		if err := os.WriteFile(skillPath, []byte(normalized), 0o644); err != nil {
			return err
		}
		meta := metaFile{
			ID:          BuiltinHandrawSkillID,
			Enabled:     true,
			Builtin:     true,
			Version:     bundledVer,
			Source:      "builtin:yang0/handraw-style",
			ContentSHA:  bundledHash,
			InstalledAt: now,
			UpdatedAt:   now,
		}
		if hasMeta {
			meta.Enabled = existingMeta.Enabled
			if existingMeta.InstalledAt > 0 {
				meta.InstalledAt = existingMeta.InstalledAt
			}
		}
		return writeMeta(dest, meta)
	}

	// Already installed: ensure Builtin flag and version are recorded, and if a
	// newer client release ships a newer bundled version than an un-upgraded
	// local copy, seamlessly advance it.
	dirty := false
	if !hasMeta {
		existingMeta = metaFile{
			ID:          BuiltinHandrawSkillID,
			Enabled:     true,
			Builtin:     true,
			Version:     bundledVer,
			Source:      "builtin:yang0/handraw-style",
			ContentSHA:  bundledHash,
			InstalledAt: now,
			UpdatedAt:   now,
		}
		dirty = true
	} else {
		if !existingMeta.Builtin {
			existingMeta.Builtin = true
			dirty = true
		}
		if existingMeta.Source == "" {
			existingMeta.Source = "builtin:yang0/handraw-style"
			dirty = true
		}
		if existingMeta.Version == "" {
			existingMeta.Version = bundledVer
			dirty = true
		}
		if compareSemver(bundledVer, existingMeta.Version) > 0 && !existingMeta.Customized {
			if err := os.WriteFile(skillPath, []byte(normalized), 0o644); err == nil {
				existingMeta.Version = bundledVer
				existingMeta.ContentSHA = bundledHash
				existingMeta.UpdatedAt = now
				existingMeta.UpdateAvailable = false
				dirty = true
			}
		}
	}
	if dirty {
		return writeMeta(dest, existingMeta)
	}
	return nil
}

func isRemoteUpdatable(sk Skill) bool {
	if sk.Builtin || sk.ID == BuiltinHandrawSkillID {
		return true
	}
	src := strings.TrimSpace(sk.Source)
	return strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://")
}

func fetchBytes(ctx context.Context, rawURL string, maxBytes int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "HandrawClient/1.0")
	req.Header.Set("Cache-Control", "no-cache")
	client := &http.Client{Timeout: 18 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxBytes))
}

func fetchBuiltinRemoteVersion(ctx context.Context) (string, error) {
	var lastErr error
	for _, mirror := range BuiltinHandrawMirrors {
		if strings.TrimSpace(mirror.VersionURL) == "" {
			continue
		}
		b, err := fetchBytes(ctx, mirror.VersionURL, 64<<10)
		if err != nil {
			lastErr = err
			continue
		}
		var vj struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(b, &vj) == nil && strings.TrimSpace(vj.Version) != "" {
			return strings.TrimSpace(vj.Version), nil
		}
		lastErr = errors.New("version.json 格式无效")
	}
	if lastErr == nil {
		lastErr = errors.New("未配置远端版本镜像")
	}
	return "", lastErr
}

func fetchBuiltinRemoteSkill(ctx context.Context) (content string, version string, err error) {
	var lastErr error
	for _, mirror := range BuiltinHandrawMirrors {
		if strings.TrimSpace(mirror.SkillURL) == "" {
			continue
		}
		raw, fetchErr := fetchBytes(ctx, mirror.SkillURL, maxSkillFileBytes)
		if fetchErr != nil {
			lastErr = fetchErr
			continue
		}
		txt := strings.TrimSpace(strings.ReplaceAll(string(raw), "\r\n", "\n"))
		if txt == "" {
			lastErr = errors.New("远端 SKILL.md 为空")
			continue
		}
		ver := ""
		if strings.TrimSpace(mirror.VersionURL) != "" {
			if vb, verr := fetchBytes(ctx, mirror.VersionURL, 64<<10); verr == nil {
				var vj struct {
					Version string `json:"version"`
				}
				if json.Unmarshal(vb, &vj) == nil {
					ver = strings.TrimSpace(vj.Version)
				}
			}
		}
		if ver == "" {
			_, _, _, fmVer := ParseFrontmatterFull(txt)
			ver = fmVer
		}
		return txt + "\n", ver, nil
	}
	if lastErr == nil {
		lastErr = errors.New("无法连接官方手绘 Skill 镜像源")
	}
	return "", "", lastErr
}

// CheckUpdate checks whether a skill (especially the built-in handraw-skill)
// has a newer version or changed content on its remote origin.
func (m *Manager) CheckUpdate(ctx context.Context, id string) (UpdateCheckResult, error) {
	sk, err := m.Get(id)
	if err != nil {
		return UpdateCheckResult{}, err
	}
	res := UpdateCheckResult{
		ID:        sk.ID,
		Name:      sk.Name,
		Builtin:   sk.Builtin,
		Version:   sk.Version,
		Updatable: isRemoteUpdatable(sk),
	}
	if !res.Updatable {
		return res, nil
	}

	if sk.Builtin || sk.ID == BuiltinHandrawSkillID {
		remoteVer, err := fetchBuiltinRemoteVersion(ctx)
		if err != nil {
			res.Error = err.Error()
			return res, err
		}
		res.LatestVersion = remoteVer
		res.UpdateAvailable = remoteVer != "" && (sk.Version == "" || compareSemver(remoteVer, sk.Version) > 0)
		m.mu.Lock()
		dir := filepath.Join(m.dir, sk.ID)
		meta := readMetaLocked(dir, sk.ID)
		meta.LatestVersion = remoteVer
		meta.UpdateAvailable = res.UpdateAvailable
		_ = writeMeta(dir, meta)
		m.mu.Unlock()
		return res, nil
	}

	// Generic remote SKILL.md URL check by content hash.
	src := strings.TrimSpace(sk.Source)
	if strings.HasSuffix(strings.ToLower(src), ".md") {
		raw, err := fetchBytes(ctx, src, maxSkillFileBytes)
		if err != nil {
			res.Error = err.Error()
			return res, err
		}
		txt := strings.TrimSpace(strings.ReplaceAll(string(raw), "\r\n", "\n")) + "\n"
		remoteSHA := sha256Hex([]byte(txt))
		localSHA := sk.ContentSHA
		if localSHA == "" {
			localSHA = sha256Hex([]byte(strings.TrimSpace(sk.Content) + "\n"))
		}
		_, _, _, remoteVer := ParseFrontmatterFull(txt)
		res.LatestVersion = firstNonEmpty(remoteVer, remoteSHA[:8])
		res.UpdateAvailable = remoteSHA != localSHA
		m.mu.Lock()
		dir := filepath.Join(m.dir, sk.ID)
		meta := readMetaLocked(dir, sk.ID)
		meta.LatestVersion = res.LatestVersion
		meta.UpdateAvailable = res.UpdateAvailable
		_ = writeMeta(dir, meta)
		m.mu.Unlock()
		return res, nil
	}
	return res, nil
}

// CheckAllUpdates checks every remote-updatable skill (including built-in handraw-skill).
func (m *Manager) CheckAllUpdates(ctx context.Context) []UpdateCheckResult {
	list, err := m.List()
	if err != nil {
		return nil
	}
	var out []UpdateCheckResult
	for _, sk := range list {
		if !isRemoteUpdatable(sk) {
			continue
		}
		r, _ := m.CheckUpdate(ctx, sk.ID)
		out = append(out, r)
	}
	return out
}

// Update dynamically hot-updates the given skill from its remote source without
// requiring an application restart. Returns (updatedSkill, changed, error).
func (m *Manager) Update(ctx context.Context, id string) (Skill, bool, error) {
	sk, err := m.Get(id)
	if err != nil {
		return Skill{}, false, err
	}
	if !isRemoteUpdatable(sk) {
		return sk, false, errors.New("该 Skill 为本地创建，没有配置远程更新源")
	}

	if sk.Builtin || sk.ID == BuiltinHandrawSkillID {
		content, remoteVer, err := fetchBuiltinRemoteSkill(ctx)
		if err != nil {
			return sk, false, fmt.Errorf("拉取官方手绘 Skill 失败：%w", err)
		}
		newSHA := sha256Hex([]byte(content))
		oldSHA := sk.ContentSHA
		if oldSHA == "" {
			oldSHA = sha256Hex([]byte(strings.TrimSpace(strings.ReplaceAll(sk.Content, "\r\n", "\n")) + "\n"))
		}
		changed := newSHA != oldSHA || (remoteVer != "" && remoteVer != sk.Version)

		m.mu.Lock()
		defer m.mu.Unlock()
		dest := filepath.Join(m.dir, sk.ID)
		if changed {
			tmpPath := filepath.Join(dest, "SKILL.md.tmp")
			if err := os.WriteFile(tmpPath, []byte(content), 0o644); err != nil {
				return sk, false, err
			}
			if err := os.Rename(tmpPath, filepath.Join(dest, "SKILL.md")); err != nil {
				_ = os.Remove(tmpPath)
				if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), []byte(content), 0o644); err != nil {
					return sk, false, err
				}
			}
		}
		meta := readMetaLocked(dest, sk.ID)
		meta.Builtin = true
		if remoteVer != "" {
			meta.Version = remoteVer
			meta.LatestVersion = remoteVer
		}
		meta.ContentSHA = newSHA
		meta.UpdateAvailable = false
		meta.Customized = false
		meta.UpdatedAt = time.Now().UnixMilli()
		if meta.Source == "" {
			meta.Source = "builtin:yang0/handraw-style"
		}
		if err := writeMeta(dest, meta); err != nil {
			return sk, false, err
		}
		updated, err := m.readLocked(sk.ID)
		return updated, changed, err
	}

	// Generic remote Skill update via InstallFromSource while preserving Enabled state.
	oldSHA := sk.ContentSHA
	if oldSHA == "" {
		oldSHA = sha256Hex([]byte(strings.TrimSpace(sk.Content) + "\n"))
	}
	wasEnabled := sk.Enabled
	fresh, err := m.InstallFromSource(ctx, sk.Source)
	if err != nil {
		return sk, false, err
	}
	if !wasEnabled {
		fresh, _ = m.SetEnabled(fresh.ID, false)
	}
	newSHA := sha256Hex([]byte(strings.TrimSpace(fresh.Content) + "\n"))
	return fresh, newSHA != oldSHA, nil
}

func readMetaLocked(dir, id string) metaFile {
	meta := metaFile{ID: id, Enabled: true}
	if mb, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
		_ = json.Unmarshal(mb, &meta)
	}
	if meta.ID == "" {
		meta.ID = id
	}
	return meta
}

func compareSemver(a, b string) int {
	pa := parseVerParts(a)
	pb := parseVerParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] > pb[i] {
				return 1
			}
			return -1
		}
	}
	return strings.Compare(strings.TrimSpace(a), strings.TrimSpace(b))
}

func parseVerParts(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if idx := strings.IndexAny(v, "-+"); idx >= 0 {
		v = v[:idx]
	}
	var out [3]int
	parts := strings.Split(v, ".")
	for i := 0; i < len(parts) && i < 3; i++ {
		n := 0
		for _, r := range parts[i] {
			if r >= '0' && r <= '9' {
				n = n*10 + int(r-'0')
			} else {
				break
			}
		}
		out[i] = n
	}
	return out
}
