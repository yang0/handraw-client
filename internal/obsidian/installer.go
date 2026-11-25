package obsidian

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type MarketPricing struct {
	Model      string `json:"model,omitempty"` // free | pro | credits | paid
	Credits    int    `json:"credits,omitempty"`
	PriceCents int    `json:"priceCents,omitempty"`
}

type MarketDelivery struct {
	Auth string `json:"auth,omitempty"` // none | handraw-account
}

// CatalogItem represents an entry from Handraw's curated Format 1 Obsidian
// writing plugins market or Obsidian's community-plugins.json registry (#127).
type CatalogItem struct {
	ID               string            `json:"id"`
	Version          string            `json:"version,omitempty"`
	Name             string            `json:"name"`
	Author           string            `json:"author"`
	License          string            `json:"license,omitempty"`
	Description      string            `json:"description"`
	Repo             string            `json:"repo"` // owner/repo
	Homepage         string            `json:"homepage,omitempty"`
	Downloads        int64             `json:"downloads,omitempty"`
	Categories       []string          `json:"categories,omitempty"`
	Featured         bool              `json:"featured,omitempty"`
	FeaturedTag      string            `json:"featuredTag,omitempty"`
	FeaturedSummary  string            `json:"featuredSummary,omitempty"`
	Installed        bool              `json:"installed,omitempty"`
	InstalledVersion string            `json:"installedVersion,omitempty"`
	Enabled          bool              `json:"enabled,omitempty"`
	CompatLevel      string            `json:"compatLevel,omitempty"`
	Tags             []string          `json:"tags,omitempty"`
	DownloadMirrors  map[string]string `json:"downloadMirrors,omitempty"`
	Files            []string          `json:"files,omitempty"`
	Pricing          *MarketPricing    `json:"pricing,omitempty"`
	Delivery         *MarketDelivery   `json:"delivery,omitempty"`
	MarketSourceID   string            `json:"marketSourceId,omitempty"`
	MarketSourceName string            `json:"marketSourceName,omitempty"`
	MirroredFast     bool              `json:"mirroredFast,omitempty"`
}

type curatedPick struct {
	ID      string
	Repo    string
	Name    string
	Author  string
	Tag     string
	Summary string
	Order   int
}

// Curated picks tuned for Handraw Article Workbench writing/WeChat/image workflows.
var curatedPicks = []curatedPick{
	{
		ID:      "note-to-mp",
		Repo:    "sunbooshi/note-to-mp",
		Name:    "NoteToMP 公众号排版",
		Author:  "sunbooshi",
		Tag:     "公众号排版",
		Summary: "热门微信公众号排版与草稿同步插件，支持多种主题、代码高亮与图片上传。",
		Order:   1,
	},
	{
		ID:      "mp-preview",
		Repo:    "Yeban8090/mp-preview",
		Name:    "MP Preview 公众号预览",
		Author:  "Yeban8090",
		Tag:     "公众号排版",
		Summary: "轻量级微信公众号实时预览与一键复制富文本插件。",
		Order:   2,
	},
	{
		ID:      "wechat-public-platform",
		Repo:    "ai-chen2050/obsidian-wechat-public-platform",
		Name:    "微信公众号发布助手",
		Author:  "ai-chen2050",
		Tag:     "公众号发布",
		Summary: "支持 Markdown 一键同步到微信公众号草稿箱与素材库。",
		Order:   3,
	},
	{
		ID:      "obsidian-linter",
		Repo:    "platers/obsidian-linter",
		Name:    "Linter 文档排版规范",
		Author:  "platers",
		Tag:     "Markdown 整理",
		Summary: "自动规范中英文空格、标题层级、列表缩进与 YAML Frontmatter。",
		Order:   4,
	},
	{
		ID:      "obsidian-image-auto-upload-plugin",
		Repo:    "renmu123/obsidian-image-auto-upload-plugin",
		Name:    "Image Auto Upload 图床上传",
		Author:  "renmu123",
		Tag:     "图床上传",
		Summary: "对接 PicGo 等本地/远程图床，自动将本地文章配图上传并替换为外链。",
		Order:   5,
	},
	{
		ID:      "wechatpb",
		Repo:    "Kianzzz/wechatPB",
		Name:    "WeChatPB 公众号多主题排版",
		Author:  "Kianzzz",
		Tag:     "公众号排版",
		Summary: "内置多套公众号排版主题与草稿发布能力。",
		Order:   6,
	},
}

