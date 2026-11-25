package server

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var (
	wikiLinkRe = regexp.MustCompile(`(!)?\[\[([^\[\]\r\n]+)\]\]`)
	mdLinkRe   = regexp.MustCompile(`(!)?\[([^\]]*)\]\(([^)\r\n]+)\)`)
	inlineCodeRe = regexp.MustCompile("`[^`\r\n]+`")
)

type vaultNoteInfo struct {
	Path     string   `json:"path"`
	Name     string   `json:"name"`
	Basename string   `json:"basename"`
	Title    string   `json:"title"`
	Aliases  []string `json:"aliases,omitempty"`
	Headings []string `json:"headings,omitempty"`
}

type vaultAttachmentInfo struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Basename  string `json:"basename"`
	Extension string `json:"extension"`
	IsImage   bool   `json:"isImage"`
}

type parsedVaultLink struct {
	Raw          string `json:"raw"`
	Target       string `json:"target"`
	Heading      string `json:"heading,omitempty"`
	Alias        string `json:"alias,omitempty"`
	IsEmbed      bool   `json:"isEmbed"`
	IsMarkdown   bool   `json:"isMarkdown,omitempty"`
	ResolvedPath string `json:"resolvedPath,omitempty"`
	Exists       bool   `json:"exists"`
	IsImage      bool   `json:"isImage,omitempty"`
	Line         int    `json:"line"`
	Snippet      string `json:"snippet"`
}

type vaultBacklink struct {
	SourcePath  string `json:"sourcePath"`
	SourceName  string `json:"sourceName"`
	SourceTitle string `json:"sourceTitle"`
	Line        int    `json:"line"`
	Snippet     string `json:"snippet"`
	Raw         string `json:"raw"`
	IsEmbed     bool   `json:"isEmbed"`
}

type vaultUnlinkedMention struct {
	SourcePath  string `json:"sourcePath"`
	SourceName  string `json:"sourceName"`
	SourceTitle string `json:"sourceTitle"`
	Line        int    `json:"line"`
	Snippet     string `json:"snippet"`
	MatchText   string `json:"matchText"`
}

type vaultGraphNode struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Path      string `json:"path,omitempty"`
	Exists    bool   `json:"exists"`
	Degree    int    `json:"degree"`
	IsCurrent bool   `json:"isCurrent,omitempty"`
}

type vaultGraphEdge struct {
	Source  string `json:"source"`
	Target  string `json:"target"`
	IsEmbed bool   `json:"isEmbed,omitempty"`
}

type vaultLinkIndex struct {
	RootDir     string
	Notes       []vaultNoteInfo
	NoteByPath  map[string]vaultNoteInfo
	NoteContent map[string]string
	Attachments []vaultAttachmentInfo
	AttachByPath map[string]vaultAttachmentInfo
}

func isImageExt(ext string) bool {
	switch strings.ToLower(strings.TrimPrefix(ext, ".")) {
	case "png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif":
		return true
	}
	return false
}

func stripMarkdownExt(p string) string {
	low := strings.ToLower(p)
	if strings.HasSuffix(low, ".markdown") {
		return p[:len(p)-len(".markdown")]
	}
	if strings.HasSuffix(low, ".md") {
		return p[:len(p)-len(".md")]
	}
	return p
}

