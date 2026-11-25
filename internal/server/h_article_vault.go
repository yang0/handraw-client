package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/store"
)

const (
	vaultMaxDepth = 8
	vaultMaxFiles = 2000
	vaultMaxBytes = 8 << 20 // 8 MiB per markdown file
)

type vaultNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"` // vault-relative forward-slash path
	Kind     string      `json:"kind"` // "dir" | "file"
	ModTime  int64       `json:"modTime,omitempty"`
	Size     int64       `json:"size,omitempty"`
	Children []vaultNode `json:"children,omitempty"`
}

type vaultSummary struct {
	Dir       string `json:"dir"`
	Name      string `json:"name"`
	Active    bool   `json:"active"`
	Exists    bool   `json:"exists"`
	IsDefault bool   `json:"isDefault,omitempty"`
}

func sameVaultPath(a, b string) bool {
	ca := filepath.Clean(strings.TrimSpace(a))
	cb := filepath.Clean(strings.TrimSpace(b))
	if ca == "" || cb == "" {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

func defaultArticleVaultDir(st settings.Settings) string {
	dir := filepath.Join(st.WorksDir, "articles")
	if abs, err := filepath.Abs(dir); err == nil {
		return abs
	}
	return filepath.Clean(dir)
}

func statIsDir(dir string) bool {
	st, err := os.Stat(dir)
	return err == nil && st.IsDir()
}

func dirHasMarkdown(dir string) bool {
	if !statIsDir(dir) {
		return false
	}
	_, count := scanVaultTree(dir)
	return count > 0
}

func dedupeVaultDirs(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		p := strings.TrimSpace(item)
		if p == "" {
			continue
		}
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		} else {
			p = filepath.Clean(p)
		}
		dup := false
		for _, existing := range out {
			if sameVaultPath(existing, p) {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, p)
		}
	}
	return out
}

func (s *Server) activeArticleVaultDir() (string, error) {
	st := settings.Get()
	dir := strings.TrimSpace(st.ArticleVaultDir)
	if dir == "" {
		dirs := dedupeVaultDirs(st.ArticleVaultDirs)
		if len(dirs) > 0 {
			dir = dirs[0]
		} else {
			dir = defaultArticleVaultDir(st)
			_ = os.MkdirAll(dir, 0o755)
		}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func buildVaultSummaries(st settings.Settings, activeAbs string) []vaultSummary {
	defAbs := defaultArticleVaultDir(st)
	dirs := dedupeVaultDirs(st.ArticleVaultDirs)
	hasActive := false
	for _, d := range dirs {
		if sameVaultPath(d, activeAbs) {
			hasActive = true
			break
		}
	}
	if !hasActive && activeAbs != "" {
		dirs = append([]string{activeAbs}, dirs...)
	}
	out := make([]vaultSummary, 0, len(dirs))
	for _, d := range dirs {
		out = append(out, vaultSummary{
			Dir:       d,
			Name:      filepath.Base(d),
			Active:    sameVaultPath(d, activeAbs),
			Exists:    statIsDir(d),
			IsDefault: sameVaultPath(d, defAbs),
		})
	}
	return out
}

func (s *Server) vaultTreePayload(activeAbs string) map[string]any {
	st := settings.Get()
	vaults := buildVaultSummaries(st, activeAbs)
	exists := statIsDir(activeAbs)
	if !exists {
		return map[string]any{
			"dir":       activeAbs,
			"name":      filepath.Base(activeAbs),
			"exists":    false,
			"tree":      []vaultNode{},
			"fileCount": 0,
			"vaults":    vaults,
		}
	}
	tree, count := scanVaultTree(activeAbs)
	return map[string]any{
		"dir":       activeAbs,
		"name":      filepath.Base(activeAbs),
		"exists":    true,
		"tree":      tree,
		"fileCount": count,
		"vaults":    vaults,
	}
}

func isMarkdownExt(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".md" || ext == ".markdown"
}

func isCanvasExt(name string) bool {
	return strings.ToLower(filepath.Ext(name)) == ".canvas"
}

func resolveVaultMarkdownPath(rootDir, relPath string, allowCreate bool) (absPath string, normRel string, err error) {
	raw := strings.TrimSpace(strings.ReplaceAll(relPath, "\\", "/"))
	raw = strings.TrimLeft(raw, "/")
	if raw == "" || raw == "." {
		return "", "", bad("请指定 Markdown 文件路径")
	}
	if strings.Contains(raw, ":") {
		return "", "", bad("文件路径只能是文章库内的相对路径")
	}
	cleaned := filepath.Clean(filepath.FromSlash(raw))
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", "", bad("不允许访问文章库目录之外的路径")
	}
	if allowCreate && !isMarkdownExt(cleaned) {
		cleaned += ".md"
	}
	if !isMarkdownExt(cleaned) {
		return "", "", bad("仅支持 .md 或 .markdown 文件")
	}
	rootAbs, err := filepath.Abs(rootDir)
	if err != nil {
		return "", "", err
	}
	target := filepath.Join(rootAbs, cleaned)
	relCheck, err := filepath.Rel(rootAbs, target)
	if err != nil || relCheck == "." || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(os.PathSeparator)) {
		return "", "", bad("不允许访问文章库目录之外的路径")
	}
	// Resolve symlinks on existing paths to prevent symlink escape.
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

func vaultMetaKey(absPath string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(absPath))))
	return "vm_" + hex.EncodeToString(sum[:12])
}

