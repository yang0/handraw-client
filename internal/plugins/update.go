package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const installMetaFile = ".install.json"

// InstallMeta records structured provenance and update history for an installed
// community plugin (stored in <pluginSlot>/.install.json).
type InstallMeta struct {
	Type         string `json:"type"`                   // market | git | npm | local | url
	Source       string `json:"source,omitempty"`       // human-readable original source string
	MarketURL    string `json:"marketUrl,omitempty"`    // DSH Format 1 market index.json URL
	MarketSource string `json:"marketSource,omitempty"` // settings.PluginMarketSource.ID
	Package      string `json:"package,omitempty"`      // market or npm package name
	Registry     string `json:"registry,omitempty"`     // custom npm registry if any
	RepoURL      string `json:"repoUrl,omitempty"`      // git repository URL
	Subdir       string `json:"subdir,omitempty"`       // monorepo subdirectory
	Commit       string `json:"commit,omitempty"`       // installed git commit SHA
	InstalledAt  int64  `json:"installedAt,omitempty"`  // unix ms
	UpdatedAt    int64  `json:"updatedAt,omitempty"`    // unix ms
	UpdatedFrom  string `json:"updatedFrom,omitempty"`  // previous version/commit
	UpdatedTo    string `json:"updatedTo,omitempty"`    // upgraded version/commit
}

var marketSourceRe = regexp.MustCompile(`^market:([^\s@]+)(?:@([^\s(]+))?(?:\s*\(([^)]+)\))?$`)

// ReadInstallMeta reads .install.json from a plugin slot directory, falling back
// to inferring metadata from legacy .link / .source files for smooth upgrades.
func ReadInstallMeta(slotDir string) *InstallMeta {
	if b, err := os.ReadFile(filepath.Join(slotDir, installMetaFile)); err == nil && len(b) > 0 {
		var m InstallMeta
		if json.Unmarshal(b, &m) == nil && m.Type != "" {
			return &m
		}
	}
	if _, err := os.Stat(filepath.Join(slotDir, ".link")); err == nil {
		src, _ := os.ReadFile(filepath.Join(slotDir, ".source"))
		return &InstallMeta{
			Type:   "local",
			Source: strings.TrimSpace(string(src)),
		}
	}
	rawSrc, _ := os.ReadFile(filepath.Join(slotDir, ".source"))
	src := strings.TrimSpace(string(rawSrc))
	if src == "" {
		return nil
	}
	if m := marketSourceRe.FindStringSubmatch(src); m != nil {
		return &InstallMeta{
			Type:      "market",
			Source:    src,
			Package:   m[1],
			MarketURL: strings.TrimSpace(m[3]),
		}
	}
	if strings.HasPrefix(src, "npm:") {
		spec := strings.TrimSpace(strings.TrimPrefix(src, "npm:"))
		pkg := spec
		if i := strings.LastIndexByte(spec, '@'); i > 0 {
			pkg = spec[:i]
		}
		return &InstallMeta{
			Type:    "npm",
			Source:  src,
			Package: pkg,
		}
	}
	if m := ghRe.FindStringSubmatch(src); m != nil {
		return &InstallMeta{
			Type:    "git",
			Source:  src,
			RepoURL: fmt.Sprintf("https://github.com/%s/%s.git", m[1], m[2]),
		}
	}
	lower := strings.ToLower(src)
	if strings.HasPrefix(lower, "https://") {
		if strings.HasSuffix(lower, ".git") || strings.Contains(lower, "github.com/") || strings.Contains(lower, "gitee.com/") || strings.Contains(lower, "gitlab.com/") {
			if !strings.HasSuffix(lower, ".zip") && !strings.HasSuffix(lower, ".tar.gz") && !strings.HasSuffix(lower, ".tgz") {
				return &InstallMeta{
					Type:    "git",
					Source:  src,
					RepoURL: src,
				}
			}
		}
		return &InstallMeta{
			Type:   "url",
			Source: src,
		}
	}
	return &InstallMeta{
		Type:   "local",
		Source: src,
	}
}

// WriteInstallMeta writes .install.json (and preserves .source) inside slotDir.
func WriteInstallMeta(slotDir string, meta InstallMeta) error {
	if meta.InstalledAt == 0 {
		meta.InstalledAt = time.Now().UnixMilli()
	}
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(slotDir, installMetaFile), b, 0o644); err != nil {
		return err
	}
	if meta.Source != "" {
		_ = os.WriteFile(filepath.Join(slotDir, ".source"), []byte(meta.Source), 0o644)
	}
	return nil
}

// SaveInstallMeta updates .install.json for an installed plugin by ID.
func (r *Runtime) SaveInstallMeta(id string, meta InstallMeta) error {
	if !idRe.MatchString(id) {
		return errors.New("插件 id 无效")
	}
	slot := filepath.Join(r.Dir, id)
	if st, err := os.Stat(slot); err != nil || !st.IsDir() {
		return errors.New("插件目录不存在")
	}
	return WriteInstallMeta(slot, meta)
}