func parseFrontmatterAliasesAndHeadings(content string) (aliases []string, headings []string, bodyStartLine int) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	start := 0
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		inAliases := false
		for i := 1; i < len(lines); i++ {
			t := strings.TrimSpace(lines[i])
			if t == "---" {
				start = i + 1
				break
			}
			if inAliases {
				if strings.HasPrefix(t, "- ") {
					val := trimYAMLQuote(strings.TrimSpace(strings.TrimPrefix(t, "- ")))
					if val != "" {
						aliases = append(aliases, val)
					}
					continue
				}
				if strings.Contains(t, ":") {
					inAliases = false
				}
			}
			low := strings.ToLower(t)
			if strings.HasPrefix(low, "aliases:") || strings.HasPrefix(low, "alias:") {
				idx := strings.IndexByte(t, ':')
				rest := strings.TrimSpace(t[idx+1:])
				if rest == "" {
					inAliases = true
				} else if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
					inner := strings.TrimSpace(rest[1 : len(rest)-1])
					for _, part := range strings.Split(inner, ",") {
						v := trimYAMLQuote(strings.TrimSpace(part))
						if v != "" {
							aliases = append(aliases, v)
						}
					}
				} else {
					for _, part := range strings.Split(rest, ",") {
						v := trimYAMLQuote(strings.TrimSpace(part))
						if v != "" {
							aliases = append(aliases, v)
						}
					}
				}
			}
		}
	}
	inFence := false
	for i := start; i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if strings.HasPrefix(t, "#") {
			j := 0
			for j < len(t) && j < 6 && t[j] == '#' {
				j++
			}
			if j > 0 && j < len(t) && t[j] == ' ' {
				h := strings.TrimSpace(t[j+1:])
				if h != "" {
					headings = append(headings, h)
				}
			}
		}
	}
	return aliases, headings, start
}

func trimYAMLQuote(s string) string {
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		return s[1 : len(s)-1]
	}
	return s
}

func buildVaultLinkIndex(rootAbs string) *vaultLinkIndex {
	idx := &vaultLinkIndex{
		RootDir:      rootAbs,
		NoteByPath:   map[string]vaultNoteInfo{},
		NoteContent:  map[string]string{},
		AttachByPath: map[string]vaultAttachmentInfo{},
	}
	if !statIsDir(rootAbs) {
		return idx
	}
	const maxFiles = 3000
	count := 0
	var walk func(dir, prefix string, depth int)
	walk = func(dir, prefix string, depth int) {
		if depth > 10 || count >= maxFiles {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if count >= maxFiles {
				break
			}
			name := e.Name()
			if name == "" || strings.HasPrefix(name, ".") {
				continue
			}
			low := strings.ToLower(name)
			if e.IsDir() {
				if low == "node_modules" || low == "__pycache__" || low == "vendor" {
					continue
				}
				subPrefix := name
				if prefix != "" {
					subPrefix = prefix + "/" + name
				}
				walk(filepath.Join(dir, name), subPrefix, depth+1)
				continue
			}
			rel := name
			if prefix != "" {
				rel = prefix + "/" + name
			}
			count++
			if isMarkdownExt(name) {
				raw, rErr := os.ReadFile(filepath.Join(dir, name))
				if rErr != nil || len(raw) > vaultMaxBytes {
					continue
				}
				content := strings.ReplaceAll(string(raw), "\r\n", "\n")
				aliases, headings, _ := parseFrontmatterAliasesAndHeadings(content)
				ext := filepath.Ext(name)
				base := strings.TrimSuffix(name, ext)
				info := vaultNoteInfo{
					Path:     rel,
					Name:     name,
					Basename: base,
					Title:    extractMarkdownTitle(content, name),
					Aliases:  aliases,
					Headings: headings,
				}
				idx.Notes = append(idx.Notes, info)
				idx.NoteByPath[rel] = info
				idx.NoteContent[rel] = content
			} else {
				ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
				base := strings.TrimSuffix(name, filepath.Ext(name))
				att := vaultAttachmentInfo{
					Path:      rel,
					Name:      name,
					Basename:  base,
					Extension: ext,
					IsImage:   isImageExt(ext),
				}
				idx.Attachments = append(idx.Attachments, att)
				idx.AttachByPath[rel] = att
			}
		}
	}
	walk(rootAbs, "", 0)
	sort.Slice(idx.Notes, func(i, j int) bool { return strings.ToLower(idx.Notes[i].Path) < strings.ToLower(idx.Notes[j].Path) })
	sort.Slice(idx.Attachments, func(i, j int) bool { return strings.ToLower(idx.Attachments[i].Path) < strings.ToLower(idx.Attachments[j].Path) })
	return idx
}

