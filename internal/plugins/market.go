package plugins

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Max unpacked size per plugin (2 GiB) so asset-heavy galleries (poses, outfits, styles) install cleanly.
const maxPluginUnpackedBytes int64 = 2 << 30
const maxPluginSingleFileBytes int64 = 256 << 20

// MarketLocalizedText maps BCP-47 language codes ("zh", "en", ...) to strings.
type MarketLocalizedText map[string]string

func (t MarketLocalizedText) Pick(prefs ...string) string {
	for _, k := range prefs {
		if v := strings.TrimSpace(t[k]); v != "" {
			return v
		}
	}
	for _, v := range t {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

type MarketMetaItem struct {
	Title MarketLocalizedText `json:"title"`
}

type MarketIndexMetadata struct {
	Categories map[string]MarketMetaItem `json:"categories,omitempty"`
	Labels     map[string]MarketMetaItem `json:"labels,omitempty"`
	SortKeys   map[string]MarketMetaItem `json:"sortKeys,omitempty"`
}

type MarketRepository struct {
	URL       string `json:"url"`
	Directory string `json:"directory,omitempty"`
}

type MarketPluginMetadata struct {
	Categories []string           `json:"categories,omitempty"`
	Labels     []string           `json:"labels,omitempty"`
	SortKeys   map[string]float64 `json:"sortKeys,omitempty"`
}

type MarketSourceSpec struct {
	Type      string `json:"type"`                // "git" | "npm"
	Registry  string `json:"registry,omitempty"`  // npm only
	URL       string `json:"url,omitempty"`       // git only
	Commit    string `json:"commit,omitempty"`    // git only
	Directory string `json:"directory,omitempty"` // git monorepo subdir
}

type MarketVersion struct {
	Version          string            `json:"version"`
	PublishTimestamp int64             `json:"publishTimestamp"`
	Source           MarketSourceSpec  `json:"source"`
	Engines          map[string]string `json:"engines,omitempty"`
}

type MarketPricing struct {
	Model      string `json:"model,omitempty"` // free | pro | credits | paid
	Credits    int    `json:"credits,omitempty"`
	PriceCents int    `json:"priceCents,omitempty"`
}

type MarketDelivery struct {
	Auth string `json:"auth,omitempty"` // none | handraw-account
}

type MarketPlugin struct {
	Name        string               `json:"name"`
	Title       MarketLocalizedText  `json:"title,omitempty"`
	Description MarketLocalizedText  `json:"description,omitempty"`
	Icon        string               `json:"icon,omitempty"`
	Author      string               `json:"author,omitempty"`
	Homepage    string               `json:"homepage,omitempty"`
	Repository  *MarketRepository    `json:"repository,omitempty"`
	Pricing     *MarketPricing       `json:"pricing,omitempty"`
	Delivery    *MarketDelivery      `json:"delivery,omitempty"`
	Metadata    MarketPluginMetadata `json:"metadata"`
	Versions    []MarketVersion      `json:"versions"`
}

// MarketIndex is DSH Format 1 (@deepseek-ai/dsh-plugin-market-index).
type MarketIndex struct {
	Format      int                 `json:"format"`
	Title       MarketLocalizedText `json:"title"`
	Description MarketLocalizedText `json:"description,omitempty"`
	Mirrors     map[string]string   `json:"mirrors,omitempty"`
	Metadata    MarketIndexMetadata `json:"metadata"`
	Plugins     []MarketPlugin      `json:"plugins"`
}

// ParseMarketIndex parses and validates a DSH Format 1 index.json and resolves
// relative icon URLs against indexURL.
func ParseMarketIndex(raw []byte, indexURL string) (MarketIndex, error) {
	var idx MarketIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return MarketIndex{}, fmt.Errorf("插件市场索引 JSON 无效：%w", err)
	}
	if idx.Format != 1 {
		return MarketIndex{}, fmt.Errorf("不支持的插件市场索引格式：format=%d（仅支持 DSH Format 1）", idx.Format)
	}
	base, _ := url.Parse(strings.TrimSpace(indexURL))
	for i := range idx.Plugins {
		p := &idx.Plugins[i]
		if p.Icon != "" && base != nil && !strings.HasPrefix(p.Icon, "data:") && !strings.HasPrefix(p.Icon, "http://") && !strings.HasPrefix(p.Icon, "https://") {
			if ref, err := url.Parse(p.Icon); err == nil {
				p.Icon = base.ResolveReference(ref).String()
			}
		}
	}
	return idx, nil
}

// FetchMarketIndex downloads and parses a DSH Format 1 market index URL.
func FetchMarketIndex(ctx context.Context, indexURL string) (MarketIndex, error) {
	indexURL = strings.TrimSpace(indexURL)
	if !strings.HasPrefix(indexURL, "https://") && !strings.HasPrefix(indexURL, "http://127.0.0.1") && !strings.HasPrefix(indexURL, "http://localhost") {
		return MarketIndex{}, errors.New("市场源地址必须是 https:// 链接")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", indexURL, nil)
	if err != nil {
		return MarketIndex{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "handraw-client")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return MarketIndex{}, fmt.Errorf("获取插件市场失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return MarketIndex{}, fmt.Errorf("插件市场返回 HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return MarketIndex{}, err
	}
	return ParseMarketIndex(data, indexURL)
}

var ghGitRe = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$`)

// InstallFromMarketVersion downloads and installs a plugin version from a DSH
// Format 1 market entry (supporting Git shallow/sparse clone, streaming tar.gz,
// disk-backed zip, and npm .tgz without forcing zip-only installs).
func (r *Runtime) InstallFromMarketVersion(ctx context.Context, pkgName string, ver MarketVersion, marketURL string) (Community, error) {
	sourceTag := fmt.Sprintf("market:%s@%s", pkgName, ver.Version)
	if marketURL != "" {
		sourceTag += " (" + marketURL + ")"
	}
	var c Community
	var err error
	switch ver.Source.Type {
	case "git":
		c, err = r.InstallGit(ctx, ver.Source.URL, ver.Source.Commit, ver.Source.Directory, sourceTag)
	case "npm":
		c, err = r.InstallNPM(ctx, pkgName, ver.Version, ver.Source.Registry, sourceTag)
	default:
		return Community{}, fmt.Errorf("不支持的市场安装源类型：%q", ver.Source.Type)
	}
	if err != nil {
		return c, err
	}
	meta := InstallMeta{
		Type:      "market",
		Source:    sourceTag,
		MarketURL: marketURL,
		Package:   pkgName,
		Registry:  ver.Source.Registry,
		RepoURL:   ver.Source.URL,
		Subdir:    cleanRelSubdir(ver.Source.Directory),
		Commit:    strings.TrimSpace(ver.Source.Commit),
	}
	if c.Install != nil && c.Install.Commit != "" && meta.Commit == "" {
		meta.Commit = c.Install.Commit
	}
	_ = r.SaveInstallMeta(c.ID, meta)
	c.Install = &meta
	return c, nil
}

// InstallNPM fetches a package from npm (with npmmirror fallback) and unpacks
// its .tgz tarball directly in streaming Go (no local npm CLI required).
func (r *Runtime) InstallNPM(ctx context.Context, pkgName, version, registry, sourceTag string) (Community, error) {
	if strings.TrimSpace(version) == "" {
		version = "latest"
	}
	tarballURL, err := resolveNPMTarballURL(ctx, pkgName, version, registry)
	if err != nil {
		return Community{}, err
	}
	c, err := r.InstallTarGzURL(ctx, tarballURL, "", sourceTag)
	if err != nil {
		return c, err
	}
	meta := InstallMeta{
		Type:     "npm",
		Source:   sourceTag,
		Package:  pkgName,
		Registry: strings.TrimSpace(registry),
	}
	_ = r.SaveInstallMeta(c.ID, meta)
	c.Install = &meta
	return c, nil
}

// InstallGit installs a plugin from any Git repository URL (with optional commit
// and monorepo subdirectory). When local `git` is installed, it uses shallow
// fetch + sparse-checkout (only fetching the target subdir for huge monorepos!).
// Otherwise it falls back to streaming GitHub tar.gz (constant RAM, no zip size cap).
func (r *Runtime) InstallGit(ctx context.Context, repoURL, commit, subdir, sourceTag string) (Community, error) {
	repoURL = strings.TrimSpace(repoURL)
	commit = strings.TrimSpace(commit)
	cleanSub := cleanRelSubdir(subdir)

	// Direct archive URLs (e.g. test mocks or direct .zip / .tgz links).
	lower := strings.ToLower(repoURL)
	if strings.HasSuffix(lower, ".zip") {
		c, err := r.InstallZipURL(ctx, repoURL, cleanSub, sourceTag)
		if err == nil {
			meta := InstallMeta{Type: "url", Source: sourceTag, RepoURL: repoURL, Subdir: cleanSub, Commit: commit}
			_ = r.SaveInstallMeta(c.ID, meta)
			c.Install = &meta
		}
		return c, err
	}
	if strings.HasSuffix(lower, ".tgz") || strings.HasSuffix(lower, ".tar.gz") {
		c, err := r.InstallTarGzURL(ctx, repoURL, cleanSub, sourceTag)
		if err == nil {
			meta := InstallMeta{Type: "url", Source: sourceTag, RepoURL: repoURL, Subdir: cleanSub, Commit: commit}
			_ = r.SaveInstallMeta(c.ID, meta)
			c.Install = &meta
		}
		return c, err
	}

	// Strategy 1: Native Git shallow clone / sparse-checkout (works on GitHub, Gitee, GitLab, any repo size).
	if gitBin, err := exec.LookPath("git"); err == nil && gitBin != "" {
		if c, gitErr := r.installViaGitCLI(ctx, gitBin, repoURL, commit, cleanSub, sourceTag); gitErr == nil {
			return c, nil
		} else if !ghGitRe.MatchString(repoURL) {
			return Community{}, fmt.Errorf("Git 拉取插件失败：%w", gitErr)
		}
		// If git CLI failed on a GitHub URL (e.g. proxy mismatch), fall through to HTTPS streaming tar.gz.
	}

	// Strategy 2: Streaming GitHub tar.gz (zero git CLI required, constant RAM, no 80 MB truncation).
	if m := ghGitRe.FindStringSubmatch(repoURL); m != nil {
		ref := commit
		if ref == "" {
			ref = "HEAD"
		}
		tarURL := fmt.Sprintf("https://codeload.github.com/%s/%s/tar.gz/%s", m[1], m[2], url.PathEscape(ref))
		c, err := r.InstallTarGzURL(ctx, tarURL, cleanSub, sourceTag)
		if err == nil {
			resolvedCommit := commit
			if resolvedCommit == "" || strings.EqualFold(resolvedCommit, "HEAD") {
				if sha, hErr := ResolveGitHeadCommit(ctx, repoURL); hErr == nil {
					resolvedCommit = sha
				}
			}
			meta := InstallMeta{Type: "git", Source: sourceTag, RepoURL: repoURL, Subdir: cleanSub, Commit: resolvedCommit}
			_ = r.SaveInstallMeta(c.ID, meta)
			c.Install = &meta
		}
		return c, err
	}

	return Community{}, fmt.Errorf("未检测到本机 git，且暂无法直接归档下载该仓库：%s", repoURL)
}

func (r *Runtime) installViaGitCLI(ctx context.Context, gitBin, repoURL, commit, cleanSub, sourceTag string) (Community, error) {
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return Community{}, err
	}
	tmp, err := os.MkdirTemp(r.Dir, ".git-install-")
	if err != nil {
		return Community{}, err
	}
	defer os.RemoveAll(tmp)

	gitCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	runGit := func(args ...string) error {
		cmd := exec.CommandContext(gitCtx, gitBin, args...)
		cmd.Dir = tmp
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		hideWindow(cmd)
		out, err := cmd.CombinedOutput()
		if err != nil {
			msg := strings.TrimSpace(string(out))
			if len(msg) > 260 {
				msg = msg[len(msg)-260:]
			}
			return fmt.Errorf("%s: %w (%s)", strings.Join(args, " "), err, msg)
		}
		return nil
	}

	if err := runGit("init", "-q"); err != nil {
		return Community{}, err
	}
	if err := runGit("remote", "add", "origin", repoURL); err != nil {
		return Community{}, err
	}
	targetRef := commit
	if targetRef == "" {
		targetRef = "HEAD"
	}

	if cleanSub != "" {
		// Monorepo sparse-checkout: fetch only the plugin subdirectory blobs!
		_ = runGit("sparse-checkout", "init", "--cone")
		_ = runGit("sparse-checkout", "set", cleanSub)
		if err := runGit("fetch", "--depth", "1", "--filter=blob:none", "origin", targetRef); err != nil {
			if err2 := runGit("fetch", "--depth", "1", "origin", targetRef); err2 != nil {
				return Community{}, err2
			}
		}
	} else {
		if err := runGit("fetch", "--depth", "1", "origin", targetRef); err != nil {
			return Community{}, err
		}
	}
	if err := runGit("checkout", "--force", "-q", "FETCH_HEAD"); err != nil {
		return Community{}, err
	}

	// Record exact checked-out commit SHA before deleting .git metadata.
	resolvedCommit := commit
	revCmd := exec.CommandContext(gitCtx, gitBin, "rev-parse", "HEAD")
	revCmd.Dir = tmp
	hideWindow(revCmd)
	if revOut, revErr := revCmd.Output(); revErr == nil {
		if sha := strings.TrimSpace(string(revOut)); len(sha) >= 7 {
			resolvedCommit = sha
		}
	}

	// Prepare final clean unpacked directory without .git metadata.
	var c Community
	if cleanSub != "" {
		srcDir := filepath.Join(tmp, filepath.FromSlash(cleanSub))
		if st, err := os.Stat(srcDir); err != nil || !st.IsDir() {
			return Community{}, fmt.Errorf("仓库中找不到插件子目录 %s", cleanSub)
		}
		cleanTmp, err := os.MkdirTemp(r.Dir, ".install-")
		if err != nil {
			return Community{}, err
		}
		// Move the extracted subdirectory out so tmp (.git) gets deleted cleanly.
		_ = os.RemoveAll(cleanTmp)
		if err := os.Rename(srcDir, cleanTmp); err != nil {
			return Community{}, err
		}
		defer os.RemoveAll(cleanTmp)
		c, err = r.commitUnpackedDir(cleanTmp, sourceTag)
		if err != nil {
			return c, err
		}
	} else {
		_ = os.RemoveAll(filepath.Join(tmp, ".git"))
		c, err = r.commitUnpackedDir(tmp, sourceTag)
		if err != nil {
			return c, err
		}
	}
	meta := InstallMeta{
		Type:    "git",
		Source:  sourceTag,
		RepoURL: repoURL,
		Subdir:  cleanSub,
		Commit:  resolvedCommit,
	}
	_ = r.SaveInstallMeta(c.ID, meta)
	c.Install = &meta
	return c, nil
}

func resolveNPMTarballURL(ctx context.Context, pkgName, version, registry string) (string, error) {
	registries := []string{}
	if strings.TrimSpace(registry) != "" {
		registries = append(registries, strings.TrimRight(strings.TrimSpace(registry), "/"))
	} else {
		registries = append(registries, "https://registry.npmmirror.com", "https://registry.npmjs.org")
	}
	escapedName := url.PathEscape(pkgName)
	escapedVer := url.PathEscape(version)
	var lastErr error
	for _, reg := range registries {
		metaURL := fmt.Sprintf("%s/%s/%s", reg, escapedName, escapedVer)
		b, err := downloadBytes(ctx, metaURL, 2<<20)
		if err != nil {
			lastErr = err
			continue
		}
		var meta struct {
			Dist struct {
				Tarball string `json:"tarball"`
			} `json:"dist"`
		}
		if err := json.Unmarshal(b, &meta); err != nil {
			lastErr = err
			continue
		}
		if strings.HasPrefix(meta.Dist.Tarball, "https://") || strings.HasPrefix(meta.Dist.Tarball, "http://127.0.0.1") || strings.HasPrefix(meta.Dist.Tarball, "http://localhost") {
			return meta.Dist.Tarball, nil
		}
		lastErr = errors.New("npm 元数据缺少有效的 tarball 地址")
	}
	if lastErr == nil {
		lastErr = errors.New("无法解析 npm 插件下载地址")
	}
	return "", fmt.Errorf("查询 npm 包 %s@%s 失败：%w", pkgName, version, lastErr)
}

func downloadBytes(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "handraw-client")
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// InstallZipURL downloads a zip archive to a temporary file on disk (no RAM cap
// truncation) and unpacks it safely.
func (r *Runtime) InstallZipURL(ctx context.Context, rawURL, subdir, source string) (Community, error) {
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return Community{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return Community{}, err
	}
	req.Header.Set("User-Agent", "handraw-client")
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return Community{}, fmt.Errorf("下载插件压缩包失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return Community{}, fmt.Errorf("下载插件压缩包失败：HTTP %d", resp.StatusCode)
	}
	tmpFile, err := os.CreateTemp(r.Dir, ".download-*.zip")
	if err != nil {
		return Community{}, err
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)
	n, err := io.Copy(tmpFile, io.LimitReader(resp.Body, maxPluginUnpackedBytes+1))
	_ = tmpFile.Close()
	if err != nil {
		return Community{}, fmt.Errorf("保存插件压缩包失败：%w", err)
	}
	if n > maxPluginUnpackedBytes {
		return Community{}, errors.New("插件压缩包超过 2 GB 限制")
	}
	zr, err := zip.OpenReader(tmpPath)
	if err != nil {
		return Community{}, errors.New("下载的文件不是有效的 zip（可能网络中断或源地址返回了错误页）")
	}
	defer zr.Close()
	return r.unpackZipFiles(zr.File, subdir, source)
}

// InstallTarGzURL streams a .tar.gz / .tgz directly from HTTP into r.Dir with
// constant memory usage (supports both npm tarballs and GitHub codeload tar.gz).
func (r *Runtime) InstallTarGzURL(ctx context.Context, rawURL, subdir, source string) (Community, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return Community{}, err
	}
	req.Header.Set("User-Agent", "handraw-client")
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return Community{}, fmt.Errorf("下载插件包失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return Community{}, fmt.Errorf("下载插件包失败：HTTP %d", resp.StatusCode)
	}
	return r.InstallTarGzStream(resp.Body, subdir, source)
}

// InstallZipSubdir unpacks a plugin zip byte slice, optionally extracting only
// a clean relative subdirectory.
func (r *Runtime) InstallZipSubdir(data []byte, subdir, source string) (Community, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Community{}, errors.New("插件包不是有效的 zip")
	}
	return r.unpackZipFiles(zr.File, subdir, source)
}

func (r *Runtime) unpackZipFiles(files []*zip.File, subdir, source string) (Community, error) {
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return Community{}, err
	}
	tmp, err := os.MkdirTemp(r.Dir, ".install-")
	if err != nil {
		return Community{}, err
	}
	defer os.RemoveAll(tmp)

	prefix := detectZipSingleTopPrefix(files)
	cleanSub := cleanRelSubdir(subdir)
	if cleanSub != "" {
		prefix += cleanSub + "/"
	}

	var total int64
	for _, f := range files {
		if !strings.HasPrefix(f.Name, prefix) {
			continue
		}
		name := strings.TrimPrefix(f.Name, prefix)
		if name == "" || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > maxPluginUnpackedBytes {
			return Community{}, errors.New("插件包解压体积超过 2 GB 上限")
		}
		dst := filepath.Join(tmp, filepath.FromSlash(name))
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(dst, 0o755)
			continue
		}
		_ = os.MkdirAll(filepath.Dir(dst), 0o755)
		rc, err := f.Open()
		if err != nil {
			return Community{}, err
		}
		outF, err := os.Create(dst)
		if err != nil {
			rc.Close()
			return Community{}, err
		}
		_, cpErr := io.Copy(outF, io.LimitReader(rc, maxPluginSingleFileBytes))
		_ = outF.Close()
		rc.Close()
		if cpErr != nil {
			return Community{}, cpErr
		}
	}
	return r.commitUnpackedDir(tmp, source)
}

func detectZipSingleTopPrefix(files []*zip.File) string {
	if len(files) == 0 {
		return ""
	}
	first := files[0].Name
	i := strings.IndexByte(first, '/')
	if i <= 0 {
		return ""
	}
	prefix := first[:i+1]
	for _, f := range files {
		if !strings.HasPrefix(f.Name, prefix) {
			return ""
		}
	}
	return prefix
}

func cleanRelSubdir(subdir string) string {
	s := strings.TrimSpace(subdir)
	if s == "" {
		return ""
	}
	cleaned := strings.Trim(path.Clean("/"+strings.ReplaceAll(s, "\\", "/")), "/")
	if cleaned == "." {
		return ""
	}
	return cleaned
}

// InstallTarGz unpacks a .tgz / .tar.gz byte slice safely into r.Dir.
func (r *Runtime) InstallTarGz(data []byte, source string) (Community, error) {
	return r.InstallTarGzStream(bytes.NewReader(data), "", source)
}

// InstallTarGzStream streams a .tgz / .tar.gz reader safely into r.Dir,
// stripping the single top-level wrapper folder (such as npm's "package/" or
// GitHub's "<repo>-<commit>/") and optional monorepo subdir.
func (r *Runtime) InstallTarGzStream(rd io.Reader, subdir, source string) (Community, error) {
	gr, err := gzip.NewReader(rd)
	if err != nil {
		return Community{}, errors.New("插件包不是有效的 .tar.gz / .tgz 格式")
	}
	defer gr.Close()
	tr := tar.NewReader(gr)
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return Community{}, err
	}
	tmp, err := os.MkdirTemp(r.Dir, ".install-")
	if err != nil {
		return Community{}, err
	}
	defer os.RemoveAll(tmp)

	cleanSub := cleanRelSubdir(subdir)
	topPrefix := ""
	topPrefixSet := false

	var total int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Community{}, fmt.Errorf("解压插件 tar.gz 失败：%w", err)
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader || hdr.Typeflag == tar.TypeXHeader {
			continue
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		rawName := strings.TrimPrefix(strings.ReplaceAll(hdr.Name, "\\", "/"), "./")
		if rawName == "" || rawName == "." {
			continue
		}
		if !topPrefixSet {
			if idx := strings.IndexByte(rawName, '/'); idx > 0 {
				topPrefix = rawName[:idx+1]
			}
			topPrefixSet = true
		}
		name := rawName
		if topPrefix != "" && strings.HasPrefix(name, topPrefix) {
			name = strings.TrimPrefix(name, topPrefix)
		}
		if cleanSub != "" {
			subPfx := cleanSub + "/"
			if !strings.HasPrefix(name, subPfx) {
				continue
			}
			name = strings.TrimPrefix(name, subPfx)
		}
		if name == "" || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			continue
		}
		dst := filepath.Join(tmp, filepath.FromSlash(name))
		if hdr.Typeflag == tar.TypeDir {
			_ = os.MkdirAll(dst, 0o755)
			continue
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		total += hdr.Size
		if total > maxPluginUnpackedBytes {
			return Community{}, errors.New("插件包解压体积超过 2 GB 上限")
		}
		_ = os.MkdirAll(filepath.Dir(dst), 0o755)
		outF, err := os.Create(dst)
		if err != nil {
			return Community{}, err
		}
		_, cpErr := io.Copy(outF, io.LimitReader(tr, maxPluginSingleFileBytes))
		_ = outF.Close()
		if cpErr != nil {
			return Community{}, cpErr
		}
	}
	return r.commitUnpackedDir(tmp, source)
}

func (r *Runtime) commitUnpackedDir(tmp, source string) (Community, error) {
	c, err := ReadCommunity(tmp)
	if err != nil {
		return c, err
	}
	final := filepath.Join(r.Dir, c.ID)
	_ = os.RemoveAll(final + ".old")
	if _, err := os.Stat(final); err == nil {
		if err := os.Rename(final, final+".old"); err != nil {
			return c, err
		}
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Rename(final+".old", final)
		return c, err
	}
	_ = os.RemoveAll(final + ".old")
	_ = os.WriteFile(filepath.Join(final, ".source"), []byte(source), 0o644)
	c.Dir = final
	c.Source = source
	return c, nil
}