func extractMarkdownTitle(content, fileName string) string {
	for _, ln := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "# ") {
			h := strings.TrimSpace(strings.TrimPrefix(t, "# "))
			if h != "" {
				return h
			}
		}
	}
	ext := filepath.Ext(fileName)
	return strings.TrimSuffix(filepath.Base(fileName), ext)
}

func scanVaultTree(rootAbs string) ([]vaultNode, int) {
	fileCount := 0
	var walk func(dir, relPrefix string, depth int) []vaultNode
	walk = func(dir, relPrefix string, depth int) []vaultNode {
		if depth > vaultMaxDepth || fileCount >= vaultMaxFiles {
			return nil
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil
		}
		var dirs []vaultNode
		var files []vaultNode
		for _, e := range entries {
			name := e.Name()
			if name == "" || strings.HasPrefix(name, ".") {
				continue
			}
			low := strings.ToLower(name)
			if e.IsDir() {
				if low == "node_modules" || low == "__pycache__" || low == "vendor" {
					continue
				}
				subDir := filepath.Join(dir, name)
				subRel := name
				if relPrefix != "" {
					subRel = relPrefix + "/" + name
				}
				children := walk(subDir, subRel, depth+1)
				if len(children) == 0 {
					// Keep genuinely empty newly-created folders visible so users can select them
					// and create notes inside, while still pruning non-empty asset-only folders (#71).
					subEntries, rErr := os.ReadDir(subDir)
					if rErr != nil || len(subEntries) > 0 || low == "assets" || low == "images" || low == "attachments" {
						continue
					}
					children = []vaultNode{}
				}
				dirs = append(dirs, vaultNode{
					Name:     name,
					Path:     subRel,
					Kind:     "dir",
					Children: children,
				})
				continue
			}
			if !isMarkdownExt(name) && !isCanvasExt(name) {
				continue
			}
			if fileCount >= vaultMaxFiles {
				break
			}
			subRel := name
			if relPrefix != "" {
				subRel = relPrefix + "/" + name
			}
			var modMs, sz int64
			if info, err := e.Info(); err == nil {
				modMs = info.ModTime().UnixMilli()
				sz = info.Size()
			}
			fileCount++
			kind := "file"
			if isCanvasExt(name) {
				kind = "canvas"
			}
			files = append(files, vaultNode{
				Name:    name,
				Path:    subRel,
				Kind:    kind,
				ModTime: modMs,
				Size:    sz,
			})
		}
		sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name) })
		sort.Slice(files, func(i, j int) bool { return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name) })
		out := make([]vaultNode, 0, len(dirs)+len(files))
		out = append(out, dirs...)
		out = append(out, files...)
		return out
	}
	nodes := walk(rootAbs, "", 0)
	if nodes == nil {
		nodes = []vaultNode{}
	}
	return nodes, fileCount
}