var catalogURLs = []string{
	"https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugins.json",
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json",
	"https://gh-proxy.com/https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json",
}

var statsURLs = []string{
	"https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugin-stats.json",
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json",
}

var ghRepoRe = regexp.MustCompile(`^(?:https?://(?:www\.)?github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?(?:/(?:releases(?:/tag/[^/?#]+)?|tree/[^?#]+|blob/[^?#]+)?)?(?:[?#].*)?$`)

func httpGetBytes(ctx context.Context, rawURL string, maxBytes int64, timeout time.Duration) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "handraw-client")
	req.Header.Set("Accept", "*/*")
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
	return data, resp.StatusCode, err
}

// FetchCatalog fetches (and caches for 30 min) the Obsidian community plugin catalog
// with China-friendly CDN mirror fallbacks and curated writing/WeChat picks.
func (m *Manager) FetchCatalog(ctx context.Context, force bool) ([]CatalogItem, bool, error) {
	m.catalogMu.Lock()
	cached := m.catalogItems
	fresh := !force && len(cached) > 0 && time.Since(m.catalogAt) < 30*time.Minute
	m.catalogMu.Unlock()

	if fresh {
		return m.decorateCatalog(cached), false, nil
	}

	var rawPlugins []struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Author      string `json:"author"`
		Description string `json:"description"`
		Repo        string `json:"repo"`
	}

	var lastErr error
	for _, u := range catalogURLs {
		b, _, err := httpGetBytes(ctx, u, 16<<20, 15*time.Second)
		if err != nil {
			lastErr = err
			continue
		}
		if err := json.Unmarshal(b, &rawPlugins); err != nil {
			lastErr = err
			continue
		}
		lastErr = nil
		break
	}

	if lastErr != nil {
		// Fallback to curated picks so offline / restricted environments still have a usable list.
		fallback := make([]CatalogItem, 0, len(curatedPicks))
		for _, c := range curatedPicks {
			fallback = append(fallback, CatalogItem{
				ID:              c.ID,
				Name:            c.Name,
				Author:          c.Author,
				Description:     c.Summary,
				Repo:            c.Repo,
				Featured:        true,
				FeaturedTag:     c.Tag,
				FeaturedSummary: c.Summary,
			})
		}
		return m.decorateCatalog(fallback), true, lastErr
	}

	// Best-effort download stats (optional, short timeout).
	stats := map[string]int64{}
	statsCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	for _, u := range statsURLs {
		if b, _, err := httpGetBytes(statsCtx, u, 16<<20, 6*time.Second); err == nil {
			var rawStats map[string]struct {
				Downloads int64 `json:"downloads"`
			}
			if json.Unmarshal(b, &rawStats) == nil {
				for id, s := range rawStats {
					stats[id] = s.Downloads
				}
				break
			}
		}
	}

	curatedByID := map[string]curatedPick{}
	curatedByRepo := map[string]curatedPick{}
	for _, c := range curatedPicks {
		curatedByID[strings.ToLower(c.ID)] = c
		curatedByRepo[strings.ToLower(c.Repo)] = c
	}

	seenID := map[string]bool{}
	seenRepo := map[string]bool{}
	items := make([]CatalogItem, 0, len(rawPlugins)+len(curatedPicks))
	for _, rp := range rawPlugins {
		id := strings.TrimSpace(rp.ID)
		if id == "" || seenID[id] {
			continue
		}
		seenID[id] = true
		repoNorm := strings.ToLower(strings.TrimSpace(rp.Repo))
		if repoNorm != "" {
			seenRepo[repoNorm] = true
		}
		it := CatalogItem{
			ID:          id,
			Name:        strings.TrimSpace(rp.Name),
			Author:      strings.TrimSpace(rp.Author),
			Description: strings.TrimSpace(rp.Description),
			Repo:        strings.TrimSpace(rp.Repo),
			Downloads:   stats[id],
		}
		if c, ok := curatedByID[strings.ToLower(id)]; ok {
			it.Featured = true
			it.FeaturedTag = c.Tag
			it.FeaturedSummary = c.Summary
		} else if c, ok := curatedByRepo[repoNorm]; ok {
			it.Featured = true
			it.FeaturedTag = c.Tag
			it.FeaturedSummary = c.Summary
		}
		items = append(items, it)
	}
	// Ensure curated GitHub plugins not yet in community-plugins.json are also listed!
	for _, c := range curatedPicks {
		if seenID[c.ID] || seenRepo[strings.ToLower(c.Repo)] {
			continue
		}
		seenID[c.ID] = true
		seenRepo[strings.ToLower(c.Repo)] = true
		items = append(items, CatalogItem{
			ID:              c.ID,
			Name:            c.Name,
			Author:          c.Author,
			Description:     c.Summary,
			Repo:            c.Repo,
			Featured:        true,
			FeaturedTag:     c.Tag,
			FeaturedSummary: c.Summary,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Featured != items[j].Featured {
			return items[i].Featured
		}
		if items[i].Featured && items[j].Featured {
			ci := curatedOrder(items[i])
			cj := curatedOrder(items[j])
			if ci != cj {
				return ci < cj
			}
		}
		if items[i].Downloads != items[j].Downloads {
			return items[i].Downloads > items[j].Downloads
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})

	m.catalogMu.Lock()
	m.catalogItems = items
	m.catalogAt = time.Now()
	m.catalogMu.Unlock()

	return m.decorateCatalog(items), false, nil
}

func curatedOrder(it CatalogItem) int {
	for _, c := range curatedPicks {
		if strings.EqualFold(c.ID, it.ID) || strings.EqualFold(c.Repo, it.Repo) {
			return c.Order
		}
	}
	return 999
}

func (m *Manager) decorateCatalog(base []CatalogItem) []CatalogItem {
	instMap := map[string]InstalledPlugin{}
	for _, p := range m.List() {
		instMap[p.ID] = p
	}
	out := make([]CatalogItem, len(base))
	for i, it := range base {
		if inst, ok := instMap[it.ID]; ok {
			it.Installed = true
			it.InstalledVersion = inst.Manifest.Version
			it.Enabled = inst.Enabled
			it.CompatLevel = inst.Compat.Level
		}
		out[i] = it
	}
	return out
}

// ParseGitHubRepo extracts "owner/repo" from a GitHub URL or short slug.
func ParseGitHubRepo(input string) (string, error) {
	s := strings.TrimSpace(input)
	s = strings.TrimSuffix(s, "/")
	m := ghRepoRe.FindStringSubmatch(s)
	if len(m) < 3 {
		return "", fmt.Errorf("无法识别 GitHub 仓库地址：%q（示例：sunbooshi/note-to-mp 或 https://github.com/owner/repo）", input)
	}
	return m[1] + "/" + m[2], nil
}

// InstallFromGitHub downloads manifest.json, main.js, and optional styles.css from
// a GitHub repository's latest release (with CDN/mirror fallback) and installs globally.
func (m *Manager) InstallFromGitHub(ctx context.Context, repoOrURL, sourceType string) (InstalledPlugin, error) {
	repo, err := ParseGitHubRepo(repoOrURL)
	if err != nil {
		return InstalledPlugin{}, err
	}
	if sourceType == "" {
		sourceType = "github"
	}

	// Step 1: Discover latest release tag & asset URLs.
	tag := ""
	assetURLs := map[string]string{}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	if b, _, err := httpGetBytes(ctx, apiURL, 2<<20, 12*time.Second); err == nil {
		var rel struct {
			TagName string `json:"tag_name"`
			Assets  []struct {
				Name               string `json:"name"`
				BrowserDownloadURL string `json:"browser_download_url"`
			} `json:"assets"`
		}
		if json.Unmarshal(b, &rel) == nil && rel.TagName != "" {
			tag = rel.TagName
			for _, a := range rel.Assets {
				assetURLs[strings.ToLower(a.Name)] = a.BrowserDownloadURL
			}
		}
	}

	// Fallback if GitHub API is rate-limited or unreachable: read manifest.json from jsDelivr to learn latest version tag.
	if tag == "" {
		for _, mfURL := range []string{
			fmt.Sprintf("https://cdn.jsdelivr.net/gh/%s@HEAD/manifest.json", repo),
			fmt.Sprintf("https://raw.githubusercontent.com/%s/main/manifest.json", repo),
			fmt.Sprintf("https://raw.githubusercontent.com/%s/master/manifest.json", repo),
		} {
			if b, _, err := httpGetBytes(ctx, mfURL, 1<<20, 10*time.Second); err == nil {
				var mf Manifest
				if json.Unmarshal(b, &mf) == nil && strings.TrimSpace(mf.Version) != "" {
					tag = strings.TrimSpace(mf.Version)
					break
				}
			}
		}
	}

	downloadReleaseFile := func(filename string, required bool) ([]byte, error) {
		var urls []string
		if direct := assetURLs[strings.ToLower(filename)]; direct != "" {
			urls = append(urls, direct, "https://gh-proxy.com/"+direct)
		}
		if tag != "" {
			u1 := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", repo, tag, filename)
			urls = append(urls, u1, "https://gh-proxy.com/"+u1)
			if !strings.HasPrefix(tag, "v") {
				u2 := fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", repo, tag, filename)
				urls = append(urls, u2, "https://gh-proxy.com/"+u2)
			}
		}
		uLatest := fmt.Sprintf("https://github.com/%s/releases/latest/download/%s", repo, filename)
		urls = append(urls, uLatest, "https://gh-proxy.com/"+uLatest)
		if filename == "manifest.json" || filename == "styles.css" {
			urls = append(urls, fmt.Sprintf("https://cdn.jsdelivr.net/gh/%s@HEAD/%s", repo, filename))
		}

		seen := map[string]bool{}
		var lastErr error
		for _, u := range urls {
			if seen[u] {
				continue
			}
			seen[u] = true
			b, _, err := httpGetBytes(ctx, u, maxPluginFileBytes, 25*time.Second)
			if err == nil && len(b) > 0 {
				return b, nil
			}
			lastErr = err
		}
		if !required {
			return nil, nil
		}
		if lastErr == nil {
			lastErr = errors.New("未找到文件")
		}
		return nil, fmt.Errorf("下载 %s 失败（仓库 %s）：%w", filename, repo, lastErr)
	}

	mfBytes, err := downloadReleaseFile("manifest.json", true)
	if err != nil {
		return InstalledPlugin{}, err
	}
	var mf Manifest
	if err := json.Unmarshal(mfBytes, &mf); err != nil {
		return InstalledPlugin{}, fmt.Errorf("manifest.json 解析失败：%w", err)
	}
	if err := ValidatePluginID(mf.ID); err != nil {
		return InstalledPlugin{}, err
	}

	mainBytes, err := downloadReleaseFile("main.js", true)
	if err != nil {
		return InstalledPlugin{}, err
	}
	stylesBytes, _ := downloadReleaseFile("styles.css", false)

	return m.writePluginFiles(mf, mfBytes, mainBytes, stylesBytes, InstallMeta{
		SourceType: sourceType,
		Source:     "https://github.com/" + repo,
		Repo:       repo,
	})
}

// InstallFromZip unpacks a ZIP containing manifest.json + main.js (+ optional styles.css/data.json)
// and installs it globally.
func (m *Manager) InstallFromZip(zipBytes []byte, source string) (InstalledPlugin, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return InstalledPlugin{}, fmt.Errorf("ZIP 文件无效：%w", err)
	}

	// Find directory prefix containing manifest.json.
	prefix := ""
	foundManifest := false
	for _, f := range zr.File {
		name := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(f.Name, "\\", "/")), "/")
		if strings.HasPrefix(name, "__MACOSX/") {
			continue
		}
		if path.Base(name) == "manifest.json" && !f.FileInfo().IsDir() {
			dir := path.Dir(name)
			if dir == "." {
				prefix = ""
			} else {
				prefix = dir + "/"
			}
			foundManifest = true
			break
		}
	}
	if !foundManifest {
		return InstalledPlugin{}, errors.New("ZIP 包中未找到 manifest.json")
	}

	tmpDir, err := os.MkdirTemp(m.Dir, ".tmp-obs-zip-*")
	if err != nil {
		return InstalledPlugin{}, err
	}
	defer os.RemoveAll(tmpDir)

	var total int64
	for _, f := range zr.File {
		name := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(f.Name, "\\", "/")), "/")
		if strings.HasPrefix(name, "__MACOSX/") {
			continue
		}
		if prefix != "" && !strings.HasPrefix(name, prefix) {
			continue
		}
		rel := strings.TrimPrefix(name, prefix)
		rel = strings.TrimLeft(rel, "/")
		if rel == "" || rel == "." || strings.Contains(rel, "..") {
			continue
		}
		dst := filepath.Join(tmpDir, filepath.FromSlash(rel))
		relCheck, rErr := filepath.Rel(tmpDir, dst)
		if rErr != nil || strings.HasPrefix(relCheck, "..") {
			return InstalledPlugin{}, errors.New("ZIP 内包含非法路径")
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return InstalledPlugin{}, err
			}
			continue
		}
		rc, oErr := f.Open()
		if oErr != nil {
			return InstalledPlugin{}, oErr
		}
		data, rErr := io.ReadAll(io.LimitReader(rc, maxPluginFileBytes+1))
		rc.Close()
		if rErr != nil {
			return InstalledPlugin{}, rErr
		}
		if int64(len(data)) > maxPluginFileBytes {
			return InstalledPlugin{}, errors.New("ZIP 内单文件超过 32MB 限制")
		}
		total += int64(len(data))
		if total > maxTotalPluginBytes {
			return InstalledPlugin{}, errors.New("插件解压后体积超过 64MB 限制")
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return InstalledPlugin{}, err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return InstalledPlugin{}, err
		}
	}

	mf, err := ReadManifest(tmpDir)
	if err != nil {
		return InstalledPlugin{}, err
	}
	dstDir, err := m.pluginDir(mf.ID)
	if err != nil {
		return InstalledPlugin{}, err
	}
	// Preserve existing data.json if ZIP didn't bundle one.
	if _, dErr := os.Stat(filepath.Join(tmpDir, "data.json")); os.IsNotExist(dErr) {
		if existing, rErr := os.ReadFile(filepath.Join(dstDir, "data.json")); rErr == nil {
			_ = os.WriteFile(filepath.Join(tmpDir, "data.json"), existing, 0o644)
		}
	}
	now := time.Now().UnixMilli()
	prevMeta := readInstallMeta(dstDir)
	instAt := now
	if prevMeta != nil && prevMeta.InstalledAt > 0 {
		instAt = prevMeta.InstalledAt
	}
	writeInstallMeta(tmpDir, InstallMeta{
		SourceType:  "zip",
		Source:      source,
		InstalledAt: instAt,
		UpdatedAt:   now,
	})
	if err := replaceDir(tmpDir, dstDir); err != nil {
		return InstalledPlugin{}, err
	}
	return m.Get(mf.ID)
}