func (idx *vaultLinkIndex) resolveTarget(rawTarget, sourcePath string) (resolvedPath string, exists bool, isImage bool) {
	t := strings.TrimSpace(rawTarget)
	if t == "" {
		return "", false, false
	}
	if unesc, err := url.PathUnescape(t); err == nil {
		t = unesc
	}
	t = strings.ReplaceAll(t, "\\", "/")
	t = strings.TrimPrefix(t, "./")

	tryExact := func(cand string) (string, bool, bool) {
		cand = strings.TrimLeft(path.Clean("/"+cand), "/")
		if cand == "" || cand == "." {
			return "", false, false
		}
		if _, ok := idx.NoteByPath[cand]; ok {
			return cand, true, false
		}
		if _, ok := idx.NoteByPath[cand+".md"]; ok {
			return cand + ".md", true, false
		}
		if att, ok := idx.AttachByPath[cand]; ok {
			return cand, true, att.IsImage
		}
		// Case-insensitive exact path fallback
		low := strings.ToLower(cand)
		for p := range idx.NoteByPath {
			pl := strings.ToLower(p)
			if pl == low || pl == low+".md" || strings.ToLower(stripMarkdownExt(p)) == low {
				return p, true, false
			}
		}
		for p, att := range idx.AttachByPath {
			if strings.ToLower(p) == low {
				return p, true, att.IsImage
			}
		}
		return "", false, false
	}

	// 1. Relative to source note's directory
	if sourcePath != "" {
		srcDir := path.Dir(strings.ReplaceAll(sourcePath, "\\", "/"))
		if srcDir != "." && srcDir != "" {
			if rp, ok, img := tryExact(srcDir + "/" + t); ok {
				return rp, true, img
			}
		}
	}
	// 2. Direct vault-relative path
	if rp, ok, img := tryExact(t); ok {
		return rp, true, img
	}

	// 3. Obsidian shortest-path match on note basename / filename / alias
	lowT := strings.ToLower(t)
	lowTNoExt := strings.ToLower(stripMarkdownExt(t))
	for _, n := range idx.Notes {
		if strings.ToLower(n.Basename) == lowTNoExt || strings.ToLower(n.Name) == lowT {
			return n.Path, true, false
		}
	}
	for _, n := range idx.Notes {
		for _, al := range n.Aliases {
			if strings.ToLower(al) == lowT {
				return n.Path, true, false
			}
		}
	}
	// 4. Shortest-path match on attachments (e.g. ![[cover.png]])
	for _, att := range idx.Attachments {
		if strings.ToLower(att.Name) == lowT || strings.ToLower(att.Path) == lowT || strings.HasSuffix(strings.ToLower(att.Path), "/"+lowT) {
			return att.Path, true, att.IsImage
		}
	}
	return "", false, isImageExt(filepath.Ext(t))
}

func maskInlineCode(line string) string {
	return inlineCodeRe.ReplaceAllStringFunc(line, func(m string) string {
		return strings.Repeat(" ", len(m))
	})
}