func registerVaultDir(st *settings.Settings, abs string, activate bool) {
	dirs := dedupeVaultDirs(st.ArticleVaultDirs)
	if len(dirs) == 0 {
		if prev := strings.TrimSpace(st.ArticleVaultDir); prev != "" {
			if pAbs, err := filepath.Abs(prev); err == nil {
				dirs = append(dirs, pAbs)
			}
		} else {
			defAbs := defaultArticleVaultDir(*st)
			if dirHasMarkdown(defAbs) {
				dirs = append(dirs, defAbs)
			}
		}
	}
	found := false
	for _, d := range dirs {
		if sameVaultPath(d, abs) {
			found = true
			break
		}
	}
	if !found {
		dirs = append(dirs, abs)
	}
	st.ArticleVaultDirs = dirs
	if activate || strings.TrimSpace(st.ArticleVaultDir) == "" {
		st.ArticleVaultDir = abs
	}
}

func (s *Server) articleVaultTree(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	return s.vaultTreePayload(dir), nil
}

func (s *Server) articleVaultSetRoot(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Dir string `json:"dir"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	dir := strings.TrimSpace(body.Dir)
	if dir == "" {
		return nil, bad("请选择或输入本地文章目录路径")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, bad("目录路径无效：" + err.Error())
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, bad("找不到该本地目录：" + abs)
	}
	if _, err := settings.Update(func(st *settings.Settings) error {
		registerVaultDir(st, abs, true)
		return nil
	}); err != nil {
		return nil, err
	}
	return s.vaultTreePayload(abs), nil
}

func (s *Server) articleVaultAdd(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Dir      string `json:"dir"`
		Activate *bool  `json:"activate"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	dir := strings.TrimSpace(body.Dir)
	if dir == "" {
		return nil, bad("请选择或输入本地文章目录路径")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, bad("目录路径无效：" + err.Error())
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, bad("找不到该本地目录：" + abs)
	}
	activate := true
	if body.Activate != nil {
		activate = *body.Activate
	}
	if _, err := settings.Update(func(st *settings.Settings) error {
		registerVaultDir(st, abs, activate)
		return nil
	}); err != nil {
		return nil, err
	}
	activeDir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	return s.vaultTreePayload(activeDir), nil
}

