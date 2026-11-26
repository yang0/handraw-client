package server

import (
	"errors"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/obsidian"
	"github.com/yang0/handraw-client/internal/settings"
)

func (s *Server) obsidianMgr() *obsidian.Manager {
	if s.Obsidian == nil {
		s.Obsidian = obsidian.New(appdir.ObsidianPlugins())
	}
	return s.Obsidian
}

func (s *Server) articleObsidianPlugins(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	return map[string]any{
		"dir":        mgr.Dir,
		"env":        obsidian.GetDesktopEnv(),
		"plugins":    mgr.List(),
		"secretKeys": mgr.ListSecretKeys(),
	}, nil
}

func (s *Server) articleObsidianDiscover(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	st := settings.Get()
	dirs := dedupeVaultDirs(st.ArticleVaultDirs)
	if active, err := s.activeArticleVaultDir(); err == nil && active != "" {
		dirs = dedupeVaultDirs(append([]string{active}, dirs...))
	}
	customDir := strings.TrimSpace(r.URL.Query().Get("dir"))
	vaults := mgr.DiscoverObsidianVaults(dirs, customDir)
	if vaults == nil {
		vaults = []obsidian.DiscoveredVault{}
	}
	return map[string]any{
		"vaults": vaults,
	}, nil
}

func obsidianMarketSourcesFromSettings() []obsidian.MarketSource {
	st := settings.Get()
	out := make([]obsidian.MarketSource, 0, len(st.ObsidianMarkets))
	for _, m := range st.ObsidianMarkets {
		out = append(out, obsidian.MarketSource{
			ID:       m.ID,
			Name:     m.Name,
			URL:      m.URL,
			Mirrors:  m.Mirrors,
			Official: m.Official,
			Enabled:  m.Enabled,
		})
	}
	return out
}

func (s *Server) articleObsidianMarket(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	force := r.URL.Query().Get("refresh") == "1"
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	cat := strings.TrimSpace(r.URL.Query().Get("category"))
	featuredOnly := r.URL.Query().Get("featured") == "1"
	includeCommunity := r.URL.Query().Get("community") == "1" || (q != "" && !featuredOnly)
	st := settings.Get()
	mirror := firstStr(strings.TrimSpace(r.URL.Query().Get("mirror")), st.PreferredMarketMirror, obsidian.ObsidianMirrorGitee)
	limit := 80
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 300 {
			limit = n
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 18*time.Second)
	defer cancel()
	catalog := mgr.ListMarketCatalog(ctx, obsidianMarketSourcesFromSettings(), mirror, includeCommunity, force)
	filtered := make([]obsidian.CatalogItem, 0, min(limit, len(catalog.Items)))
	total := 0
	for _, it := range catalog.Items {
		if featuredOnly && !it.Featured {
			continue
		}
		if cat != "" {
			matchedCat := false
			for _, c := range it.Categories {
				if strings.EqualFold(c, cat) {
					matchedCat = true
					break
				}
			}
			if !matchedCat {
				continue
			}
		}
		if q != "" {
			hay := strings.ToLower(it.ID + " " + it.Name + " " + it.Author + " " + it.Description + " " + it.Repo + " " + it.FeaturedTag + " " + it.FeaturedSummary)
			match := true
			for _, tok := range strings.Fields(q) {
				if !strings.Contains(hay, tok) {
					match = false
					break
				}
			}
			if !match {
				continue
			}
		}
		total++
		if len(filtered) < limit {
			filtered = append(filtered, it)
		}
	}
	return map[string]any{
		"ok":            true,
		"defaultMirror": catalog.DefaultMirror,
		"sources":       catalog.Sources,
		"categories":    catalog.Categories,
		"items":         filtered,
		"total":         total,
		"offline":       catalog.Offline,
		"warning":       catalog.Warning,
	}, nil
}

