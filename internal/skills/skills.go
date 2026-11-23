// Package skills manages user-installed Agent Skills (SKILL.md directories)
// stored under <HANDRAW_HOME>/skills.
package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxSkillFileBytes = 2 << 20  // 2 MiB per file
	maxZipBytes       = 16 << 20 // 16 MiB zip download/upload limit
	maxFilesPerSkill  = 64
)

type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Content     string `json:"content"`
	Body        string `json:"body"`
	Enabled     bool   `json:"enabled"`
	Source      string `json:"source"`
	Dir         string `json:"dir"`
	InstalledAt int64  `json:"installedAt"`
}

type metaFile struct {
	ID          string `json:"id"`
	Enabled     bool   `json:"enabled"`
	Source      string `json:"source"`
	InstalledAt int64  `json:"installedAt"`
}

type Manager struct {
	dir string
	mu  sync.RWMutex
}

func New(dir string) *Manager {
	_ = os.MkdirAll(dir, 0o755)
	return &Manager{dir: dir}
}

func (m *Manager) Dir() string { return m.dir }

func (m *Manager) List() ([]Skill, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if err := os.MkdirAll(m.dir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, err
	}
	out := make([]Skill, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		sk, err := m.readLocked(e.Name())
		if err != nil {
			continue
		}
		out = append(out, sk)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].InstalledAt != out[j].InstalledAt {
			return out[i].InstalledAt > out[j].InstalledAt
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

func (m *Manager) Get(id string) (Skill, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id = SanitizeID(id)
	if id == "" {
		return Skill{}, errors.New("Skill ID 无效")
	}
	return m.readLocked(id)
}

func (m *Manager) SetEnabled(id string, enabled bool) (Skill, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id = SanitizeID(id)
	if id == "" {
		return Skill{}, errors.New("Skill ID 无效")
	}
	sk, err := m.readLocked(id)
	if err != nil {
		return Skill{}, err
	}
	meta := metaFile{
		ID:          id,
		Enabled:     enabled,
		Source:      sk.Source,
		InstalledAt: sk.InstalledAt,
	}
	if err := writeMeta(filepath.Join(m.dir, id), meta); err != nil {
		return Skill{}, err
	}
	sk.Enabled = enabled
	return sk, nil
}

func (m *Manager) UpdateContent(id, content string) (Skill, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id = SanitizeID(id)
	if id == "" {
		return Skill{}, errors.New("Skill ID 无效")
	}
	sk, err := m.readLocked(id)
	if err != nil {
		return Skill{}, err
	}
	content = strings.TrimSpace(content)
	if content == "" {
		return Skill{}, errors.New("SKILL.md 内容不能为空")
	}
	if err := os.WriteFile(filepath.Join(m.dir, id, "SKILL.md"), []byte(content+"\n"), 0o644); err != nil {
		return Skill{}, err
	}
	return m.readLocked(sk.ID)
}

func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	id = SanitizeID(id)
	if id == "" {
		return errors.New("Skill ID 无效")
	}
	target := filepath.Join(m.dir, id)
	rel, err := filepath.Rel(m.dir, target)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return errors.New("非法的 Skill 路径")
	}
	if _, err := os.Stat(target); err != nil {
		return fmt.Errorf("未找到 Skill：%s", id)
	}
	return os.RemoveAll(target)
}

// InstallInline creates or updates a skill directly from Markdown content.
func (m *Manager) InstallInline(id, name, description, content, source string) (Skill, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	content = strings.TrimSpace(strings.ReplaceAll(content, "\r\n", "\n"))
	name = strings.TrimSpace(name)
	description = strings.TrimSpace(description)
	if content == "" {
		return Skill{}, errors.New("Skill 指令内容不能为空")
	}
	pName, pDesc, pBody := ParseFrontmatter(content)
	if name == "" {
		name = pName
	}
	if description == "" {
		description = pDesc
	}
	if id == "" {
		id = SanitizeID(name)
	} else {
		id = SanitizeID(id)
	}
	if id == "" {
		id = fmt.Sprintf("skill-%d", time.Now().Unix())
	}
	if name == "" {
		name = id
	}
	// Ensure valid YAML frontmatter if none present.
	if !strings.HasPrefix(content, "---\n") {
		var sb strings.Builder
		sb.WriteString("---\n")
		sb.WriteString("name: " + yamlQuote(name) + "\n")
		if description != "" {
			sb.WriteString("description: " + yamlQuote(description) + "\n")
		}
		sb.WriteString("---\n\n")
		sb.WriteString(pBody)
		content = sb.String()
	}
	if source == "" {
		source = "inline"
	}

	dest := filepath.Join(m.dir, id)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return Skill{}, err
	}
	if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), []byte(strings.TrimSpace(content)+"\n"), 0o644); err != nil {
		return Skill{}, err
	}
	meta := metaFile{
		ID:          id,
		Enabled:     true,
		Source:      source,
		InstalledAt: time.Now().UnixMilli(),
	}
	if err := writeMeta(dest, meta); err != nil {
		return Skill{}, err
	}
	return m.readLocked(id)
}

