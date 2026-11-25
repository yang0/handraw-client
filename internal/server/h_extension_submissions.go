package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/site"
)

var (
	submissionGitHubAPIBase = "https://api.github.com"
	submissionGitHubRawBase = "https://raw.githubusercontent.com"
	submissionGiteeAPIBase  = "https://gitee.com/api/v5"
	submissionGiteeRawBase  = "https://gitee.com"
)

type inspectedExtensionInfo struct {
	Channel     string   `json:"channel"`
	Name        string   `json:"name"`
	Slug        string   `json:"slug,omitempty"`
	RepoURL     string   `json:"repoUrl"`
	HomepageURL string   `json:"homepageUrl,omitempty"`
	Description string   `json:"description"`
	AuthorName  string   `json:"authorName,omitempty"`
	Version     string   `json:"version,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

var shorthandRepoRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func normalizeSubmissionRepoURL(raw string) (canonical string, hostKind string, owner string, repo string, branch string, subpath string, err error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", "", "", "", "", "", bad("请输入仓库地址或资源链接")
	}
	if shorthandRepoRe.MatchString(s) {
		s = "https://github.com/" + s
	}
	if !strings.HasPrefix(strings.ToLower(s), "http://") && !strings.HasPrefix(strings.ToLower(s), "https://") {
		if strings.HasPrefix(strings.ToLower(s), "github.com/") || strings.HasPrefix(strings.ToLower(s), "gitee.com/") {
			s = "https://" + s
		} else {
			return "", "", "", "", "", "", bad("请输入有效的 http(s) 仓库地址或 GitHub 的 owner/repo")
		}
	}
	u, pErr := url.Parse(s)
	if pErr != nil || u.Host == "" {
		return "", "", "", "", "", "", bad("仓库地址格式不正确")
	}
	lowHost := strings.ToLower(u.Hostname())
	segs := make([]string, 0, 6)
	for _, seg := range strings.Split(strings.Trim(u.Path, "/"), "/") {
		if seg != "" {
			segs = append(segs, seg)
		}
	}
	if (lowHost == "github.com" || lowHost == "www.github.com") && len(segs) >= 2 {
		owner = segs[0]
		repo = strings.TrimSuffix(segs[1], ".git")
		if len(segs) >= 4 && (segs[2] == "tree" || segs[2] == "blob") {
			branch = segs[3]
			if len(segs) > 4 {
				subpath = strings.Join(segs[4:], "/")
			}
		}
		return fmt.Sprintf("https://github.com/%s/%s", owner, repo), "github", owner, repo, branch, subpath, nil
	}
	if (lowHost == "gitee.com" || lowHost == "www.gitee.com") && len(segs) >= 2 {
		owner = segs[0]
		repo = strings.TrimSuffix(segs[1], ".git")
		if len(segs) >= 4 && (segs[2] == "tree" || segs[2] == "blob") {
			branch = segs[3]
			if len(segs) > 4 {
				subpath = strings.Join(segs[4:], "/")
			}
		}
		return fmt.Sprintf("https://gitee.com/%s/%s", owner, repo), "gitee", owner, repo, branch, subpath, nil
	}
	return s, "direct", "", "", "", "", nil
}

func fetchLimitedText(ctx context.Context, client *http.Client, targetURL string, maxBytes int64) (string, int) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return "", 0
	}
	req.Header.Set("User-Agent", "handraw-client-inspector/1.0")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	resp, err := client.Do(req)
	if err != nil {
		return "", 0
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", resp.StatusCode
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
	return string(b), resp.StatusCode
}

func parseSkillFrontmatterBasic(md string) (name, desc string) {
	text := strings.ReplaceAll(md, "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return "", ""
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return "", ""
	}
	fm := text[4 : 4+end]
	for _, ln := range strings.Split(fm, "\n") {
		k, v, ok := strings.Cut(ln, ":")
		if !ok {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(k))
		val := strings.Trim(strings.TrimSpace(v), `"'`)
		if key == "name" && name == "" {
			name = val
		} else if key == "description" && desc == "" {
			desc = val
		}
	}
	return name, desc
}

func normalizeValidChannel(ch, fallback string) string {
	switch strings.ToLower(strings.TrimSpace(ch)) {
	case "plugin", "gallery", "skill", "obsidian":
		return strings.ToLower(strings.TrimSpace(ch))
	}
	switch strings.ToLower(strings.TrimSpace(fallback)) {
	case "plugin", "gallery", "skill", "obsidian":
		return strings.ToLower(strings.TrimSpace(fallback))
	}
	return "plugin"
}