func (s *Server) articleObsidianMarketAddSource(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	rawURL := strings.TrimSpace(body.URL)
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://") {
		return nil, bad("写作插件市场地址必须以 http:// 或 https:// 开头")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	idx, err := obsidian.FetchMarketIndex(ctx, rawURL, true)
	if err != nil {
		return nil, bad("无法读取写作插件市场索引：" + err.Error())
	}
	name := firstStr(strings.TrimSpace(body.Name), idx.Title.Label(), "自定义写作插件市场")
	srcID := "obs_mkt_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	_, err = settings.Update(func(st *settings.Settings) error {
		for _, cur := range st.ObsidianMarkets {
			if strings.EqualFold(strings.TrimSpace(cur.URL), rawURL) {
				return fmt.Errorf("已订阅过该写作插件市场源：%s", cur.Name)
			}
		}
		st.ObsidianMarkets = append(st.ObsidianMarkets, settings.ObsidianMarketSource{
			ID:      srcID,
			Name:    name,
			URL:     rawURL,
			Mirrors: idx.Mirrors,
			Enabled: true,
		})
		return nil
	})
	if err != nil {
		return nil, bad(err.Error())
	}
	mirror := firstStr(settings.Get().PreferredMarketMirror, obsidian.ObsidianMirrorGitee)
	cat := s.obsidianMgr().ListMarketCatalog(ctx, obsidianMarketSourcesFromSettings(), mirror, false, false)
	return map[string]any{
		"ok":            true,
		"id":            srcID,
		"defaultMirror": cat.DefaultMirror,
		"sources":       cat.Sources,
		"categories":    cat.Categories,
		"items":         cat.Items,
		"total":         len(cat.Items),
	}, nil
}

func (s *Server) articleObsidianMarketRemoveSource(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return nil, bad("缺少写作插件市场源 ID")
	}
	_, err := settings.Update(func(st *settings.Settings) error {
		found := false
		next := make([]settings.ObsidianMarketSource, 0, len(st.ObsidianMarkets))
		for _, cur := range st.ObsidianMarkets {
			if cur.ID == id {
				if cur.Official {
					return fmt.Errorf("官方写作插件市场源不可删除")
				}
				found = true
				continue
			}
			next = append(next, cur)
		}
		if !found {
			return fmt.Errorf("未找到指定的写作插件市场源")
		}
		st.ObsidianMarkets = next
		return nil
	})
	if err != nil {
		return nil, bad(err.Error())
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	mirror := firstStr(settings.Get().PreferredMarketMirror, obsidian.ObsidianMirrorGitee)
	cat := s.obsidianMgr().ListMarketCatalog(ctx, obsidianMarketSourcesFromSettings(), mirror, false, false)
	return map[string]any{
		"ok":            true,
		"defaultMirror": cat.DefaultMirror,
		"sources":       cat.Sources,
		"categories":    cat.Categories,
		"items":         cat.Items,
		"total":         len(cat.Items),
	}, nil
}