func (m *Manager) writePluginFiles(mf Manifest, mfBytes, mainBytes, stylesBytes []byte, meta InstallMeta) (InstalledPlugin, error) {
	dstDir, err := m.pluginDir(mf.ID)
	if err != nil {
		return InstalledPlugin{}, err
	}
	tmpDir, err := os.MkdirTemp(m.Dir, ".tmp-obs-gh-*")
	if err != nil {
		return InstalledPlugin{}, err
	}
	defer os.RemoveAll(tmpDir)

	if err := os.WriteFile(filepath.Join(tmpDir, "manifest.json"), mfBytes, 0o644); err != nil {
		return InstalledPlugin{}, err
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "main.js"), mainBytes, 0o644); err != nil {
		return InstalledPlugin{}, err
	}
	if len(stylesBytes) > 0 {
		if err := os.WriteFile(filepath.Join(tmpDir, "styles.css"), stylesBytes, 0o644); err != nil {
			return InstalledPlugin{}, err
		}
	}
	// Preserve existing data.json across updates/reinstalls.
	if existing, rErr := os.ReadFile(filepath.Join(dstDir, "data.json")); rErr == nil {
		_ = os.WriteFile(filepath.Join(tmpDir, "data.json"), existing, 0o644)
	}

	now := time.Now().UnixMilli()
	prevMeta := readInstallMeta(dstDir)
	meta.InstalledAt = now
	if prevMeta != nil && prevMeta.InstalledAt > 0 {
		meta.InstalledAt = prevMeta.InstalledAt
	}
	meta.UpdatedAt = now
	writeInstallMeta(tmpDir, meta)

	if err := replaceDir(tmpDir, dstDir); err != nil {
		return InstalledPlugin{}, err
	}
	return m.Get(mf.ID)
}
