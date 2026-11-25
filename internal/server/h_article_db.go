package server

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

type vaultTableColumn struct {
	Key  string `json:"key"`
	Type string `json:"type"` // text | select | multi_select | date | number
}

type vaultTableRow struct {
	Path          string         `json:"path"`
	Name          string         `json:"name"`
	Basename      string         `json:"basename"`
	Title         string         `json:"title"`
	Folder        string         `json:"folder"`
	ModTime       int64          `json:"modTime"`
	WordCount     int            `json:"wordCount"`
	BacklinkCount int            `json:"backlinkCount"`
	OutlinkCount  int            `json:"outlinkCount"`
	CoverImage    string         `json:"coverImage,omitempty"`
	Properties    map[string]any `json:"properties"`
}

var (
	firstImgEmbedRe = regexp.MustCompile(`!\[\[([^\[\]\r\n|]+?)(?:\|[^\[\]\r\n]*)?\]\]`)
	firstImgMdRe    = regexp.MustCompile(`!\[[^\]]*\]\(([^)\r\n]+)\)`)
)

func parseFullFrontmatter(content string) (map[string]any, string) {
	props := map[string]any{}
	norm := strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(norm, "---\n") && norm != "---" {
		return props, norm
	}
	lines := strings.Split(norm, "\n")
	endIdx := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			endIdx = i
			break
		}
	}
	if endIdx < 0 {
		return props, norm
	}

	var curKey string
	var curList []string
	flushList := func() {
		if curKey != "" {
			props[curKey] = curList
			curKey = ""
			curList = nil
		}
	}

	for i := 1; i < endIdx; i++ {
		raw := lines[i]
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if curKey != "" && (strings.HasPrefix(raw, " ") || strings.HasPrefix(raw, "\t")) && strings.HasPrefix(trimmed, "- ") {
			val := trimYAMLQuote(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
			if val != "" {
				curList = append(curList, val)
			}
			continue
		}
		if !strings.HasPrefix(raw, " ") && !strings.HasPrefix(raw, "\t") {
			flushList()
			colon := strings.IndexByte(raw, ':')
			if colon <= 0 {
				continue
			}
			key := strings.TrimSpace(raw[:colon])
			val := strings.TrimSpace(raw[colon+1:])
			if key == "" {
				continue
			}
			if val == "" {
				curKey = key
				curList = []string{}
				continue
			}
			if strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]") {
				inner := strings.TrimSpace(val[1 : len(val)-1])
				arr := []string{}
				if inner != "" {
					for _, p := range strings.Split(inner, ",") {
						s := trimYAMLQuote(strings.TrimSpace(p))
						if s != "" {
							arr = append(arr, s)
						}
					}
				}
				props[key] = arr
			} else {
				props[key] = trimYAMLQuote(val)
			}
		}
	}
	flushList()
	body := strings.Join(lines[endIdx+1:], "\n")
	return props, body
}

func formatYAMLScalar(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r", ""), "\n", " ")
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, ":#[]{},&*!?|>\"'%@`") || strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ") {
		escaped := strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
		return `"` + escaped + `"`
	}
	return s
}

func formatYAMLKeyLine(key string, val any) string {
	switch v := val.(type) {
	case []string:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			item = strings.TrimSpace(item)
			if item != "" {
				parts = append(parts, formatYAMLScalar(item))
			}
		}
		return fmt.Sprintf("%s: [%s]", key, strings.Join(parts, ", "))
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			s := strings.TrimSpace(fmt.Sprint(item))
			if s != "" {
				parts = append(parts, formatYAMLScalar(s))
			}
		}
		return fmt.Sprintf("%s: [%s]", key, strings.Join(parts, ", "))
	default:
		return fmt.Sprintf("%s: %s", key, formatYAMLScalar(strings.TrimSpace(fmt.Sprint(v))))
	}
}