func (s *Server) articleObsidianInstall(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	ct := strings.ToLower(r.Header.Get("Content-Type"))

	// Multipart ZIP upload
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			return nil, bad("解析上传文件失败：" + err.Error())
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			return nil, bad("请选择要导入的 Obsidian 插件 ZIP 文件")
		}
		defer f.Close()
		data, err := io.ReadAll(io.LimitReader(f, (64<<20)+1))
		if err != nil {
			return nil, bad("读取 ZIP 文件失败：" + err.Error())
		}
		if len(data) > 64<<20 {
			return nil, bad("ZIP 文件超过 64MB 限制")
		}
		inst, err := mgr.InstallFromZip(data, hdr.Filename)
		if err != nil {
			return nil, bad(err.Error())
		}
		if r.FormValue("enable") == "true" && inst.Compat.Level != "unsupported" {
			on := true
			if updated, uErr := mgr.SetPluginState(inst.ID, &on, nil, nil); uErr == nil {
				inst = updated
			}
		}
		return map[string]any{"ok": true, "plugin": inst}, nil
	}

	var body struct {
		SourceType      string            `json:"sourceType"` // market | github | local | obsidian-vault
		ID              string            `json:"id"`
		Repo            string            `json:"repo"`
		Dir             string            `json:"dir"`
		Mirror          string            `json:"mirror"`
		DownloadMirrors map[string]string `json:"downloadMirrors"`
		Files           []string          `json:"files"`
		CopyData        *bool             `json:"copyData"`
		Enable          bool              `json:"enable"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}

	var inst obsidian.InstalledPlugin
	var err error
	st := strings.TrimSpace(body.SourceType)
	mirror := firstStr(strings.TrimSpace(body.Mirror), settings.Get().PreferredMarketMirror, obsidian.ObsidianMirrorGitee)
	switch st {
	case "market":
		dlMirrors := body.DownloadMirrors
		files := body.Files
		repo := strings.TrimSpace(body.Repo)
		if len(dlMirrors) == 0 && strings.TrimSpace(body.ID) != "" {
			// Look up mirrored dist info from curated market automatically.
			ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
			cat := mgr.ListMarketCatalog(ctx, obsidianMarketSourcesFromSettings(), mirror, false, false)
			cancel()
			for _, it := range cat.Items {
				if strings.EqualFold(it.ID, strings.TrimSpace(body.ID)) {
					dlMirrors = it.DownloadMirrors
					files = it.Files
					if repo == "" {
						repo = it.Repo
					}
					break
				}
			}
		}
		if len(dlMirrors) > 0 {
			inst, err = mgr.InstallFromMirrors(r.Context(), repo, dlMirrors, files, mirror)
		} else {
			inst, err = mgr.InstallFromGitHub(r.Context(), repo, st)
		}
	case "github":
		inst, err = mgr.InstallFromGitHub(r.Context(), body.Repo, st)
	case "local", "obsidian-vault":
		copyData := true
		if body.CopyData != nil {
			copyData = *body.CopyData
		}
		inst, err = mgr.ImportLocalPlugin(body.Dir, copyData, st)
	default:
		if strings.TrimSpace(body.Repo) != "" {
			inst, err = mgr.InstallFromGitHub(r.Context(), body.Repo, "github")
		} else if strings.TrimSpace(body.Dir) != "" {
			copyData := true
			if body.CopyData != nil {
				copyData = *body.CopyData
			}
			inst, err = mgr.ImportLocalPlugin(body.Dir, copyData, "local")
		} else {
			return nil, bad("请提供 GitHub 仓库地址或本地插件目录")
		}
	}
	if err != nil {
		return nil, bad(err.Error())
	}
	if body.Enable && inst.Compat.Level != "unsupported" {
		on := true
		if updated, uErr := mgr.SetPluginState(inst.ID, &on, nil, nil); uErr == nil {
			inst = updated
		}
	}
	return map[string]any{"ok": true, "plugin": inst}, nil
}

func (s *Server) articleObsidianImportBatch(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	var body struct {
		Items []struct {
			Dir      string `json:"dir"`
			CopyData *bool  `json:"copyData"`
		} `json:"items"`
		Enable bool `json:"enable"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.Items) == 0 {
		return nil, bad("请至少选择一个要导入的 Obsidian 插件")
	}
	var installed []obsidian.InstalledPlugin
	var errs []map[string]string
	for _, item := range body.Items {
		copyData := true
		if item.CopyData != nil {
			copyData = *item.CopyData
		}
		inst, err := mgr.ImportLocalPlugin(item.Dir, copyData, "obsidian-vault")
		if err != nil {
			errs = append(errs, map[string]string{"dir": item.Dir, "error": err.Error()})
			continue
		}
		if body.Enable && inst.Compat.Level != "unsupported" {
			on := true
			if updated, uErr := mgr.SetPluginState(inst.ID, &on, nil, nil); uErr == nil {
				inst = updated
			}
		}
		installed = append(installed, inst)
	}
	return map[string]any{
		"ok":        len(installed) > 0,
		"installed": installed,
		"errors":    errs,
	}, nil
}

func (s *Server) articleObsidianPatch(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Enabled        *bool  `json:"enabled"`
		TrustedDesktop *bool  `json:"trustedDesktop"`
		LocalPorts     *[]int `json:"localPorts"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	inst, err := mgr.SetPluginState(id, body.Enabled, body.TrustedDesktop, body.LocalPorts)
	if errors.Is(err, obsidian.ErrNeedsFullAccess) {
		return nil, &apiError{Status: 409, Msg: err.Error(), Code: "needs_full_access"}
	}
	if err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"ok": true, "plugin": inst}, nil
}

func (s *Server) articleObsidianDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	id := strings.TrimSpace(r.PathValue("id"))
	if err := mgr.Uninstall(id); err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"ok": true, "id": id}, nil
}

func (s *Server) articleObsidianBundle(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	id := strings.TrimSpace(r.PathValue("id"))
	// The bundle is the code the host executes: only hand it out for plugins
	// the user enabled with explicit full-access consent (#171).
	if !mgr.IsRunnable(id) {
		return nil, &apiError{Status: 403, Msg: "插件未启用或尚未确认完全权限", Code: "needs_full_access"}
	}
	b, err := mgr.LoadBundle(id)
	if err != nil {
		return nil, notFound(err.Error())
	}
	return b, nil
}

func (s *Server) articleObsidianReadData(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	id := strings.TrimSpace(r.PathValue("id"))
	raw, err := mgr.ReadData(id)
	if err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"data": raw}, nil
}

func (s *Server) articleObsidianWriteData(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Data json.RawMessage `json:"data"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if err := mgr.WriteData(id, body.Data); err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) articleObsidianSecretGet(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if key == "" {
		return map[string]any{"keys": mgr.ListSecretKeys()}, nil
	}
	val, err := mgr.GetSecret(key)
	if err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"key": key, "value": val}, nil
}