func (s *Server) articleVaultRemove(w http.ResponseWriter, r *http.Request) (any, error) {
	target := strings.TrimSpace(r.URL.Query().Get("dir"))
	if target == "" && r.Body != nil {
		var body struct {
			Dir string `json:"dir"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		target = strings.TrimSpace(body.Dir)
	}
	if target == "" {
		return nil, bad("请指定要移出的本地目录")
	}
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		targetAbs = filepath.Clean(target)
	}
	if _, err := settings.Update(func(st *settings.Settings) error {
		dirs := dedupeVaultDirs(st.ArticleVaultDirs)
		// If legacy single-dir config hasn't been materialized into ArticleVaultDirs yet.
		if len(dirs) == 0 && strings.TrimSpace(st.ArticleVaultDir) != "" {
			if pAbs, aErr := filepath.Abs(st.ArticleVaultDir); aErr == nil {
				dirs = []string{pAbs}
			}
		}
		remaining := make([]string, 0, len(dirs))
		for _, d := range dirs {
			if !sameVaultPath(d, targetAbs) {
				remaining = append(remaining, d)
			}
		}
		st.ArticleVaultDirs = remaining
		if sameVaultPath(st.ArticleVaultDir, targetAbs) || strings.TrimSpace(st.ArticleVaultDir) == "" {
			next := ""
			for _, d := range remaining {
				if statIsDir(d) {
					next = d
					break
				}
			}
			if next == "" && len(remaining) > 0 {
				next = remaining[0]
			}
			st.ArticleVaultDir = next
		}
		return nil
	}); err != nil {
		return nil, err
	}
	activeDir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	return s.vaultTreePayload(activeDir), nil
}

func (s *Server) articleVaultReadFile(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultMarkdownPath(dir, r.URL.Query().Get("path"), false)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absPath)
	if err != nil || info.IsDir() {
		return nil, notFound("找不到 Markdown 文件：" + normRel)
	}
	if info.Size() > vaultMaxBytes {
		return nil, bad("Markdown 文件过大（超过 8MB 限制）")
	}
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	content := strings.ReplaceAll(string(raw), "\r\n", "\n")
	var meta json.RawMessage
	if s.DB != nil {
		if doc, err := s.DB.GetDoc("article_meta", vaultMetaKey(absPath)); err == nil && len(doc.Data) > 0 {
			meta = doc.Data
		}
	}
	return map[string]any{
		"path":    normRel,
		"name":    filepath.Base(absPath),
		"title":   extractMarkdownTitle(content, absPath),
		"content": content,
		"modTime": info.ModTime().UnixMilli(),
		"meta":    meta,
	}, nil
}

func (s *Server) articleVaultWriteFile(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	var body struct {
		Path        string          `json:"path"`
		Content     string          `json:"content"`
		Title       string          `json:"title"`
		Meta        json.RawMessage `json:"meta"`
		EmbedImages bool            `json:"embedImages"`
		Slots       []struct {
			Role      string `json:"role"`
			Anchor    string `json:"anchor"`
			Title     string `json:"title"`
			ImagePath string `json:"imagePath"`
		} `json:"slots"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultMarkdownPath(dir, body.Path, true)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, err
	}

	content := strings.ReplaceAll(body.Content, "\r\n", "\n")
	writtenImages := 0

	// Optionally copy generated illustrations to relative ./assets/<slug>/ and embed
	// standard Markdown image links so Obsidian renders them natively (#65).
	if body.EmbedImages && len(body.Slots) > 0 {
		baseSlug := sanitizeName(strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath)))
		if baseSlug == "" {
			baseSlug = "article"
		}
		assetRelDir := "assets/" + baseSlug
		assetAbsDir := filepath.Join(filepath.Dir(absPath), filepath.FromSlash(assetRelDir))
		copySlotImage := func(srcPath string, idx int) string {
			if strings.TrimSpace(srcPath) == "" {
				return ""
			}
			b, rErr := os.ReadFile(srcPath)
			if rErr != nil {
				return ""
			}
			_ = os.MkdirAll(assetAbsDir, 0o755)
			fname := fmt.Sprintf("%02d%s", idx, sniffImageExt(b))
			if wErr := os.WriteFile(filepath.Join(assetAbsDir, fname), b, 0o644); wErr != nil {
				return ""
			}
			writtenImages++
			return assetRelDir + "/" + fname
		}

		var lines []string
		rawLines := strings.Split(content, "\n")
		imgIdx := 0

		// Embed cover right after H1 (or at top if no H1) if not already embedded.
		var coverLine string
		for _, sl := range body.Slots {
			if sl.Role == "cover" && sl.ImagePath != "" {
				imgIdx++
				if relImg := copySlotImage(sl.ImagePath, imgIdx); relImg != "" {
					alt := firstStr(sl.Title, body.Title, "封面")
					mdLink := fmt.Sprintf("![%s](%s)", alt, relImg)
					if !strings.Contains(content, relImg) {
						coverLine = mdLink
					}
				}
				break
			}
		}

		coverInserted := coverLine == ""
		usedSlot := map[int]bool{}
		for _, ln := range rawLines {
			lines = append(lines, ln)
			trimmed := strings.TrimSpace(ln)
			if !coverInserted && strings.HasPrefix(trimmed, "# ") {
				lines = append(lines, "", coverLine, "")
				coverInserted = true
			}
			for sIdx, sl := range body.Slots {
				if usedSlot[sIdx] || sl.Role == "cover" || sl.ImagePath == "" || strings.TrimSpace(sl.Anchor) == "" {
					continue
				}
				if strings.Contains(ln, sl.Anchor) {
					usedSlot[sIdx] = true
					imgIdx++
					if relImg := copySlotImage(sl.ImagePath, imgIdx); relImg != "" && !strings.Contains(content, relImg) {
						alt := firstStr(sl.Title, fmt.Sprintf("配图 %d", imgIdx))
						lines = append(lines, "", fmt.Sprintf("![%s](%s)", alt, relImg), "")
					}
				}
			}
		}
		if !coverInserted {
			lines = append([]string{coverLine, ""}, lines...)
		}
		content = strings.Join(lines, "\n")
	}

	if err := os.WriteFile(absPath, []byte(content), 0o644); err != nil {
		return nil, err
	}
	if s.DB != nil && len(body.Meta) > 0 {
		doc := store.Doc{
			Kind: "article_meta",
			ID:   vaultMetaKey(absPath),
			Name: normRel,
			Data: body.Meta,
		}
		_ = s.DB.PutDoc(&doc)
	}
	var modMs int64
	if info, err := os.Stat(absPath); err == nil {
		modMs = info.ModTime().UnixMilli()
	}
	return map[string]any{
		"ok":            true,
		"path":          normRel,
		"name":          filepath.Base(absPath),
		"title":         extractMarkdownTitle(content, absPath),
		"content":       content,
		"modTime":       modMs,
		"writtenImages": writtenImages,
	}, nil
}