// patchFrontmatterLossless updates or removes top-level YAML frontmatter keys
// while leaving untouched frontmatter keys/comments and the Markdown body byte-for-byte intact (#126).
func patchFrontmatterLossless(content string, set map[string]any, remove []string) string {
	eol := "\n"
	if strings.Contains(content, "\r\n") {
		eol = "\r\n"
	}
	norm := strings.ReplaceAll(content, "\r\n", "\n")

	removeSet := map[string]bool{}
	for _, k := range remove {
		k = strings.TrimSpace(k)
		if k != "" {
			removeSet[strings.ToLower(k)] = true
		}
	}
	setNorm := map[string]struct {
		key string
		val any
	}{}
	orderedSetKeys := make([]string, 0, len(set))
	for k, v := range set {
		ck := strings.TrimSpace(k)
		if ck == "" || strings.ContainsAny(ck, ":\r\n") {
			continue
		}
		low := strings.ToLower(ck)
		if _, ok := setNorm[low]; !ok {
			orderedSetKeys = append(orderedSetKeys, low)
		}
		setNorm[low] = struct {
			key string
			val any
		}{key: ck, val: v}
	}
	sort.Strings(orderedSetKeys)

	var fmLines []string
	var bodyPart string
	hasFM := false

	if strings.HasPrefix(norm, "---\n") {
		lines := strings.Split(norm, "\n")
		endIdx := -1
		for i := 1; i < len(lines); i++ {
			if strings.TrimSpace(lines[i]) == "---" {
				endIdx = i
				break
			}
		}
		if endIdx > 0 {
			hasFM = true
			fmLines = append(fmLines, lines[1:endIdx]...)
			bodyPart = strings.Join(lines[endIdx+1:], "\n")
		}
	}
	if !hasFM {
		bodyPart = norm
	}

	// Walk existing frontmatter lines, replacing or dropping matched keys (including indented list continuations)
	handled := map[string]bool{}
	outFM := make([]string, 0, len(fmLines)+len(orderedSetKeys))
	skipIndented := false
	for _, ln := range fmLines {
		isIndented := strings.HasPrefix(ln, " ") || strings.HasPrefix(ln, "\t")
		if isIndented {
			if skipIndented {
				continue
			}
			outFM = append(outFM, ln)
			continue
		}
		skipIndented = false
		trimmed := strings.TrimSpace(ln)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			outFM = append(outFM, ln)
			continue
		}
		colon := strings.IndexByte(ln, ':')
		if colon <= 0 {
			outFM = append(outFM, ln)
			continue
		}
		origKey := strings.TrimSpace(ln[:colon])
		low := strings.ToLower(origKey)
		if removeSet[low] {
			skipIndented = true
			continue
		}
		if entry, ok := setNorm[low]; ok {
			outFM = append(outFM, formatYAMLKeyLine(origKey, entry.val))
			handled[low] = true
			skipIndented = true
			continue
		}
		outFM = append(outFM, ln)
	}

	for _, low := range orderedSetKeys {
		if handled[low] || removeSet[low] {
			continue
		}
		entry := setNorm[low]
		outFM = append(outFM, formatYAMLKeyLine(entry.key, entry.val))
	}

	if len(outFM) == 0 && !hasFM {
		return content
	}
	var rebuilt string
	if len(outFM) == 0 {
		rebuilt = strings.TrimPrefix(bodyPart, "\n")
	} else {
		sep := "\n"
		if !hasFM && bodyPart != "" && !strings.HasPrefix(bodyPart, "\n") {
			sep = "\n\n"
		}
		rebuilt = "---\n" + strings.Join(outFM, "\n") + "\n---" + sep + bodyPart
	}
	if eol == "\r\n" {
		return strings.ReplaceAll(rebuilt, "\n", "\r\n")
	}
	return rebuilt
}