func (idx *vaultLinkIndex) parseNoteLinks(sourcePath, content string) []parsedVaultLink {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	_, _, bodyStart := parseFrontmatterAliasesAndHeadings(content)
	inFence := false
	var out []parsedVaultLink

	for i := bodyStart; i < len(lines); i++ {
		rawLine := lines[i]
		trimmed := strings.TrimSpace(rawLine)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		masked := maskInlineCode(rawLine)
		snippet := strings.TrimSpace(rawLine)
		if utf8.RuneCountInString(snippet) > 140 {
			rs := []rune(snippet)
			snippet = string(rs[:140]) + "…"
		}

		// 1. Wikilinks & Embeds: [[...]] / ![[...]]
		for _, m := range wikiLinkRe.FindAllStringSubmatch(masked, -1) {
			isEmbed := m[1] == "!"
			inner := m[2]
			targetPart := inner
			alias := ""
			if pipe := strings.IndexByte(inner, '|'); pipe >= 0 {
				targetPart = inner[:pipe]
				alias = strings.TrimSpace(inner[pipe+1:])
			}
			heading := ""
			if hash := strings.IndexByte(targetPart, '#'); hash >= 0 {
				heading = strings.TrimSpace(targetPart[hash+1:])
				targetPart = targetPart[:hash]
			}
			target := strings.TrimSpace(targetPart)
			if target == "" {
				continue
			}
			rp, exists, isImg := idx.resolveTarget(target, sourcePath)
			out = append(out, parsedVaultLink{
				Raw:          m[0],
				Target:       target,
				Heading:      heading,
				Alias:        alias,
				IsEmbed:      isEmbed,
				ResolvedPath: rp,
				Exists:       exists,
				IsImage:      isImg,
				Line:         i + 1,
				Snippet:      snippet,
			})
		}

		// 2. Standard Markdown relative links: [text](target.md) / ![alt](assets/pic.png)
		for _, m := range mdLinkRe.FindAllStringSubmatch(masked, -1) {
			isEmbed := m[1] == "!"
			label := strings.TrimSpace(m[2])
			href := strings.TrimSpace(m[3])
			// Strip optional title in quotes
			if sp := strings.IndexAny(href, " \t"); sp > 0 {
				href = strings.TrimSpace(href[:sp])
			}
			href = strings.Trim(href, "<>")
			lowHref := strings.ToLower(href)
			if href == "" || strings.HasPrefix(lowHref, "http://") || strings.HasPrefix(lowHref, "https://") ||
				strings.HasPrefix(lowHref, "mailto:") || strings.HasPrefix(lowHref, "data:") || strings.HasPrefix(href, "#") {
				continue
			}
			heading := ""
			if hash := strings.IndexByte(href, '#'); hash >= 0 {
				heading = strings.TrimSpace(href[hash+1:])
				href = href[:hash]
			}
			if href == "" {
				continue
			}
			rp, exists, isImg := idx.resolveTarget(href, sourcePath)
			out = append(out, parsedVaultLink{
				Raw:          m[0],
				Target:       href,
				Heading:      heading,
				Alias:        label,
				IsEmbed:      isEmbed,
				IsMarkdown:   true,
				ResolvedPath: rp,
				Exists:       exists,
				IsImage:      isImg,
				Line:         i + 1,
				Snippet:      snippet,
			})
		}
	}
	return out
}

func maskAllLinks(line string) string {
	s := maskInlineCode(line)
	s = wikiLinkRe.ReplaceAllStringFunc(s, func(m string) string { return strings.Repeat(" ", len(m)) })
	s = mdLinkRe.ReplaceAllStringFunc(s, func(m string) string { return strings.Repeat(" ", len(m)) })
	return s
}

func isASCIIWordByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_'
}

func findMentionIndex(maskedLine, term string) int {
	lowLine := strings.ToLower(maskedLine)
	lowTerm := strings.ToLower(term)
	if lowTerm == "" {
		return -1
	}
	isASCII := true
	for i := 0; i < len(lowTerm); i++ {
		if lowTerm[i] >= 128 {
			isASCII = false
			break
		}
	}
	off := 0
	for {
		i := strings.Index(lowLine[off:], lowTerm)
		if i < 0 {
			return -1
		}
		pos := off + i
		end := pos + len(lowTerm)
		if !isASCII {
			return pos
		}
		leftOK := pos == 0 || !isASCIIWordByte(maskedLine[pos-1])
		rightOK := end >= len(maskedLine) || !isASCIIWordByte(maskedLine[end])
		if leftOK && rightOK {
			return pos
		}
		off = pos + 1
	}
}