// InstallFromBytes installs a skill from uploaded .md or .zip bytes.
func (m *Manager) InstallFromBytes(filename string, raw []byte, source string) (Skill, error) {
	if len(raw) == 0 {
		return Skill{}, errors.New("上传文件内容为空")
	}
	if len(raw) > maxZipBytes {
		return Skill{}, errors.New("文件大小超过 16MB 限制")
	}
	ext := strings.ToLower(filepath.Ext(filename))
	if ext == ".zip" || (len(raw) >= 4 && string(raw[:4]) == "PK\x03\x04") {
		return m.installZipBytes(raw, strings.TrimSuffix(filepath.Base(filename), ext), source)
	}
	pName, pDesc, _ := ParseFrontmatter(string(raw))
	base := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	if strings.EqualFold(base, "skill") {
		base = ""
	}
	chosen := firstNonEmpty(pName, base)
	return m.InstallInline(chosen, chosen, pDesc, string(raw), source)
}

// InstallFromSource installs a skill from a local folder, local .md/.zip file,
// direct HTTP(S) SKILL.md/.zip URL, or GitHub repo/tree/blob URL.
func (m *Manager) InstallFromSource(ctx context.Context, source string) (Skill, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return Skill{}, errors.New("请提供 Skill 路径、链接或目录")
	}
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		return m.installFromURL(ctx, source)
	}
	return m.installFromLocal(source)
}