func extractFirstCoverImage(props map[string]any, body string) string {
	for _, k := range []string{"cover", "banner", "image", "thumbnail"} {
		if v, ok := props[k]; ok {
			if s, ok2 := v.(string); ok2 && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	if m := firstImgEmbedRe.FindStringSubmatch(body); len(m) > 1 && isImageExt(filepath.Ext(m[1])) {
		return strings.TrimSpace(m[1])
	}
	if m := firstImgMdRe.FindStringSubmatch(body); len(m) > 1 && isImageExt(filepath.Ext(m[1])) {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func (s *Server) articleVaultTable(w http.ResponseWriter, r *http.Request) (any, error) {
	rootDir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	dirParam := strings.Trim(strings.ReplaceAll(strings.TrimSpace(r.URL.Query().Get("dir")), "\\", "/"), "/")
	if strings.Contains(dirParam, "..") {
		return nil, bad("非法目录路径")
	}
	recursive := r.URL.Query().Get("recursive") != "0"

	idx := buildVaultLinkIndex(rootDir)

	// Precompute backlink and outgoing link counts per note path
	backCounts := map[string]int{}
	outCounts := map[string]int{}
	for _, note := range idx.Notes {
		content := idx.NoteContent[note.Path]
		links := idx.parseNoteLinks(note.Path, content)
		seenOut := map[string]bool{}
		for _, lk := range links {
			if lk.IsImage {
				continue
			}
			targetKey := strings.ToLower(lk.ResolvedPath)
			if targetKey == "" {
				targetKey = "unresolved:" + strings.ToLower(lk.Target)
			}
			if !seenOut[targetKey] {
				seenOut[targetKey] = true
				outCounts[note.Path]++
				if lk.ResolvedPath != "" && lk.ResolvedPath != note.Path {
					backCounts[lk.ResolvedPath]++
				}
			}
		}
	}

	colTypes := map[string]string{
		"status": "select",
		"tags":   "multi_select",
		"date":   "date",
	}
	statusSet := map[string]bool{}
	defaultStatuses := []string{"选题池", "写作中", "待配图", "校对中", "已发布"}
	for _, st := range defaultStatuses {
		statusSet[st] = true
	}

	rows := make([]vaultTableRow, 0, len(idx.Notes))
	for _, note := range idx.Notes {
		folder := ""
		if slash := strings.LastIndexByte(note.Path, '/'); slash > 0 {
			folder = note.Path[:slash]
		}
		if dirParam != "" {
			if recursive {
				if folder != dirParam && !strings.HasPrefix(folder, dirParam+"/") {
					continue
				}
			} else if folder != dirParam {
				continue
			}
		}
		content := idx.NoteContent[note.Path]
		props, body := parseFullFrontmatter(content)
		for k, v := range props {
			lk := strings.ToLower(k)
			if lk == "title" {
				continue
			}
			if _, isArr := v.([]string); isArr {
				colTypes[lk] = "multi_select"
			} else if _, exists := colTypes[lk]; !exists {
				colTypes[lk] = "text"
			}
		}
		if stVal, ok := props["status"].(string); ok && strings.TrimSpace(stVal) != "" {
			statusSet[strings.TrimSpace(stVal)] = true
		}

		var modTime int64
		if fi, statErr := os.Stat(filepath.Join(rootDir, filepath.FromSlash(note.Path))); statErr == nil {
			modTime = fi.ModTime().Unix()
		}
		title := note.Title
		if tProp, ok := props["title"].(string); ok && strings.TrimSpace(tProp) != "" {
			title = strings.TrimSpace(tProp)
		}
		if title == "" {
			title = note.Basename
		}

		rows = append(rows, vaultTableRow{
			Path:          note.Path,
			Name:          note.Name,
			Basename:      note.Basename,
			Title:         title,
			Folder:        folder,
			ModTime:       modTime,
			WordCount:     utf8.RuneCountInString(strings.TrimSpace(body)),
			BacklinkCount: backCounts[note.Path],
			OutlinkCount:  outCounts[note.Path],
			CoverImage:    extractFirstCoverImage(props, body),
			Properties:    props,
		})
	}

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].ModTime != rows[j].ModTime {
			return rows[i].ModTime > rows[j].ModTime
		}
		return rows[i].Path < rows[j].Path
	})

	cols := make([]vaultTableColumn, 0, len(colTypes))
	for k, t := range colTypes {
		cols = append(cols, vaultTableColumn{Key: k, Type: t})
	}
	sort.Slice(cols, func(i, j int) bool { return cols[i].Key < cols[j].Key })

	extraStatuses := []string{}
	for st := range statusSet {
		isDef := false
		for _, d := range defaultStatuses {
			if d == st {
				isDef = true
				break
			}
		}
		if !isDef {
			extraStatuses = append(extraStatuses, st)
		}
	}
	sort.Strings(extraStatuses)
	statusOptions := append(append([]string{}, defaultStatuses...), extraStatuses...)

	return map[string]any{
		"dir":           dirParam,
		"columns":       cols,
		"rows":          rows,
		"statusOptions": statusOptions,
	}, nil
}

func (s *Server) articleVaultPatchFrontmatter(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Path   string         `json:"path"`
		Set    map[string]any `json:"set"`
		Remove []string       `json:"remove"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	rootDir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultMarkdownPath(rootDir, body.Path, false)
	if err != nil {
		return nil, err
	}
	rawBytes, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}
	updated := patchFrontmatterLossless(string(rawBytes), body.Set, body.Remove)
	if err := os.WriteFile(absPath, []byte(updated), 0o644); err != nil {
		return nil, fmt.Errorf("写回 YAML 属性失败: %w", err)
	}
	props, _ := parseFullFrontmatter(updated)
	return map[string]any{
		"ok":         true,
		"path":       normRel,
		"properties": props,
	}, nil
}