func (s *Server) articleVaultDeleteFile(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultMarkdownPath(dir, r.URL.Query().Get("path"), false)
	if err != nil {
		return nil, err
	}
	if err := os.Remove(absPath); err != nil {
		return nil, bad("删除文件失败：" + err.Error())
	}
	if s.DB != nil {
		_ = s.DB.DeleteDocHard("article_meta", vaultMetaKey(absPath))
	}
	return map[string]any{"ok": true, "deleted": normRel}, nil
}

// resolveVaultRelPath validates any relative path (file or directory) strictly inside rootDir.
func resolveVaultRelPath(rootDir, relPath string, allowRoot bool) (absPath string, normRel string, err error) {
	rootAbs, err := filepath.Abs(rootDir)
	if err != nil {
		return "", "", err
	}
	raw := strings.TrimSpace(strings.ReplaceAll(relPath, "\\", "/"))
	raw = strings.Trim(raw, "/")
	if raw == "" || raw == "." {
		if allowRoot {
			return rootAbs, "", nil
		}
		return "", "", bad("请指定文章库内的相对路径")
	}
	if strings.Contains(raw, ":") {
		return "", "", bad("路径只能是文章库内的相对路径")
	}
	cleaned := filepath.Clean(filepath.FromSlash(raw))
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", "", bad("不允许访问文章库目录之外的路径")
	}
	for _, seg := range strings.Split(filepath.ToSlash(cleaned), "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return "", "", bad("名称无效或不能以点号开头")
		}
		if strings.ContainsAny(seg, `<>:"|?*`) {
			return "", "", bad("名称包含非法字符")
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

func (s *Server) migrateVaultMeta(oldAbs, newAbs, newRel string) {
	if s.DB == nil {
		return
	}
	oldKey := vaultMetaKey(oldAbs)
	newKey := vaultMetaKey(newAbs)
	if oldKey == newKey {
		return
	}
	if doc, err := s.DB.GetDoc("article_meta", oldKey); err == nil && len(doc.Data) > 0 {
		next := store.Doc{
			Kind: "article_meta",
			ID:   newKey,
			Name: newRel,
			Data: doc.Data,
		}
		_ = s.DB.PutDoc(&next)
		_ = s.DB.DeleteDocHard("article_meta", oldKey)
	}
}

func (s *Server) articleVaultMkdir(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultRelPath(dir, body.Path, false)
	if err != nil {
		return nil, err
	}
	if st, stErr := os.Stat(absPath); stErr == nil {
		if st.IsDir() {
			return nil, bad("该文件夹已存在：" + normRel)
		}
		return nil, bad("同名文件已存在：" + normRel)
	}
	if err := os.MkdirAll(absPath, 0o755); err != nil {
		return nil, bad("创建文件夹失败：" + err.Error())
	}
	return map[string]any{
		"ok":   true,
		"path": normRel,
		"name": filepath.Base(absPath),
	}, nil
}

func (s *Server) articleVaultRename(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	fromAbs, fromRel, err := resolveVaultRelPath(dir, body.From, false)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(fromAbs)
	if err != nil {
		return nil, notFound("找不到原路径：" + fromRel)
	}
	toInput := strings.TrimSpace(body.To)
	if !info.IsDir() && toInput != "" && !isMarkdownExt(toInput) {
		toInput += ".md"
	}
	toAbs, toRel, err := resolveVaultRelPath(dir, toInput, false)
	if err != nil {
		return nil, err
	}
	if fromRel == toRel {
		return map[string]any{"ok": true, "from": fromRel, "to": toRel, "isDir": info.IsDir()}, nil
	}
	if !sameVaultPath(fromAbs, toAbs) {
		if _, stErr := os.Stat(toAbs); stErr == nil {
			return nil, bad("目标路径已存在：" + toRel)
		}
	}
	if info.IsDir() && strings.HasPrefix(strings.ToLower(toRel)+"/", strings.ToLower(fromRel)+"/") {
		return nil, bad("不能将文件夹移动到自身子目录内")
	}

	// Collect markdown paths inside directory before rename so we can migrate sidecar metadata.
	var movedMDs []string
	if info.IsDir() {
		_ = filepath.WalkDir(fromAbs, func(p string, d os.DirEntry, wErr error) error {
			if wErr == nil && !d.IsDir() && isMarkdownExt(d.Name()) {
				if rel, rErr := filepath.Rel(fromAbs, p); rErr == nil {
					movedMDs = append(movedMDs, rel)
				}
			}
			return nil
		})
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		return nil, bad("重命名失败：" + err.Error())
	}
	var renamedPairs []renamedNotePair
	if info.IsDir() {
		for _, subRel := range movedMDs {
			oldFile := filepath.Join(fromAbs, subRel)
			newFile := filepath.Join(toAbs, subRel)
			newSubRel := filepath.ToSlash(filepath.Join(toRel, subRel))
			oldSubRel := filepath.ToSlash(filepath.Join(fromRel, subRel))
			s.migrateVaultMeta(oldFile, newFile, newSubRel)
			renamedPairs = append(renamedPairs, renamedNotePair{OldRel: oldSubRel, NewRel: newSubRel})
		}
	} else {
		s.migrateVaultMeta(fromAbs, toAbs, toRel)
		if isMarkdownExt(fromRel) && isMarkdownExt(toRel) {
			renamedPairs = append(renamedPairs, renamedNotePair{OldRel: fromRel, NewRel: toRel})
		}
	}
	updatedLinkFiles := rewriteVaultLinksOnRename(dir, renamedPairs)
	return map[string]any{
		"ok":               true,
		"from":             fromRel,
		"to":               toRel,
		"name":             filepath.Base(toAbs),
		"isDir":            info.IsDir(),
		"updatedLinkFiles": updatedLinkFiles,
	}, nil
}

func (s *Server) articleVaultDuplicate(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	srcAbs, srcRel, err := resolveVaultMarkdownPath(dir, body.Path, false)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(srcAbs)
	if err != nil {
		return nil, notFound("找不到原 Markdown 文件：" + srcRel)
	}
	ext := filepath.Ext(srcAbs)
	stem := strings.TrimSuffix(filepath.Base(srcAbs), ext)
	parentAbs := filepath.Dir(srcAbs)
	var dstAbs string
	for i := 1; i <= 99; i++ {
		suffix := " 副本"
		if i > 1 {
			suffix = fmt.Sprintf(" 副本 %d", i)
		}
		cand := filepath.Join(parentAbs, stem+suffix+ext)
		if _, stErr := os.Stat(cand); os.IsNotExist(stErr) {
			dstAbs = cand
			break
		}
	}
	if dstAbs == "" {
		return nil, bad("无法生成可用的副本文件名")
	}
	if err := os.WriteFile(dstAbs, raw, 0o644); err != nil {
		return nil, bad("复制文件失败：" + err.Error())
	}
	relNew, _ := filepath.Rel(dir, dstAbs)
	return map[string]any{
		"ok":   true,
		"path": filepath.ToSlash(relNew),
		"name": filepath.Base(dstAbs),
	}, nil
}

func (s *Server) articleVaultDeleteDir(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultRelPath(dir, r.URL.Query().Get("path"), false)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absPath)
	if err != nil || !info.IsDir() {
		return nil, notFound("找不到该文件夹：" + normRel)
	}
	var mdFiles []string
	_ = filepath.WalkDir(absPath, func(p string, d os.DirEntry, wErr error) error {
		if wErr == nil && !d.IsDir() && isMarkdownExt(d.Name()) {
			mdFiles = append(mdFiles, p)
		}
		return nil
	})
	if err := os.RemoveAll(absPath); err != nil {
		return nil, bad("删除文件夹失败：" + err.Error())
	}
	if s.DB != nil {
		for _, fp := range mdFiles {
			_ = s.DB.DeleteDocHard("article_meta", vaultMetaKey(fp))
		}
	}
	return map[string]any{"ok": true, "deleted": normRel}, nil
}

func (s *Server) articleVaultReveal(w http.ResponseWriter, r *http.Request) (any, error) {
	dir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	var body struct {
		Path string `json:"path"`
	}
	_ = decode(r, &body)
	absPath, _, err := resolveVaultRelPath(dir, body.Path, true)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return nil, notFound("本地路径不存在")
	}
	target := absPath
	if !info.IsDir() {
		target = filepath.Dir(absPath)
	}
	if s.Host == nil {
		return nil, bad("当前环境不支持打开系统文件管理器")
	}
	return okv, s.Host.OpenPath(target)
}