func (s *Server) articleVaultLinks(w http.ResponseWriter, r *http.Request) (any, error) {
	rootAbs, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	idx := buildVaultLinkIndex(rootAbs)

	activePath := strings.TrimSpace(strings.ReplaceAll(r.URL.Query().Get("path"), "\\", "/"))
	activePath = strings.TrimLeft(activePath, "/")
	if activePath != "" {
		if _, ok := idx.NoteByPath[activePath]; !ok {
			if rp, ok, _ := idx.resolveTarget(activePath, ""); ok {
				activePath = rp
			}
		}
	}

	// Build graph + outgoing + backlinks across all notes
	nodeMap := map[string]*vaultGraphNode{}
	for _, n := range idx.Notes {
		nodeMap[n.Path] = &vaultGraphNode{
			ID:        n.Path,
			Label:     n.Basename,
			Path:      n.Path,
			Exists:    true,
			IsCurrent: activePath != "" && strings.EqualFold(n.Path, activePath),
		}
	}
	edgeSeen := map[string]bool{}
	var edges []vaultGraphEdge
	var outgoing []parsedVaultLink
	var backlinks []vaultBacklink

	for _, n := range idx.Notes {
		links := idx.parseNoteLinks(n.Path, idx.NoteContent[n.Path])
		if activePath != "" && strings.EqualFold(n.Path, activePath) {
			outgoing = links
		}
		for _, lk := range links {
			// Skip image attachments from note relationship graph (keep note-to-note graph clean)
			if lk.IsImage {
				continue
			}
			var targetID string
			if lk.Exists && lk.ResolvedPath != "" {
				if _, isNote := idx.NoteByPath[lk.ResolvedPath]; !isNote {
					continue
				}
				targetID = lk.ResolvedPath
			} else if !lk.IsMarkdown {
				// Dangling wikilink target -> show as unresolved node in graph (classic Obsidian!)
				cleanTarget := strings.TrimSpace(stripMarkdownExt(lk.Target))
				if cleanTarget == "" {
					continue
				}
				targetID = "unresolved:" + strings.ToLower(cleanTarget)
				if _, ok := nodeMap[targetID]; !ok {
					nodeMap[targetID] = &vaultGraphNode{
						ID:     targetID,
						Label:  path.Base(cleanTarget),
						Path:   cleanTarget + ".md",
						Exists: false,
					}
				}
			} else {
				continue
			}

			if targetID == n.Path {
				continue
			}
			eKey := n.Path + "->" + targetID
			if !edgeSeen[eKey] {
				edgeSeen[eKey] = true
				edges = append(edges, vaultGraphEdge{
					Source:  n.Path,
					Target:  targetID,
					IsEmbed: lk.IsEmbed,
				})
				if srcNode := nodeMap[n.Path]; srcNode != nil {
					srcNode.Degree++
				}
				if dstNode := nodeMap[targetID]; dstNode != nil {
					dstNode.Degree++
				}
			}

			if activePath != "" && strings.EqualFold(targetID, activePath) && !strings.EqualFold(n.Path, activePath) {
				backlinks = append(backlinks, vaultBacklink{
					SourcePath:  n.Path,
					SourceName:  n.Basename,
					SourceTitle: n.Title,
					Line:        lk.Line,
					Snippet:     lk.Snippet,
					Raw:         lk.Raw,
					IsEmbed:     lk.IsEmbed,
				})
			}
		}
	}

	// Unlinked mentions for active note
	var unlinked []vaultUnlinkedMention
	if activeNote, ok := idx.NoteByPath[activePath]; ok {
		terms := []string{}
		addTerm := func(t string) {
			t = strings.TrimSpace(t)
			if utf8.RuneCountInString(t) < 2 {
				return
			}
			for _, ex := range terms {
				if strings.EqualFold(ex, t) {
					return
				}
			}
			terms = append(terms, t)
		}
		addTerm(activeNote.Basename)
		for _, al := range activeNote.Aliases {
			addTerm(al)
		}

		for _, other := range idx.Notes {
			if strings.EqualFold(other.Path, activePath) || len(unlinked) >= 40 {
				continue
			}
			lines := strings.Split(idx.NoteContent[other.Path], "\n")
			_, _, bodyStart := parseFrontmatterAliasesAndHeadings(idx.NoteContent[other.Path])
			inFence := false
			for i := bodyStart; i < len(lines) && len(unlinked) < 40; i++ {
				trimmed := strings.TrimSpace(lines[i])
				if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
					inFence = !inFence
					continue
				}
				if inFence {
					continue
				}
				masked := maskAllLinks(lines[i])
				for _, term := range terms {
					if pos := findMentionIndex(masked, term); pos >= 0 {
						matched := lines[i][pos : pos+len(term)]
						snip := trimmed
						if utf8.RuneCountInString(snip) > 140 {
							snip = string([]rune(snip)[:140]) + "…"
						}
						unlinked = append(unlinked, vaultUnlinkedMention{
							SourcePath:  other.Path,
							SourceName:  other.Basename,
							SourceTitle: other.Title,
							Line:        i + 1,
							Snippet:     snip,
							MatchText:   matched,
						})
						break
					}
				}
			}
		}
	}

	nodes := make([]vaultGraphNode, 0, len(nodeMap))
	for _, nd := range nodeMap {
		nodes = append(nodes, *nd)
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].IsCurrent != nodes[j].IsCurrent {
			return nodes[i].IsCurrent
		}
		if nodes[i].Degree != nodes[j].Degree {
			return nodes[i].Degree > nodes[j].Degree
		}
		return strings.ToLower(nodes[i].Label) < strings.ToLower(nodes[j].Label)
	})

	if outgoing == nil {
		outgoing = []parsedVaultLink{}
	}
	if backlinks == nil {
		backlinks = []vaultBacklink{}
	}
	if unlinked == nil {
		unlinked = []vaultUnlinkedMention{}
	}
	if edges == nil {
		edges = []vaultGraphEdge{}
	}

	return map[string]any{
		"rootDir":          rootAbs,
		"activePath":       activePath,
		"notes":            idx.Notes,
		"attachments":      idx.Attachments,
		"outgoing":         outgoing,
		"backlinks":        backlinks,
		"unlinkedMentions": unlinked,
		"graph": map[string]any{
			"nodes": nodes,
			"edges": edges,
		},
	}, nil
}