func (m *Manager) installFromLocal(src string) (Skill, error) {
	info, err := os.Stat(src)
	if err != nil {
		return Skill{}, fmt.Errorf("找不到本地路径：%s", src)
	}
	if !info.IsDir() {
		raw, err := os.ReadFile(src)
		if err != nil {
			return Skill{}, err
		}
		return m.InstallFromBytes(filepath.Base(src), raw, src)
	}

	// Find SKILL.md directly in dir or one level deep.
	skillDir := src
	skillFile := findSkillMD(src)
	if skillFile == "" {
		entries, _ := os.ReadDir(src)
		for _, e := range entries {
			if e.IsDir() {
				if f := findSkillMD(filepath.Join(src, e.Name())); f != "" {
					skillDir = filepath.Join(src, e.Name())
					skillFile = f
					break
				}
			}
		}
	}
	if skillFile == "" {
		return Skill{}, errors.New("目录中未找到 SKILL.md 文件")
	}
	raw, err := os.ReadFile(skillFile)
	if err != nil {
		return Skill{}, err
	}
	name, _, _ := ParseFrontmatter(string(raw))
	id := SanitizeID(firstNonEmpty(name, filepath.Base(skillDir)))
	if id == "" {
		id = fmt.Sprintf("skill-%d", time.Now().Unix())
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	dest := filepath.Join(m.dir, id)
	_ = os.RemoveAll(dest)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return Skill{}, err
	}
	copied := 0
	err = filepath.WalkDir(skillDir, func(p string, d os.DirEntry, wErr error) error {
		if wErr != nil {
			return nil
		}
		rel, err := filepath.Rel(skillDir, p)
		if err != nil || rel == "." {
			return nil
		}
		base := d.Name()
		if d.IsDir() {
			if base == ".git" || base == "node_modules" || base == "__pycache__" {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(dest, rel), 0o755)
		}
		if copied >= maxFilesPerSkill {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxSkillFileBytes {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		outPath := filepath.Join(dest, rel)
		if strings.EqualFold(rel, "skill.md") {
			outPath = filepath.Join(dest, "SKILL.md")
		}
		_ = os.MkdirAll(filepath.Dir(outPath), 0o755)
		if err := os.WriteFile(outPath, b, 0o644); err == nil {
			copied++
		}
		return nil
	})
	if err != nil {
		return Skill{}, err
	}
	if err := writeMeta(dest, metaFile{
		ID:          id,
		Enabled:     true,
		Source:      src,
		InstalledAt: time.Now().UnixMilli(),
	}); err != nil {
		return Skill{}, err
	}
	return m.readLocked(id)
}

func (m *Manager) installFromURL(ctx context.Context, rawURL string) (Skill, error) {
	candidates := expandSkillURLCandidates(rawURL)
	hc := &http.Client{Timeout: 30 * time.Second}
	var lastErr error
	for _, u := range candidates {
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("User-Agent", "handraw-client")
		resp, err := hc.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		data, rErr := io.ReadAll(io.LimitReader(resp.Body, maxZipBytes+1))
		resp.Body.Close()
		if rErr != nil {
			lastErr = rErr
			continue
		}
		if resp.StatusCode >= 400 {
			lastErr = fmt.Errorf("下载失败（HTTP %d）：%s", resp.StatusCode, u)
			continue
		}
		if len(data) > maxZipBytes {
			return Skill{}, errors.New("远程 Skill 包超过 16MB 限制")
		}
		ct := strings.ToLower(resp.Header.Get("Content-Type"))
		if strings.Contains(ct, "text/html") && !strings.HasPrefix(strings.TrimSpace(string(data)), "---") {
			lastErr = fmt.Errorf("链接返回了网页而非 SKILL.md：%s", u)
			continue
		}
		pu, _ := url.Parse(u)
		fname := path.Base(pu.Path)
		if strings.EqualFold(fname, "SKILL.md") || fname == "" || fname == "/" {
			// Try parent segment as fallback name
			dirSeg := path.Base(path.Dir(pu.Path))
			if dirSeg != "" && dirSeg != "." && dirSeg != "/" && dirSeg != "main" && dirSeg != "master" {
				fname = dirSeg + ".md"
			} else {
				fname = "SKILL.md"
			}
		}
		return m.InstallFromBytes(fname, data, rawURL)
	}
	if lastErr != nil {
		return Skill{}, lastErr
	}
	return Skill{}, errors.New("无法从该链接获取 SKILL.md")
}

func expandSkillURLCandidates(rawURL string) []string {
	pu, err := url.Parse(rawURL)
	if err != nil {
		return []string{rawURL}
	}
	if strings.EqualFold(pu.Host, "github.com") {
		segs := strings.Split(strings.Trim(pu.Path, "/"), "/")
		if len(segs) >= 2 {
			owner, repo := segs[0], strings.TrimSuffix(segs[1], ".git")
			if len(segs) >= 5 && segs[2] == "blob" {
				branch := segs[3]
				rest := strings.Join(segs[4:], "/")
				return []string{fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s", owner, repo, branch, rest)}
			}
			if len(segs) >= 5 && segs[2] == "tree" {
				branch := segs[3]
				rest := strings.TrimRight(strings.Join(segs[4:], "/"), "/")
				return []string{fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s/SKILL.md", owner, repo, branch, rest)}
			}
			return []string{
				fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/main/SKILL.md", owner, repo),
				fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/master/SKILL.md", owner, repo),
			}
		}
	}
	return []string{rawURL}
}

func (m *Manager) installZipBytes(raw []byte, fallbackName, source string) (Skill, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return Skill{}, fmt.Errorf("ZIP 解析失败：%w", err)
	}
	// Locate SKILL.md inside zip (root or nested directory).
	var skillEntry *zip.File
	var rootPrefix string
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		clean := path.Clean(strings.ReplaceAll(f.Name, "\\", "/"))
		if strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			continue
		}
		if strings.EqualFold(path.Base(clean), "SKILL.md") {
			skillEntry = f
			d := path.Dir(clean)
			if d != "." {
				rootPrefix = d + "/"
			}
			break
		}
	}
	if skillEntry == nil {
		return Skill{}, errors.New("压缩包中未找到 SKILL.md")
	}
	rc, err := skillEntry.Open()
	if err != nil {
		return Skill{}, err
	}
	skillBytes, err := io.ReadAll(io.LimitReader(rc, maxSkillFileBytes))
	rc.Close()
	if err != nil {
		return Skill{}, err
	}
	pName, _, _ := ParseFrontmatter(string(skillBytes))
	prefixBase := strings.Trim(rootPrefix, "/")
	if idx := strings.LastIndex(prefixBase, "/"); idx >= 0 {
		prefixBase = prefixBase[idx+1:]
	}
	id := SanitizeID(firstNonEmpty(pName, prefixBase, fallbackName))
	if id == "" {
		id = fmt.Sprintf("skill-%d", time.Now().Unix())
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	dest := filepath.Join(m.dir, id)
	_ = os.RemoveAll(dest)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return Skill{}, err
	}

	copied := 0
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || copied >= maxFilesPerSkill {
			continue
		}
		clean := path.Clean(strings.ReplaceAll(f.Name, "\\", "/"))
		if rootPrefix != "" {
			if !strings.HasPrefix(clean, rootPrefix) {
				continue
			}
			clean = strings.TrimPrefix(clean, rootPrefix)
		}
		if clean == "" || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			continue
		}
		outPath := filepath.Join(dest, filepath.FromSlash(clean))
		rel, err := filepath.Rel(dest, outPath)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if strings.EqualFold(rel, "skill.md") {
			outPath = filepath.Join(dest, "SKILL.md")
		}
		r, err := f.Open()
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(r, maxSkillFileBytes))
		r.Close()
		if err != nil {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(outPath), 0o755)
		if err := os.WriteFile(outPath, b, 0o644); err == nil {
			copied++
		}
	}
	if err := writeMeta(dest, metaFile{
		ID:          id,
		Enabled:     true,
		Source:      source,
		InstalledAt: time.Now().UnixMilli(),
	}); err != nil {
		return Skill{}, err
	}
	return m.readLocked(id)
}