func (s *Server) articleObsidianSecretSet(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	var body struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if err := mgr.SetSecret(body.Key, body.Value); err != nil {
		return nil, bad(err.Error())
	}
	return map[string]any{"ok": true}, nil
}

// resolveVaultAnyFilePath validates any relative path strictly inside active article vault
// (allowing images/attachments/markdown, disallowing path escape or .git/.obsidian writes).
func resolveVaultAnyFilePath(rootDir, relPath string) (absPath string, normRel string, err error) {
	rootAbs, err := filepath.Abs(rootDir)
	if err != nil {
		return "", "", err
	}
	raw := strings.TrimSpace(strings.ReplaceAll(relPath, "\\", "/"))
	raw = strings.TrimLeft(raw, "/")
	if raw == "" || raw == "." {
		return "", "", bad("请指定文章库内的文件相对路径")
	}
	if strings.Contains(raw, ":") {
		return "", "", bad("路径必须是文章库内的相对路径")
	}
	cleaned := filepath.Clean(filepath.FromSlash(raw))
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", "", bad("不允许访问文章库目录之外的路径")
	}
	for _, seg := range strings.Split(filepath.ToSlash(cleaned), "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", "", bad("非法路径段")
		}
		if strings.EqualFold(seg, ".git") {
			return "", "", bad("不允许访问 .git 目录")
		}
	}
	target := filepath.Join(rootAbs, cleaned)
	relCheck, err := filepath.Rel(rootAbs, target)
	if err != nil || relCheck == "." || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(os.PathSeparator)) {
		return "", "", bad("不允许访问文章库目录之外的路径")
	}
	if realRoot, rErr := filepath.EvalSymlinks(rootAbs); rErr == nil {
		checkPath := target
		if _, stErr := os.Stat(checkPath); stErr != nil {
			checkPath = filepath.Dir(target)
		}
		if realCheck, cErr := filepath.EvalSymlinks(checkPath); cErr == nil {
			if relReal, err := filepath.Rel(realRoot, realCheck); err != nil || strings.HasPrefix(relReal, "..") {
				return "", "", bad("不允许访问文章库目录之外的符号链接")
			}
		}
	}
	return target, filepath.ToSlash(relCheck), nil
}

type vaultFlatEntry struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Basename  string `json:"basename"`
	Extension string `json:"extension,omitempty"`
	IsDir     bool   `json:"isDir"`
	MTime     int64  `json:"mtime"`
	CTime     int64  `json:"ctime"`
	Size      int64  `json:"size"`
}

func (s *Server) articleObsidianVaultList(w http.ResponseWriter, r *http.Request) (any, error) {
	rootAbs, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	entries := make([]vaultFlatEntry, 0, 128)
	const maxEntries = 6000
	var walk func(dir, prefix string, depth int)
	walk = func(dir, prefix string, depth int) {
		if depth > 10 || len(entries) >= maxEntries {
			return
		}
		list, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range list {
			if len(entries) >= maxEntries {
				break
			}
			name := e.Name()
			if name == "" || strings.HasPrefix(name, ".") {
				continue
			}
			low := strings.ToLower(name)
			if e.IsDir() && (low == "node_modules" || low == "__pycache__" || low == "vendor") {
				continue
			}
			rel := name
			if prefix != "" {
				rel = prefix + "/" + name
			}
			var mtime, sz int64
			if info, iErr := e.Info(); iErr == nil {
				mtime = info.ModTime().UnixMilli()
				sz = info.Size()
			}
			ext := ""
			base := name
			if !e.IsDir() {
				rawExt := filepath.Ext(name)
				if rawExt != "" {
					ext = strings.ToLower(strings.TrimPrefix(rawExt, "."))
					base = strings.TrimSuffix(name, rawExt)
				}
			}
			entries = append(entries, vaultFlatEntry{
				Path:      rel,
				Name:      name,
				Basename:  base,
				Extension: ext,
				IsDir:     e.IsDir(),
				MTime:     mtime,
				CTime:     mtime,
				Size:      sz,
			})
			if e.IsDir() {
				walk(filepath.Join(dir, name), rel, depth+1)
			}
		}
	}
	if statIsDir(rootAbs) {
		walk(rootAbs, "", 0)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return map[string]any{
		"rootDir": rootAbs,
		"name":    filepath.Base(rootAbs),
		"files":   entries,
	}, nil
}

func (s *Server) articleObsidianVaultRawRead(w http.ResponseWriter, r *http.Request) (any, error) {
	rootAbs, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultAnyFilePath(rootAbs, r.URL.Query().Get("path"))
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absPath)
	if err != nil || info.IsDir() {
		return nil, notFound("找不到文件：" + normRel)
	}
	if info.Size() > 32<<20 {
		return nil, bad("文件超过 32MB 限制")
	}
	b, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	binaryMode := r.URL.Query().Get("binary") == "1"
	resp := map[string]any{
		"path":  normRel,
		"size":  info.Size(),
		"mtime": info.ModTime().UnixMilli(),
	}
	if binaryMode {
		resp["base64"] = base64.StdEncoding.EncodeToString(b)
	} else {
		resp["text"] = strings.ReplaceAll(string(b), "\r\n", "\n")
	}
	return resp, nil
}