func dedupeShortTags(raw []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, 5)
	for _, t := range raw {
		v := strings.TrimSpace(t)
		if v == "" || len([]rune(v)) > 20 {
			continue
		}
		k := strings.ToLower(v)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
		if len(out) >= 5 {
			break
		}
	}
	return out
}

func firstNonEmptyReadmeSummary(readme string) string {
	for _, ln := range strings.Split(strings.ReplaceAll(readme, "\r\n", "\n"), "\n") {
		t := strings.TrimSpace(ln)
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "!") || strings.HasPrefix(t, "[![") || strings.HasPrefix(t, "<") || strings.HasPrefix(t, "---") {
			continue
		}
		if len([]rune(t)) >= 8 {
			if r := []rune(t); len(r) > 120 {
				return string(r[:120]) + "…"
			}
			return t
		}
	}
	return ""
}

// extensionSubmissionInspect fetches a GitHub/Gitee repository or direct manifest URL,
// extracts structured baseline metadata, and uses the configured text AI to produce
// clean Chinese basic fields so users only need to paste a repo URL and confirm (#157).
func (s *Server) extensionSubmissionInspect(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		RepoURL string `json:"repoUrl"`
		Channel string `json:"channel"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	canonicalURL, hostKind, owner, repo, branch, subpath, err := normalizeSubmissionRepoURL(body.RepoURL)
	if err != nil {
		return nil, err
	}

	httpClient := &http.Client{Timeout: 8 * time.Second}
	fetchCtx, fetchCancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer fetchCancel()

	info := inspectedExtensionInfo{
		Channel:     normalizeValidChannel("", body.Channel),
		Name:        repo,
		Slug:        strings.ToLower(repo),
		RepoURL:     canonicalURL,
		HomepageURL: canonicalURL,
		AuthorName:  owner,
	}
	files := map[string]string{}
	detectedFiles := make([]string, 0, 6)
	var repoAPIDesc string
	var repoAPITopics []string

	if hostKind == "github" || hostKind == "gitee" {
		// 1. Fetch repository API metadata for default branch, description, topics, homepage.
		apiURL := fmt.Sprintf("%s/repos/%s/%s", strings.TrimRight(submissionGitHubAPIBase, "/"), owner, repo)
		if hostKind == "gitee" {
			apiURL = fmt.Sprintf("%s/repos/%s/%s", strings.TrimRight(submissionGiteeAPIBase, "/"), owner, repo)
		}
		if rawMeta, status := fetchLimitedText(fetchCtx, httpClient, apiURL, 64*1024); status == 200 && rawMeta != "" {
			var meta struct {
				Name          string   `json:"name"`
				Description   string   `json:"description"`
				Homepage      string   `json:"homepage"`
				DefaultBranch string   `json:"default_branch"`
				Topics        []string `json:"topics"`
				Owner         struct {
					Login string `json:"login"`
				} `json:"owner"`
			}
			if json.Unmarshal([]byte(rawMeta), &meta) == nil {
				if branch == "" && meta.DefaultBranch != "" {
					branch = meta.DefaultBranch
				}
				if meta.Name != "" {
					info.Name = meta.Name
					info.Slug = strings.ToLower(meta.Name)
				}
				if meta.Owner.Login != "" {
					info.AuthorName = meta.Owner.Login
				}
				if strings.TrimSpace(meta.Homepage) != "" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(meta.Homepage)), "http") {
					info.HomepageURL = strings.TrimSpace(meta.Homepage)
				}
				repoAPIDesc = strings.TrimSpace(meta.Description)
				repoAPITopics = meta.Topics
				detectedFiles = append(detectedFiles, "repo-meta")
			}
		}

		branchesToTry := []string{}
		if branch != "" {
			branchesToTry = append(branchesToTry, branch)
		} else {
			branchesToTry = append(branchesToTry, "main", "master")
		}

		rawBase := func(br, file string) string {
			p := file
			if subpath != "" && !strings.Contains(subpath, ".") {
				p = strings.Trim(subpath, "/") + "/" + file
			}
			if hostKind == "gitee" {
				return fmt.Sprintf("%s/%s/%s/raw/%s/%s", strings.TrimRight(submissionGiteeRawBase, "/"), owner, repo, br, p)
			}
			return fmt.Sprintf("%s/%s/%s/%s/%s", strings.TrimRight(submissionGitHubRawBase, "/"), owner, repo, br, p)
		}

		// 2. Fetch candidate manifest & README files concurrently.
		candidates := []string{"manifest.json", "plugin.json", "package.json", "SKILL.md", "index.json", "README.md"}
		var mu sync.Mutex
		var wg sync.WaitGroup
		for _, fname := range candidates {
			fname := fname
			wg.Add(1)
			go func() {
				defer wg.Done()
				for _, br := range branchesToTry {
					txt, st := fetchLimitedText(fetchCtx, httpClient, rawBase(br, fname), 48*1024)
					if st == 200 && strings.TrimSpace(txt) != "" {
						mu.Lock()
						files[fname] = txt
						detectedFiles = append(detectedFiles, fname)
						mu.Unlock()
						return
					}
				}
			}()
		}
		wg.Wait()
	} else {
		// Direct file URL (index.json / manifest.json / SKILL.md / etc.)
		txt, st := fetchLimitedText(fetchCtx, httpClient, canonicalURL, 64*1024)
		if st != 200 || strings.TrimSpace(txt) == "" {
			return nil, bad("无法读取该链接内容，请检查地址是否公开可访问，或选择手动填写基础信息")
		}
		low := strings.ToLower(canonicalURL)
		switch {
		case strings.HasSuffix(low, "skill.md"):
			files["SKILL.md"] = txt
			detectedFiles = append(detectedFiles, "SKILL.md")
		case strings.HasSuffix(low, "manifest.json"):
			files["manifest.json"] = txt
			detectedFiles = append(detectedFiles, "manifest.json")
		case strings.HasSuffix(low, "plugin.json"):
			files["plugin.json"] = txt
			detectedFiles = append(detectedFiles, "plugin.json")
		case strings.HasSuffix(low, ".json"):
			files["index.json"] = txt
			detectedFiles = append(detectedFiles, "index.json")
		default:
			files["README.md"] = txt
			detectedFiles = append(detectedFiles, "content")
		}
	}

	// 3. Deterministic baseline extraction from manifest / SKILL.md / index.json / README.
	detectedChannel := ""
	tagsAcc := append([]string{}, repoAPITopics...)

	if rawSkill, ok := files["SKILL.md"]; ok {
		detectedChannel = "skill"
		sn, sd := parseSkillFrontmatterBasic(rawSkill)
		if sn != "" {
			info.Name = sn
		}
		if sd != "" {
			info.Description = sd
		}
	}
	if rawIdx, ok := files["index.json"]; ok {
		var idxObj struct {
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Title       string   `json:"title"`
			Description string   `json:"description"`
			Author      string   `json:"author"`
			Version     string   `json:"version"`
			Tags        []string `json:"tags"`
			Items       []any    `json:"items"`
			Galleries   []any    `json:"galleries"`
		}
		if json.Unmarshal([]byte(rawIdx), &idxObj) == nil {
			if len(idxObj.Items) > 0 || len(idxObj.Galleries) > 0 {
				if detectedChannel == "" {
					detectedChannel = "gallery"
				}
			}
			if v := firstStr(idxObj.Name, idxObj.Title); v != "" {
				info.Name = v
			}
			if idxObj.ID != "" {
				info.Slug = idxObj.ID
			}
			if idxObj.Description != "" && info.Description == "" {
				info.Description = idxObj.Description
			}
			if idxObj.Author != "" {
				info.AuthorName = idxObj.Author
			}
			if idxObj.Version != "" {
				info.Version = idxObj.Version
			}
			tagsAcc = append(tagsAcc, idxObj.Tags...)
		}
	}
	if rawMan, ok := files["manifest.json"]; ok {
		var man struct {
			ID            string   `json:"id"`
			Name          string   `json:"name"`
			Description   string   `json:"description"`
			Author        string   `json:"author"`
			Version       string   `json:"version"`
			MinAppVersion string   `json:"minAppVersion"`
			AuthorURL     string   `json:"authorUrl"`
			Tags          []string `json:"tags"`
		}
		if json.Unmarshal([]byte(rawMan), &man) == nil {
			if man.MinAppVersion != "" {
				detectedChannel = "obsidian"
			} else if detectedChannel == "" {
				detectedChannel = "plugin"
			}
			if man.Name != "" {
				info.Name = man.Name
			}
			if man.ID != "" {
				info.Slug = man.ID
			}
			if man.Description != "" {
				info.Description = man.Description
			}
			if man.Author != "" {
				info.AuthorName = man.Author
			}
			if man.Version != "" {
				info.Version = man.Version
			}
			tagsAcc = append(tagsAcc, man.Tags...)
		}
	}
	for _, pFile := range []string{"plugin.json", "package.json"} {
		if rawPkg, ok := files[pFile]; ok {
			var pkg struct {
				ID          string   `json:"id"`
				Name        string   `json:"name"`
				Description string   `json:"description"`
				Version     string   `json:"version"`
				Author      any      `json:"author"`
				Homepage    string   `json:"homepage"`
				Keywords    []string `json:"keywords"`
			}
			if json.Unmarshal([]byte(rawPkg), &pkg) == nil {
				if detectedChannel == "" {
					detectedChannel = "plugin"
				}
				if pkg.Name != "" && (info.Name == "" || info.Name == repo) {
					info.Name = pkg.Name
				}
				if pkg.ID != "" {
					info.Slug = pkg.ID
				}
				if pkg.Description != "" && info.Description == "" {
					info.Description = pkg.Description
				}
				if pkg.Version != "" && info.Version == "" {
					info.Version = pkg.Version
				}
				if info.AuthorName == "" {
					switch a := pkg.Author.(type) {
					case string:
						info.AuthorName = strings.TrimSpace(a)
					case map[string]any:
						if an, _ := a["name"].(string); strings.TrimSpace(an) != "" {
							info.AuthorName = strings.TrimSpace(an)
						}
					}
				}
				if pkg.Homepage != "" && info.HomepageURL == canonicalURL {
					info.HomepageURL = pkg.Homepage
				}
				tagsAcc = append(tagsAcc, pkg.Keywords...)
			}
		}
	}

	if detectedChannel != "" {
		info.Channel = detectedChannel
	}
	if info.Description == "" && repoAPIDesc != "" {
		info.Description = repoAPIDesc
	}
	if info.Description == "" && files["README.md"] != "" {
		info.Description = firstNonEmptyReadmeSummary(files["README.md"])
	}
	info.Tags = dedupeShortTags(tagsAcc)

	// 4. AI enrichment: turn raw manifest + README into clean Chinese display info.
	parsedBy := "manifest"
	if len(files) > 0 || repoAPIDesc != "" {
		var contextBuf strings.Builder
		contextBuf.WriteString("【仓库地址】\n")
		contextBuf.WriteString(canonicalURL)
		if body.Channel != "" {
			contextBuf.WriteString("\n【用户当前所在栏目提示】\n")
			contextBuf.WriteString(body.Channel)
		}
		if repoAPIDesc != "" {
			contextBuf.WriteString("\n【仓库简介】\n")
			contextBuf.WriteString(repoAPIDesc)
		}
		if len(repoAPITopics) > 0 {
			contextBuf.WriteString("\n【仓库 Topics】\n")
			contextBuf.WriteString(strings.Join(repoAPITopics, ", "))
		}
		for _, k := range []string{"manifest.json", "plugin.json", "index.json", "SKILL.md", "package.json", "README.md"} {
			if txt, ok := files[k]; ok && strings.TrimSpace(txt) != "" {
				rTxt := []rune(strings.TrimSpace(txt))
				limit := 1600
				if k == "README.md" {
					limit = 2600
				}
				if len(rTxt) > limit {
					txt = string(rTxt[:limit]) + "\n...(已截断)"
				}
				contextBuf.WriteString("\n\n【文件: " + k + "】\n")
				contextBuf.WriteString(txt)
			}
		}

		sysPrompt := strings.TrimSpace(`你是「手绘风」扩展市场收录审核助手。请阅读提供的仓库元信息、清单文件与 README，提炼出给用户确认的基础收录信息。

严格只输出一个 JSON 对象，不要包含额外文字，字段如下：
{
  "channel": "plugin | gallery | skill | obsidian（plugin=工作台插件/CLI/生图服务，gallery=图库/姿势/服装/画风参考图包，skill=AI Agent Skill/SKILL.md，obsidian=Obsidian/Markdown写作插件）",
  "name": "简洁清晰的展示名称（保留知名英文原名或给中文名，不超过 32 字）",
  "description": "1~2 句通俗中文简介（20~90 字），直接说明核心用途与亮点，不要空泛套话",
  "authorName": "作者或组织名称",
  "version": "版本号（如 1.2.0，未找到则留空）",
  "tags": ["2到4个简短中文或常用技术标签"]
}`)

		aiCtx, aiCancel := context.WithTimeout(r.Context(), 18*time.Second)
		chatRes, aiErr := s.executeHostChat(aiCtx, hostChatRequest{
			Scene:      "chat",
			Capability: "text",
			System:     sysPrompt,
			Messages:   []providers.ChatMessage{{Role: "user", Content: contextBuf.String()}},
			JSONMode:   true,
		})
		aiCancel()
		if aiErr == nil {
			rawAI := stripJSONCandidate(asString(chatRes["text"]))
			var aiOut struct {
				Channel     string   `json:"channel"`
				Name        string   `json:"name"`
				Description string   `json:"description"`
				AuthorName  string   `json:"authorName"`
				Version     string   `json:"version"`
				Tags        []string `json:"tags"`
			}
			if json.Unmarshal([]byte(rawAI), &aiOut) == nil && (strings.TrimSpace(aiOut.Name) != "" || strings.TrimSpace(aiOut.Description) != "") {
				parsedBy = "ai"
				if v := strings.TrimSpace(aiOut.Channel); v != "" {
					info.Channel = normalizeValidChannel(v, info.Channel)
				}
				if v := strings.TrimSpace(aiOut.Name); v != "" {
					info.Name = v
				}
				if v := strings.TrimSpace(aiOut.Description); v != "" {
					info.Description = v
				}
				if v := strings.TrimSpace(aiOut.AuthorName); v != "" {
					info.AuthorName = v
				}
				if v := strings.TrimSpace(aiOut.Version); v != "" && info.Version == "" {
					info.Version = v
				}
				if len(aiOut.Tags) > 0 {
					info.Tags = dedupeShortTags(aiOut.Tags)
				}
			}
		}
	}

	if info.Name == "" {
		info.Name = firstStr(repo, "未命名扩展")
	}
	if info.Description == "" {
		info.Description = fmt.Sprintf("来自 %s 的扩展资源", canonicalURL)
	}

	return map[string]any{
		"ok":            true,
		"parsedBy":      parsedBy,
		"detectedFiles": detectedFiles,
		"info":          info,
	}, nil
}

func (s *Server) extensionSubmissionCreate(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	var body struct {
		Channel     string   `json:"channel"`
		Name        string   `json:"name"`
		Slug        string   `json:"slug,omitempty"`
		RepoURL     string   `json:"repoUrl"`
		HomepageURL string   `json:"homepageUrl,omitempty"`
		Description string   `json:"description"`
		AuthorName  string   `json:"authorName,omitempty"`
		Version     string   `json:"version,omitempty"`
		Category    string   `json:"category,omitempty"`
		Tags        []string `json:"tags,omitempty"`
		Contact     string   `json:"contact,omitempty"`
		Notes       string   `json:"notes,omitempty"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	payload := map[string]any{
		"channel":      strings.TrimSpace(body.Channel),
		"name":         strings.TrimSpace(body.Name),
		"slug":         strings.TrimSpace(body.Slug),
		"repoUrl":      strings.TrimSpace(body.RepoURL),
		"homepageUrl":  strings.TrimSpace(body.HomepageURL),
		"description":  strings.TrimSpace(body.Description),
		"authorName":   strings.TrimSpace(body.AuthorName),
		"version":      strings.TrimSpace(body.Version),
		"category":     strings.TrimSpace(body.Category),
		"tags":         body.Tags,
		"contact":      strings.TrimSpace(body.Contact),
		"notes":        strings.TrimSpace(body.Notes),
		"sourceClient": "desktop",
	}
	var resp map[string]any
	if err := s.Site.Do(r.Context(), http.MethodPost, "/api/extensions/submissions", payload, &resp); err != nil {
		return nil, err
	}
	if resp == nil {
		resp = map[string]any{"ok": true}
	}
	resp["siteBase"] = s.Site.Base()
	return resp, nil
}

func (s *Server) extensionSubmissionMine(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return map[string]any{
			"ok":       true,
			"loggedIn": false,
			"items":    []any{},
			"siteBase": s.Site.Base(),
		}, nil
	}
	qs := url.Values{}
	if ch := strings.TrimSpace(r.URL.Query().Get("channel")); ch != "" {
		qs.Set("channel", ch)
	}
	if lim := strings.TrimSpace(r.URL.Query().Get("limit")); lim != "" {
		qs.Set("limit", lim)
	}
	path := "/api/extensions/submissions/mine"
	if enc := qs.Encode(); enc != "" {
		path += "?" + enc
	}
	var resp map[string]any
	if err := s.Site.Do(r.Context(), http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	if resp == nil {
		resp = map[string]any{"ok": true, "items": []any{}}
	}
	resp["loggedIn"] = true
	resp["siteBase"] = s.Site.Base()
	return resp, nil
}