func (m *Manager) readLocked(id string) (Skill, error) {
	dir := filepath.Join(m.dir, id)
	skillFile := findSkillMD(dir)
	if skillFile == "" {
		return Skill{}, fmt.Errorf("未找到 Skill：%s", id)
	}
	raw, err := os.ReadFile(skillFile)
	if err != nil {
		return Skill{}, err
	}
	content := strings.ReplaceAll(string(raw), "\r\n", "\n")
	name, desc, body := ParseFrontmatter(content)
	if name == "" {
		name = id
	}
	meta := metaFile{ID: id, Enabled: true}
	if mb, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
		_ = json.Unmarshal(mb, &meta)
	}
	if meta.InstalledAt == 0 {
		if st, err := os.Stat(skillFile); err == nil {
			meta.InstalledAt = st.ModTime().UnixMilli()
		}
	}
	return Skill{
		ID:          id,
		Name:        name,
		Description: desc,
		Content:     content,
		Body:        body,
		Enabled:     meta.Enabled,
		Source:      meta.Source,
		Dir:         dir,
		InstalledAt: meta.InstalledAt,
	}, nil
}

func findSkillMD(dir string) string {
	for _, name := range []string{"SKILL.md", "skill.md", "Skill.md"} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func writeMeta(dir string, meta metaFile) error {
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "meta.json"), b, 0o644)
}

// ParseFrontmatter extracts name, description, and body from a SKILL.md file.
func ParseFrontmatter(raw string) (name, desc, body string) {
	s := strings.TrimSpace(strings.ReplaceAll(raw, "\r\n", "\n"))
	body = s
	if strings.HasPrefix(s, "---\n") {
		rest := s[4:]
		if idx := strings.Index(rest, "\n---"); idx >= 0 {
			fm := rest[:idx]
			after := rest[idx+4:]
			body = strings.TrimSpace(strings.TrimPrefix(after, "\n"))
			for _, line := range strings.Split(fm, "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				k, v, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				k = strings.ToLower(strings.TrimSpace(k))
				v = strings.Trim(strings.TrimSpace(v), `"'`)
				switch k {
				case "name":
					name = v
				case "description":
					desc = v
				}
			}
		}
	}
	if name == "" {
		for _, ln := range strings.Split(body, "\n") {
			ln = strings.TrimSpace(ln)
			if strings.HasPrefix(ln, "# ") {
				name = strings.TrimSpace(strings.TrimPrefix(ln, "# "))
				break
			}
		}
	}
	if desc == "" {
		for _, ln := range strings.Split(body, "\n") {
			ln = strings.TrimSpace(ln)
			if ln == "" || strings.HasPrefix(ln, "#") || strings.HasPrefix(ln, "```") {
				continue
			}
			r := []rune(ln)
			if len(r) > 120 {
				desc = string(r[:120]) + "…"
			} else {
				desc = ln
			}
			break
		}
	}
	return name, desc, body
}

var reInvalidID = regexp.MustCompile(`[^\p{L}\p{N}_-]+`)

func SanitizeID(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	s = reInvalidID.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-_")
	if len([]rune(s)) > 48 {
		s = string([]rune(s)[:48])
	}
	return s
}

func yamlQuote(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if strings.ContainsAny(s, `:#"'[]{}`) {
		b, _ := json.Marshal(s)
		return string(b)
	}
	return s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