var semverRe = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?(?:\+.*)?$`)

type parsedSemver struct {
	major int
	minor int
	patch int
	pre   string
}

func parseSemver(v string) (parsedSemver, bool) {
	m := semverRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return parsedSemver{}, false
	}
	maj, err1 := strconv.Atoi(m[1])
	min, err2 := strconv.Atoi(m[2])
	pat, err3 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		return parsedSemver{}, false
	}
	return parsedSemver{major: maj, minor: min, patch: pat, pre: m[4]}, true
}

// NewerVersion reports whether candidate is strictly newer than current using
// SemVer 2.0.0 precedence (matching Magpie's update.Newer). Invalid or equal
// versions return false so local/dev builds are never offered a downgrade.
func NewerVersion(candidate, current string) bool {
	a, okA := parseSemver(candidate)
	b, okB := parseSemver(current)
	if !okA || !okB {
		return false
	}
	if a.major != b.major {
		return a.major > b.major
	}
	if a.minor != b.minor {
		return a.minor > b.minor
	}
	if a.patch != b.patch {
		return a.patch > b.patch
	}
	if a.pre == b.pre {
		return false
	}
	if a.pre == "" || b.pre == "" {
		return a.pre == ""
	}
	sa := strings.Split(a.pre, ".")
	sb := strings.Split(b.pre, ".")
	for i := 0; i < len(sa) && i < len(sb); i++ {
		na, ea := strconv.Atoi(sa[i])
		nb, eb := strconv.Atoi(sb[i])
		switch {
		case ea == nil && eb == nil:
			if na != nb {
				return na > nb
			}
		case (ea == nil) != (eb == nil):
			return eb == nil // numeric prerelease < alphanumeric
		default:
			if sa[i] != sb[i] {
				return sa[i] > sb[i]
			}
		}
	}
	return len(sa) > len(sb)
}

// SameCommit compares two git commit SHAs (allowing short/full prefix match).
func SameCommit(a, b string) bool {
	a = strings.ToLower(strings.TrimSpace(a))
	b = strings.ToLower(strings.TrimSpace(b))
	if a == "" || b == "" {
		return false
	}
	if len(a) > len(b) {
		return strings.HasPrefix(a, b)
	}
	return strings.HasPrefix(b, a)
}

// ShortCommit returns a 7-character short git SHA for display.
func ShortCommit(sha string) string {
	s := strings.TrimSpace(sha)
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// ResolveNPMLatestVersion fetches the latest published version of pkgName from
// npm (using custom registry if given, otherwise npmmirror + npmjs fallback).
func ResolveNPMLatestVersion(ctx context.Context, pkgName, registry string) (string, error) {
	pkgName = strings.TrimSpace(pkgName)
	if pkgName == "" {
		return "", errors.New("缺少 npm 包名")
	}
	registries := []string{}
	if strings.TrimSpace(registry) != "" {
		registries = append(registries, strings.TrimRight(strings.TrimSpace(registry), "/"))
	} else {
		registries = append(registries, "https://registry.npmmirror.com", "https://registry.npmjs.org")
	}
	escaped := strings.Replace(url.PathEscape(pkgName), "%40", "@", 1)
	var lastErr error
	for _, reg := range registries {
		cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		metaURL := fmt.Sprintf("%s/%s/latest", reg, escaped)
		b, err := downloadBytes(cctx, metaURL, 2<<20)
		cancel()
		if err != nil {
			lastErr = err
			continue
		}
		var meta struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(b, &meta); err != nil {
			lastErr = err
			continue
		}
		if v := strings.TrimSpace(meta.Version); v != "" {
			return v, nil
		}
		lastErr = errors.New("npm 返回缺少 version 字段")
	}
	if lastErr == nil {
		lastErr = errors.New("无法查询 npm 最新版本")
	}
	return "", lastErr
}

// ResolveGitHeadCommit queries the remote repository's current HEAD commit SHA.
// Prefers local `git ls-remote` (fast, no GitHub API rate limit, works on any
// Git host); falls back to GitHub REST API for GitHub URLs when git is absent.
func ResolveGitHeadCommit(ctx context.Context, repoURL string) (string, error) {
	repoURL = strings.TrimSpace(repoURL)
	if repoURL == "" {
		return "", errors.New("缺少 Git 仓库地址")
	}
	var gitErr error
	if gitBin, err := exec.LookPath("git"); err == nil && gitBin != "" {
		cctx, cancel := context.WithTimeout(ctx, 12*time.Second)
		cmd := exec.CommandContext(cctx, gitBin, "ls-remote", repoURL, "HEAD")
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		hideWindow(cmd)
		out, err := cmd.CombinedOutput()
		cancel()
		if err == nil {
			lines := strings.Split(strings.TrimSpace(string(out)), "\n")
			if len(lines) > 0 {
				fields := strings.Fields(lines[0])
				if len(fields) > 0 && len(fields[0]) >= 7 {
					return fields[0], nil
				}
			}
			gitErr = errors.New("远端仓库未返回 HEAD 提交")
		} else {
			msg := strings.TrimSpace(string(out))
			if len(msg) > 180 {
				msg = msg[len(msg)-180:]
			}
			gitErr = fmt.Errorf("git ls-remote 失败：%v (%s)", err, msg)
		}
	}

	if m := ghGitRe.FindStringSubmatch(repoURL); m != nil {
		apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/commits/HEAD", m[1], m[2])
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(cctx, "GET", apiURL, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "handraw-client")
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return "", fmt.Errorf("GitHub API 返回 HTTP %d", resp.StatusCode)
		}
		var payload struct {
			SHA string `json:"sha"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			return "", err
		}
		if strings.TrimSpace(payload.SHA) != "" {
			return strings.TrimSpace(payload.SHA), nil
		}
	}
	if gitErr != nil {
		return "", gitErr
	}
	return "", errors.New("无法查询 Git 远端最新提交")
}