func (s *Server) articleObsidianVaultRawWrite(w http.ResponseWriter, r *http.Request) (any, error) {
	rootAbs, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	var body struct {
		Path   string `json:"path"`
		Text   string `json:"text"`
		Base64 string `json:"base64"`
		Mkdir  bool   `json:"mkdir"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultAnyFilePath(rootAbs, body.Path)
	if err != nil {
		return nil, err
	}
	if body.Mkdir {
		if err := os.MkdirAll(absPath, 0o755); err != nil {
			return nil, bad("创建目录失败：" + err.Error())
		}
		return map[string]any{"ok": true, "path": normRel}, nil
	}
	var data []byte
	if body.Base64 != "" {
		data, err = base64.StdEncoding.DecodeString(body.Base64)
		if err != nil {
			return nil, bad("base64 解码失败：" + err.Error())
		}
	} else {
		data = []byte(body.Text)
	}
	if len(data) > 32<<20 {
		return nil, bad("写入内容超过 32MB 限制")
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(absPath, data, 0o644); err != nil {
		return nil, err
	}
	var mtime int64
	if info, err := os.Stat(absPath); err == nil {
		mtime = info.ModTime().UnixMilli()
	}
	return map[string]any{"ok": true, "path": normRel, "size": len(data), "mtime": mtime}, nil
}

func (s *Server) articleObsidianVaultRawDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	rootAbs, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultAnyFilePath(rootAbs, r.URL.Query().Get("path"))
	if err != nil {
		return nil, err
	}
	if err := os.RemoveAll(absPath); err != nil {
		return nil, bad("删除失败：" + err.Error())
	}
	return map[string]any{"ok": true, "deleted": normRel}, nil
}

func (s *Server) articleObsidianRequestProxy(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	var body struct {
		PluginID string                `json:"pluginId"`
		Request  obsidian.ProxyRequest `json:"request"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	pid := strings.TrimSpace(body.PluginID)
	if err := obsidian.ValidatePluginID(pid); err != nil {
		return nil, bad(err.Error())
	}
	p, err := mgr.Get(pid)
	if err != nil || !p.Enabled {
		return nil, &apiError{Status: 403, Msg: "插件未启用，无法发起网络请求"}
	}
	resp, err := obsidian.ProxyHTTPRequest(r.Context(), body.Request, mgr.AllowedLocalPorts(pid))
	if err != nil {
		return nil, bad(err.Error())
	}
	return resp, nil
}

func (s *Server) articleObsidianDesktopFS(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	var body struct {
		PluginID string                    `json:"pluginId"`
		Req      obsidian.DesktopFSRequest `json:"req"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	pid := strings.TrimSpace(body.PluginID)
	if !mgr.IsTrustedDesktop(pid) {
		return nil, &apiError{Status: 403, Msg: "该插件需要本地文件系统权限：请在文章插件管理中为「" + pid + "」开启「信任本地桌面权限」"}
	}
	res, err := obsidian.ExecDesktopFS(body.Req)
	if err != nil {
		return nil, bad(err.Error())
	}
	return res, nil
}

func (s *Server) articleObsidianDesktopSpawn(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.obsidianMgr()
	var body struct {
		PluginID string                `json:"pluginId"`
		Req      obsidian.SpawnRequest `json:"req"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	pid := strings.TrimSpace(body.PluginID)
	if !mgr.IsTrustedDesktop(pid) {
		return nil, &apiError{Status: 403, Msg: "该插件需要调用本地命令行工具：请在文章插件管理中为「" + pid + "」开启「信任本地桌面权限」"}
	}
	res, err := obsidian.SpawnProcess(r.Context(), body.Req)
	if err != nil {
		return nil, bad(err.Error())
	}
	return res, nil
}