func (s *Server) articleVaultLinkify(w http.ResponseWriter, r *http.Request) (any, error) {
	rootAbs, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	var body struct {
		SourcePath string `json:"sourcePath"`
		Line       int    `json:"line"`
		MatchText  string `json:"matchText"`
		TargetName string `json:"targetName"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultMarkdownPath(rootAbs, body.SourcePath, false)
	if err != nil {
		return nil, err
	}
	matchText := strings.TrimSpace(body.MatchText)
	targetName := strings.TrimSpace(body.TargetName)
	if matchText == "" || targetName == "" || body.Line <= 0 {
		return nil, bad("缺少要转换的文本或目标笔记名")
	}
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return nil, notFound("找不到文档：" + normRel)
	}
	content := strings.ReplaceAll(string(raw), "\r\n", "\n")
	lines := strings.Split(content, "\n")
	if body.Line > len(lines) {
		return nil, bad("行号超出文档范围")
	}
	lineIdx := body.Line - 1
	masked := maskAllLinks(lines[lineIdx])
	pos := findMentionIndex(masked, matchText)
	if pos < 0 {
		return nil, bad("该行未找到可转换的未链接提及（可能已是双链）")
	}
	orig := lines[lineIdx][pos : pos+len(matchText)]
	replacement := fmt.Sprintf("[[%s]]", targetName)
	if !strings.EqualFold(orig, targetName) {
		replacement = fmt.Sprintf("[[%s|%s]]", targetName, orig)
	}
	lines[lineIdx] = lines[lineIdx][:pos] + replacement + lines[lineIdx][pos+len(matchText):]
	if err := os.WriteFile(absPath, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":          true,
		"sourcePath":  normRel,
		"line":        body.Line,
		"updatedLine": lines[lineIdx],
	}, nil
}

func setVaultAssetHeaders(w http.ResponseWriter, absPath string) {
	w.Header().Set("Cache-Control", "no-cache")
	ext := strings.ToLower(filepath.Ext(absPath))
	switch ext {
	case ".webp":
		w.Header().Set("Content-Type", "image/webp")
	case ".avif":
		w.Header().Set("Content-Type", "image/avif")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Content-Security-Policy", "sandbox")
	case ".html", ".htm":
		w.Header().Set("Content-Security-Policy", "sandbox")
	case ".mp4", ".m4v":
		w.Header().Set("Content-Type", "video/mp4")
	case ".webm":
		w.Header().Set("Content-Type", "video/webm")
	case ".mov":
		w.Header().Set("Content-Type", "video/quicktime")
	case ".ogv":
		w.Header().Set("Content-Type", "video/ogg")
	case ".mkv":
		w.Header().Set("Content-Type", "video/x-matroska")
	case ".mp3":
		w.Header().Set("Content-Type", "audio/mpeg")
	case ".wav":
		w.Header().Set("Content-Type", "audio/wav")
	case ".ogg":
		w.Header().Set("Content-Type", "audio/ogg")
	case ".m4a":
		w.Header().Set("Content-Type", "audio/mp4")
	case ".flac":
		w.Header().Set("Content-Type", "audio/flac")
	case ".aac":
		w.Header().Set("Content-Type", "audio/aac")
	case ".opus":
		w.Header().Set("Content-Type", "audio/opus")
	case ".pdf":
		w.Header().Set("Content-Type", "application/pdf")
	}
}

// fileVaultAsset serves local attachments (e.g. images, videos, audio, PDFs)
// strictly inside the active article vault.
func (s *Server) fileVaultAsset(w http.ResponseWriter, r *http.Request) {
	rootAbs, err := s.activeArticleVaultDir()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	rawPath := strings.TrimSpace(r.URL.Query().Get("path"))
	fromNote := strings.TrimSpace(r.URL.Query().Get("from"))
	if rawPath == "" {
		http.NotFound(w, r)
		return
	}
	// Try direct relative path first, then Obsidian shortest-path lookup.
	resolved := rawPath
	if abs, _, rErr := resolveVaultAnyFilePath(rootAbs, rawPath); rErr == nil {
		if st, sErr := os.Stat(abs); sErr == nil && !st.IsDir() {
			setVaultAssetHeaders(w, abs)
			http.ServeFile(w, r, abs)
			return
		}
	}
	idx := buildVaultLinkIndex(rootAbs)
	if rp, ok, _ := idx.resolveTarget(rawPath, fromNote); ok {
		resolved = rp
	}
	abs, _, rErr := resolveVaultAnyFilePath(rootAbs, resolved)
	if rErr != nil {
		http.NotFound(w, r)
		return
	}
	st, sErr := os.Stat(abs)
	if sErr != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	setVaultAssetHeaders(w, abs)
	http.ServeFile(w, r, abs)
}

type renamedNotePair struct {
	OldRel string // forward-slash vault-relative path, e.g. "2026/旧笔记.md"
	NewRel string // forward-slash vault-relative path, e.g. "2026/新笔记.md"
}

// rewriteVaultLinksOnRename updates [[wikilinks]] and relative Markdown links across
// the entire vault whenever one or more markdown notes are renamed or moved (#116).
func rewriteVaultLinksOnRename(rootAbs string, moves []renamedNotePair) int {
	if len(moves) == 0 || !statIsDir(rootAbs) {
		return 0
	}
	type moveMeta struct {
		oldRel      string
		newRel      string
		oldNoExt    string
		newNoExt    string
		oldBase     string
		newBase     string
		oldRelLow   string
		oldNoExtLow string
		oldBaseLow  string
	}
	ms := make([]moveMeta, 0, len(moves))
	for _, mv := range moves {
		oRel := strings.TrimLeft(strings.ReplaceAll(mv.OldRel, "\\", "/"), "/")
		nRel := strings.TrimLeft(strings.ReplaceAll(mv.NewRel, "\\", "/"), "/")
		if oRel == "" || nRel == "" || oRel == nRel {
			continue
		}
		oNoExt := stripMarkdownExt(oRel)
		nNoExt := stripMarkdownExt(nRel)
		oBase := path.Base(oNoExt)
		nBase := path.Base(nNoExt)
		ms = append(ms, moveMeta{
			oldRel:      oRel,
			newRel:      nRel,
			oldNoExt:    oNoExt,
			newNoExt:    nNoExt,
			oldBase:     oBase,
			newBase:     nBase,
			oldRelLow:   strings.ToLower(oRel),
			oldNoExtLow: strings.ToLower(oNoExt),
			oldBaseLow:  strings.ToLower(oBase),
		})
	}
	if len(ms) == 0 {
		return 0
	}

	idx := buildVaultLinkIndex(rootAbs)
	updatedCount := 0

	for _, note := range idx.Notes {
		content := idx.NoteContent[note.Path]
		lines := strings.Split(content, "\n")
		inFence := false
		changed := false
		noteDir := path.Dir(note.Path)

		for i, ln := range lines {
			trimmed := strings.TrimSpace(ln)
			if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
				inFence = !inFence
				continue
			}
			if inFence {
				continue
			}

			// 1. Rewrite wikilinks [[...]] / ![[...]]
			nextLine := wikiLinkRe.ReplaceAllStringFunc(ln, func(match string) string {
				sub := wikiLinkRe.FindStringSubmatch(match)
				if len(sub) < 3 {
					return match
				}
				bang := sub[1]
				inner := sub[2]
				targetPart := inner
				aliasPart := ""
				if pipe := strings.IndexByte(inner, '|'); pipe >= 0 {
					targetPart = inner[:pipe]
					aliasPart = inner[pipe:] // includes "|"
				}
				headingPart := ""
				if hash := strings.IndexByte(targetPart, '#'); hash >= 0 {
					headingPart = targetPart[hash:] // includes "#"
					targetPart = targetPart[:hash]
				}
				tClean := strings.TrimSpace(strings.ReplaceAll(targetPart, "\\", "/"))
				tNoExtLow := strings.ToLower(stripMarkdownExt(strings.TrimPrefix(tClean, "./")))
				tHasSlash := strings.Contains(tClean, "/")

				for _, mv := range ms {
					if tHasSlash {
						// Match full vault path or noteDir-relative path
						cand := strings.TrimLeft(path.Clean("/"+tClean), "/")
						candNoExt := strings.ToLower(stripMarkdownExt(cand))
						relCand := ""
						if noteDir != "." && noteDir != "" {
							relCand = strings.ToLower(stripMarkdownExt(strings.TrimLeft(path.Clean("/"+noteDir+"/"+tClean), "/")))
						}
						if candNoExt == mv.oldNoExtLow || (relCand != "" && relCand == mv.oldNoExtLow) {
							changed = true
							return fmt.Sprintf("%s[[%s%s%s]]", bang, mv.newNoExt, headingPart, aliasPart)
						}
					} else if tNoExtLow == mv.oldBaseLow {
						changed = true
						return fmt.Sprintf("%s[[%s%s%s]]", bang, mv.newBase, headingPart, aliasPart)
					}
				}
				return match
			})

			// 2. Rewrite relative Markdown links [text](old.md)
			nextLine = mdLinkRe.ReplaceAllStringFunc(nextLine, func(match string) string {
				sub := mdLinkRe.FindStringSubmatch(match)
				if len(sub) < 4 {
					return match
				}
				bang, label, hrefRaw := sub[1], sub[2], sub[3]
				href := strings.TrimSpace(hrefRaw)
				low := strings.ToLower(href)
				if strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://") || strings.HasPrefix(href, "#") {
					return match
				}
				headingPart := ""
				if hash := strings.IndexByte(href, '#'); hash >= 0 {
					headingPart = href[hash:]
					href = href[:hash]
				}
				if unesc, uErr := url.PathUnescape(href); uErr == nil {
					href = unesc
				}
				normHref := strings.TrimLeft(path.Clean("/"+strings.ReplaceAll(href, "\\", "/")), "/")
				relResolved := normHref
				if noteDir != "." && noteDir != "" && !strings.HasPrefix(href, "/") {
					relResolved = strings.TrimLeft(path.Clean("/"+noteDir+"/"+strings.ReplaceAll(href, "\\", "/")), "/")
				}
				for _, mv := range ms {
					if strings.ToLower(normHref) == mv.oldRelLow || strings.ToLower(relResolved) == mv.oldRelLow {
						changed = true
						newTarget := mv.newRel
						if noteDir != "." && noteDir != "" && strings.HasPrefix(mv.newRel, noteDir+"/") {
							newTarget = strings.TrimPrefix(mv.newRel, noteDir+"/")
						}
						return fmt.Sprintf("%s[%s](%s%s)", bang, label, newTarget, headingPart)
					}
				}
				return match
			})

			lines[i] = nextLine
		}

		if changed {
			absPath := filepath.Join(rootAbs, filepath.FromSlash(note.Path))
			if err := os.WriteFile(absPath, []byte(strings.Join(lines, "\n")), 0o644); err == nil {
				updatedCount++
			}
		}
	}
	return updatedCount
}
