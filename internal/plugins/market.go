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
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

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

type MarketPlugin struct {
	Name        string               `json:"name"`
	Title       MarketLocalizedText  `json:"title,omitempty"`
	Description MarketLocalizedText  `json:"description,omitempty"`
	Icon        string               `json:"icon,omitempty"`
	Author      string               `json:"author,omitempty"`
	Homepage    string               `json:"homepage,omitempty"`
	Repository  *MarketRepository    `json:"repository,omitempty"`
	Metadata    MarketPluginMetadata `json:"metadata"`
	Versions    []MarketVersion      `json:"versions"`
}

// MarketIndex is DSH Format 1 (@deepseek-ai/dsh-plugin-market-index).
type MarketIndex struct {
	Format      int                 `json:"format"`
	Title       MarketLocalizedText `json:"title"`
	Description MarketLocalizedText `json:"description,omitempty"`
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
// Format 1 market entry (supporting both "git" and "npm" sources without needing
// local git or npm CLIs).
func (r *Runtime) InstallFromMarketVersion(ctx context.Context, pkgName string, ver MarketVersion, marketURL string) (Community, error) {
	sourceTag := fmt.Sprintf("market:%s@%s", pkgName, ver.Version)
	if marketURL != "" {
		sourceTag += " (" + marketURL + ")"
	}
	switch ver.Source.Type {
	case "git":
		zipURL, err := gitArchiveZipURL(ver.Source.URL, ver.Source.Commit)
		if err != nil {
			return Community{}, err
		}
		data, err := downloadBytes(ctx, zipURL, 80<<20)
		if err != nil {
			return Community{}, fmt.Errorf("下载插件压缩包失败：%w", err)
		}
		return r.InstallZipSubdir(data, ver.Source.Directory, sourceTag)
	case "npm":
		tarballURL, err := resolveNPMTarballURL(ctx, pkgName, ver.Version, ver.Source.Registry)
		if err != nil {
			return Community{}, err
		}
		data, err := downloadBytes(ctx, tarballURL, 80<<20)
		if err != nil {
			return Community{}, fmt.Errorf("下载 npm 插件包失败：%w", err)
		}
		return r.InstallTarGz(data, sourceTag)
	default:
		return Community{}, fmt.Errorf("不支持的市场安装源类型：%q", ver.Source.Type)
	}
}

func gitArchiveZipURL(repoURL, commit string) (string, error) {
	repoURL = strings.TrimSpace(repoURL)
	commit = strings.TrimSpace(commit)
	if commit == "" {
		commit = "HEAD"
	}
	if m := ghGitRe.FindStringSubmatch(repoURL); m != nil {
		return fmt.Sprintf("https://codeload.github.com/%s/%s/zip/%s", m[1], m[2], url.PathEscape(commit)), nil
	}
	if strings.HasPrefix(repoURL, "http://127.0.0.1") || strings.HasPrefix(repoURL, "http://localhost") {
		if strings.HasSuffix(repoURL, ".zip") {
			return repoURL, nil
		}
	}
	return "", fmt.Errorf("暂仅支持 GitHub 仓库的免 Git 安装：%s", repoURL)
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

// InstallZipSubdir unpacks a plugin zip archive, optionally extracting only a
// clean relative subdirectory (e.g., "plugins/dsh-handraw-style" inside a monorepo).
func (r *Runtime) InstallZipSubdir(data []byte, subdir, source string) (Community, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Community{}, errors.New("插件包不是有效的 zip")
	}
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return Community{}, err
	}
	tmp, err := os.MkdirTemp(r.Dir, ".install-")
	if err != nil {
		return Community{}, err
	}
	defer os.RemoveAll(tmp)

	prefix := detectZipSingleTopPrefix(zr.File)
	cleanSub := strings.Trim(path.Clean("/"+strings.ReplaceAll(strings.TrimSpace(subdir), "\\", "/")), "/")
	if cleanSub != "" {
		prefix += cleanSub + "/"
	}

	var total int64
	for _, f := range zr.File {
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
		if total > 150<<20 {
			return Community{}, errors.New("插件包过大")
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
		b, err := io.ReadAll(io.LimitReader(rc, 60<<20))
		rc.Close()
		if err != nil {
			return Community{}, err
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return Community{}, err
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

// InstallTarGz unpacks an npm-style .tgz tarball into r.Dir safely.
func (r *Runtime) InstallTarGz(data []byte, source string) (Community, error) {
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return Community{}, errors.New("插件包不是有效的 .tgz (gzip)")
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

	var total int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Community{}, fmt.Errorf("解压插件 tar 失败：%w", err)
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		name := strings.TrimPrefix(strings.ReplaceAll(hdr.Name, "\\", "/"), "./")
		// npm tarballs wrap contents under "package/".
		if strings.HasPrefix(name, "package/") {
			name = strings.TrimPrefix(name, "package/")
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
		if total > 150<<20 {
			return Community{}, errors.New("插件包过大")
		}
		_ = os.MkdirAll(filepath.Dir(dst), 0o755)
		b, err := io.ReadAll(io.LimitReader(tr, 60<<20))
		if err != nil {
			return Community{}, err
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return Community{}, err
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
