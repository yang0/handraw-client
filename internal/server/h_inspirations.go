package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/extensions"
	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/netutil"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
	"github.com/yang0/handraw-client/internal/telemetry"
)

type inspirationSlot struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	DefaultValue string `json:"defaultValue"`
}

type inspirationData struct {
	Title          string            `json:"title"`
	ImagePath      string            `json:"imagePath,omitempty"`
	ImageURL       string            `json:"imageUrl,omitempty"`
	Prompt         string            `json:"prompt"`
	PromptZh       string            `json:"promptZh,omitempty"`
	RawText        string            `json:"rawText,omitempty"`
	Slots          []inspirationSlot `json:"slots,omitempty"`
	Tags           []string          `json:"tags,omitempty"`
	Folder         string            `json:"folder,omitempty"`
	Notes          string            `json:"notes,omitempty"`
	Source         string            `json:"source"` // local | community | x | web | chrome | import
	SourceURL      string            `json:"sourceUrl,omitempty"`
	SourceAuthor   string            `json:"sourceAuthor,omitempty"`
	RunID          string            `json:"runId,omitempty"`
	WorkID         string            `json:"workId,omitempty"`
	PublishedID    string            `json:"publishedId,omitempty"`
	PublishedURL   string            `json:"publishedUrl,omitempty"`
	PublishedPrice int               `json:"publishedPrice,omitempty"`
	Recipe         map[string]any    `json:"recipe,omitempty"`
	RefSpecs       []RunRefMeta      `json:"refSpecs,omitempty"`
	SuggestedStyle string            `json:"suggestedStyle,omitempty"`
	AIOrganized    bool              `json:"aiOrganized,omitempty"`
	CreatedAt      string            `json:"createdAt,omitempty"`
}

type inspirationItem struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	UpdatedAt          string `json:"updatedAt"`
	Category           string `json:"category,omitempty"`
	RunPublishedWorkID string `json:"runPublishedWorkId,omitempty"`
	RunPublishedURL    string `json:"runPublishedUrl,omitempty"`
	RunIsSkill         bool   `json:"runIsSkill,omitempty"`
	inspirationData
}

type inspirationCategoryRule struct {
	Name     string
	Keywords []string
}

// Canonical top-level inspiration categories (#95) to prevent free-form tag sprawl.
var inspirationCategoryRules = []inspirationCategoryRule{
	{
		Name:     "科普信息图",
		Keywords: []string{"信息图", "科普", "自然科学", "标本", "档案", "教育", "流程图", "知识卡", "结构", "拆解", "图解", "数据", "百科", "对比图", "infographic"},
	},
	{
		Name:     "角色设定",
		Keywords: []string{"角色设定", "三视图", "角色", "一致性", "ip", "盲盒", "潮玩", "三维", "3d", "动画", "手办", "立绘", "q版", "character"},
	},
	{
		Name:     "海报排版",
		Keywords: []string{"海报", "排版", "负空间", "极简", "封面", "杂志", "书法", "题字", "字体", "社媒", "小红书", "卡片", "poster", "editorial"},
	},
	{
		Name:     "人物写真",
		Keywords: []string{"人像", "写真", "摄影", "汉服", "古风", "自拍", "姿势", "网格", "工笔人物", "肖像", "时尚", "穿搭", "模特", "portrait"},
	},
	{
		Name:     "插画绘本",
		Keywords: []string{"插画", "绘本", "手绘", "水彩", "漫画", "二次元", "治愈", "卡通", "儿童", "涂鸦", "线稿", "国画", "工笔", "illustration"},
	},
	{
		Name:     "场景氛围",
		Keywords: []string{"场景", "风景", "建筑", "室内", "街景", "氛围", "电影感", "光影", "微缩", "空间", "雨夜", "雪景", "landscape"},
	},
	{
		Name:     "创意脑洞",
		Keywords: []string{"创意", "反差", "超现实", "电商", "产品", "包装", "奇幻", "特效", "合成", "广告", "概念", "surreal"},
	},
}

func inferInspirationCategory(data inspirationData) string {
	// 1. Exact match against canonical category name in tags
	for _, rawTag := range data.Tags {
		t := strings.TrimPrefix(strings.TrimSpace(rawTag), "#")
		for _, rule := range inspirationCategoryRules {
			if t == rule.Name {
				return rule.Name
			}
		}
	}
	// 2. Keyword match across tags + title (tags weighted first)
	tagHay := strings.ToLower(strings.Join(data.Tags, " "))
	for _, rule := range inspirationCategoryRules {
		for _, kw := range rule.Keywords {
			if strings.Contains(tagHay, strings.ToLower(kw)) {
				return rule.Name
			}
		}
	}
	titleHay := strings.ToLower(data.Title + " " + data.Notes)
	for _, rule := range inspirationCategoryRules {
		for _, kw := range rule.Keywords {
			if strings.Contains(titleHay, strings.ToLower(kw)) {
				return rule.Name
			}
		}
	}
	return "其他灵感"
}

func normalizeInspirationTags(raw []string) []string {
	out := make([]string, 0, 6)
	seen := map[string]bool{}
	for _, t := range raw {
		clean := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "#"))
		if clean == "" {
			continue
		}
		key := strings.ToLower(clean)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, clean)
		if len(out) >= 12 {
			break
		}
	}
	return out
}

const (
	inspirationFoldersKVKey   = "inspiration_folders"
	inspirationUngroupedToken = "__ungrouped__"
)

func cleanInspirationFolderName(raw string) (string, error) {
	name := strings.Join(strings.Fields(strings.TrimSpace(raw)), " ")
	if name == "" {
		return "", bad("分组名称不能为空")
	}
	if name == inspirationUngroupedToken || name == "全部" || name == "未分组" {
		return "", bad("「" + name + "」为系统保留名称，请换一个分组名")
	}
	if len([]rune(name)) > 40 {
		return "", bad("分组名称最多 40 个字")
	}
	return name, nil
}

func defaultInspirationFolders() []string {
	out := make([]string, 0, len(inspirationCategoryRules))
	for _, r := range inspirationCategoryRules {
		if clean, err := cleanInspirationFolderName(r.Name); err == nil {
			out = append(out, clean)
		}
	}
	return out
}

func (s *Server) backfillDefaultFoldersOnce() {
	docs, err := s.DB.ListDocs("inspiration", false)
	if err != nil {
		return
	}
	for _, d := range docs {
		var data inspirationData
		if err := json.Unmarshal(d.Data, &data); err != nil {
			continue
		}
		if strings.TrimSpace(data.Folder) != "" {
			continue
		}
		cat := inferInspirationCategory(data)
		if cat == "" || cat == "其他灵感" {
			continue
		}
		data.Folder = cat
		_, _ = s.saveInspiration(d.ID, data)
	}
}

func (s *Server) loadSavedInspirationFolders() []string {
	var raw []string
	err := s.DB.GetKV(inspirationFoldersKVKey, &raw)
	if errors.Is(err, store.ErrNotFound) {
		defaults := defaultInspirationFolders()
		if saved, sErr := s.saveInspirationFolders(defaults); sErr == nil {
			s.backfillDefaultFoldersOnce()
			return saved
		}
		return defaults
	}
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, f := range raw {
		clean, err := cleanInspirationFolderName(f)
		if err != nil || seen[clean] {
			continue
		}
		seen[clean] = true
		out = append(out, clean)
	}
	return out
}

func (s *Server) saveInspirationFolders(folders []string) ([]string, error) {
	out := make([]string, 0, len(folders))
	seen := map[string]bool{}
	for _, f := range folders {
		clean, err := cleanInspirationFolderName(f)
		if err != nil || seen[clean] {
			continue
		}
		seen[clean] = true
		out = append(out, clean)
	}
	if err := s.DB.SetKV(inspirationFoldersKVKey, out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Server) ensureInspirationFolder(name string) {
	clean, err := cleanInspirationFolderName(name)
	if err != nil {
		return
	}
	existing := s.loadSavedInspirationFolders()
	for _, f := range existing {
		if f == clean {
			return
		}
	}
	_, _ = s.saveInspirationFolders(append(existing, clean))
}

func inspirationImageDir() string {
	dir := filepath.Join(appdir.Library(), "inspirations")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func saveInspirationImageBytes(id string, raw []byte) (string, string, error) {
	if len(raw) == 0 {
		return "", "", nil
	}
	ext := sniffImageExt(raw)
	sum := sha256.Sum256(raw)
	outPath := filepath.Join(inspirationImageDir(), id+ext)
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		return "", "", err
	}
	return outPath, hex.EncodeToString(sum[:]), nil
}

func fetchRemoteImageBytes(ctx context.Context, rawURL string, referer ...string) ([]byte, error) {
	rawURL = strings.TrimSpace(rawURL)
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return nil, fmt.Errorf("不支持的图片链接")
	}
	ref := ""
	if len(referer) > 0 {
		ref = strings.TrimSpace(referer[0])
	}
	if ref == "" {
		if pu, pErr := url.Parse(rawURL); pErr == nil {
			host := strings.ToLower(pu.Hostname())
			if strings.HasSuffix(host, "twimg.com") {
				ref = "https://x.com/"
			} else if strings.HasSuffix(host, "xhscdn.com") {
				ref = "https://www.xiaohongshu.com/"
			}
		}
	}
	hc := netutil.NewClient(20 * time.Second)
	resp, err := netutil.DoWithRetry(ctx, hc, func() (*http.Request, error) {
		req, rErr := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if rErr != nil {
			return nil, rErr
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
		req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
		if ref != "" {
			req.Header.Set("Referer", ref)
		}
		return req, nil
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("下载图片失败 (HTTP %d)", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 12<<20))
	if err != nil {
		return nil, err
	}
	if !isValidImageBytes(resp.Header.Get("Content-Type"), raw) {
		return nil, fmt.Errorf("该链接返回的不是有效图片（可能是网页地址，请使用上方「解析链接」抓取）")
	}
	return raw, nil
}

func (s *Server) readInspiration(id string) (inspirationItem, error) {
	d, err := s.DB.GetDoc("inspiration", id)
	if err != nil {
		return inspirationItem{}, err
	}
	var data inspirationData
	_ = json.Unmarshal(d.Data, &data)
	if data.Title == "" {
		data.Title = d.Name
	}
	return inspirationItem{
		ID:              d.ID,
		Name:            d.Name,
		UpdatedAt:       d.UpdatedAt,
		inspirationData: data,
	}, nil
}

func (s *Server) saveInspiration(id string, data inspirationData) (inspirationItem, error) {
	if id == "" {
		id = jobs.NewID("insp")
	}
	if strings.TrimSpace(data.Title) == "" {
		data.Title = firstNRunes(firstStr(data.PromptZh, data.Prompt, data.RawText, "未命名灵感"), 24)
	}
	if data.Source == "" {
		data.Source = "import"
	}
	if data.CreatedAt == "" {
		data.CreatedAt = store.Now()
	}
	b, _ := json.Marshal(data)
	doc := &store.Doc{
		Kind: "inspiration",
		ID:   id,
		Name: data.Title,
		Data: b,
	}
	if err := s.DB.PutDoc(doc); err != nil {
		return inspirationItem{}, err
	}
	return s.readInspiration(id)
}

func (s *Server) pullCloudClipsBestEffort(ctx context.Context) int {
	if s.Site == nil || !s.Site.LoggedIn() {
		return 0
	}
	raw, err := s.Site.Send(ctx, http.MethodGet, "/api/me/inspirations?limit=30", nil)
	if err != nil {
		return 0
	}
	var resp struct {
		Items []struct {
			ID            string   `json:"id"`
			Title         string   `json:"title"`
			ImageURL      string   `json:"imageUrl"`
			RawText       string   `json:"rawText"`
			Prompt        string   `json:"prompt"`
			SourceURL     string   `json:"sourceUrl"`
			SourceAuthor  string   `json:"sourceAuthor"`
			SourceChannel string   `json:"sourceChannel"`
			Tags          []string `json:"tags"`
			CreatedAt     string   `json:"createdAt"`
		} `json:"items"`
	}
	if json.Unmarshal(raw, &resp) != nil || len(resp.Items) == 0 {
		return 0
	}
	imported := 0
	for _, cl := range resp.Items {
		if cl.ID == "" {
			continue
		}
		if _, err := s.DB.GetDoc("inspiration", cl.ID); err == nil {
			continue
		}
		imgPath := ""
		imgURL := cl.ImageURL
		if strings.HasPrefix(imgURL, "/") {
			imgURL = strings.TrimRight(s.Site.Base(), "/") + imgURL
		}
		if imgURL != "" {
			if rawImg, dErr := fetchRemoteImageBytes(ctx, imgURL, cl.SourceURL); dErr == nil && len(rawImg) > 0 {
				if p, _, sErr := saveInspirationImageBytes(cl.ID, rawImg); sErr == nil {
					imgPath = p
				}
			} else if dErr != nil && s.Telemetry != nil {
				s.Telemetry.ReportError(telemetry.ErrorReport{
					Category: "clip_image_fail",
					Severity: "warn",
					Source:   "backend",
					Route:    "cloud_clip_sync",
					Domain:   telemetry.SanitizeDomain(imgURL),
					Message:  dErr.Error(),
				})
			}
		}
		data := inspirationData{
			Title:        firstStr(cl.Title, firstNRunes(firstStr(cl.Prompt, cl.RawText, "云端剪藏灵感"), 24)),
			ImagePath:    imgPath,
			ImageURL:     imgURL,
			Prompt:       firstStr(cl.Prompt, cl.RawText),
			RawText:      cl.RawText,
			Tags:         cl.Tags,
			Source:       firstStr(cl.SourceChannel, "chrome"),
			SourceURL:    cl.SourceURL,
			SourceAuthor: cl.SourceAuthor,
			CreatedAt:    cl.CreatedAt,
		}
		if _, err := s.saveInspiration(cl.ID, data); err == nil {
			imported++
			_, _ = s.Site.Send(ctx, http.MethodPost, "/api/me/inspirations/"+url.PathEscape(cl.ID)+"/delete", map[string]any{})
		}
	}
	return imported
}

func (s *Server) inspirationsList(w http.ResponseWriter, r *http.Request) (any, error) {
	if r.URL.Query().Get("sync") != "0" && s.Site != nil && s.Site.LoggedIn() {
		go func() {
			cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if s.pullCloudClipsBestEffort(cctx) > 0 {
				s.Emit("inspirations", map[string]any{"updated": true, "synced": true})
			}
		}()
	}
	// Ensure default editable folders are initialized (and legacy ungrouped items backfilled once) before listing.
	savedFolders := s.loadSavedInspirationFolders()
	docs, err := s.DB.ListDocs("inspiration", false)
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	srcFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("source")))
	folderFilter := strings.TrimSpace(r.URL.Query().Get("folder"))
	categoryFilter := strings.TrimSpace(r.URL.Query().Get("category"))
	var tagFilters []string
	seenTagFilter := map[string]bool{}
	addTagFilter := func(raw string) {
		clean := strings.TrimPrefix(strings.TrimSpace(raw), "#")
		if clean == "" {
			return
		}
		k := strings.ToLower(clean)
		if seenTagFilter[k] {
			return
		}
		seenTagFilter[k] = true
		tagFilters = append(tagFilters, clean)
	}
	if rawTags := strings.TrimSpace(r.URL.Query().Get("tags")); rawTags != "" {
		for _, part := range strings.Split(rawTags, ",") {
			addTagFilter(part)
		}
	}
	if rawSingle := strings.TrimSpace(r.URL.Query().Get("tag")); rawSingle != "" {
		addTagFilter(rawSingle)
	}

	folderCounts := map[string]int{}
	ungroupedCount := 0
	tagsSet := map[string]int{}
	catsSet := map[string]int{}
	totalCount := 0
	items := make([]inspirationItem, 0, len(docs))

	for _, d := range docs {
		var data inspirationData
		_ = json.Unmarshal(d.Data, &data)
		if data.Title == "" {
			data.Title = d.Name
		}
		data.Folder = strings.TrimSpace(data.Folder)
		totalCount++
		cat := inferInspirationCategory(data)
		catsSet[cat]++
		if data.Folder == "" {
			ungroupedCount++
		} else {
			folderCounts[data.Folder]++
		}

		matchesFolder := true
		if folderFilter == inspirationUngroupedToken {
			matchesFolder = data.Folder == ""
		} else if folderFilter != "" {
			matchesFolder = data.Folder == folderFilter
		}
		if matchesFolder {
			for _, t := range data.Tags {
				if clean := strings.TrimSpace(t); clean != "" {
					tagsSet[clean]++
				}
			}
		}

		if srcFilter != "" && srcFilter != "all" {
			if srcFilter == "web_clip" {
				if data.Source != "x" && data.Source != "chrome" && data.Source != "web" {
					continue
				}
			} else if strings.ToLower(data.Source) != srcFilter {
				continue
			}
		}
		if !matchesFolder {
			continue
		}
		if categoryFilter != "" && categoryFilter != "all" && cat != categoryFilter {
			continue
		}
		if len(tagFilters) > 0 {
			allMatched := true
			for _, want := range tagFilters {
				found := false
				for _, t := range data.Tags {
					if strings.EqualFold(strings.TrimSpace(t), want) {
						found = true
						break
					}
				}
				if !found {
					allMatched = false
					break
				}
			}
			if !allMatched {
				continue
			}
		}
		if q != "" {
			hay := strings.ToLower(strings.Join([]string{
				data.Title, data.Prompt, data.PromptZh, data.RawText, data.Notes,
				data.SourceAuthor, data.SuggestedStyle, data.Folder, cat, strings.Join(data.Tags, " "),
			}, " "))
			if !strings.Contains(hay, q) {
				continue
			}
		}
		it := inspirationItem{
			ID:              d.ID,
			Name:            d.Name,
			UpdatedAt:       d.UpdatedAt,
			Category:        cat,
			inspirationData: data,
		}
		if data.RunID != "" {
			if linkedRun, rErr := s.DB.GetRun(data.RunID); rErr == nil {
				it.RunPublishedWorkID = linkedRun.PublishedWorkID
				it.RunPublishedURL = linkedRun.PublishedURL
				it.RunIsSkill = !isDirectPromptRun(linkedRun, s.resolveRunRecipe(linkedRun, nil))
				if len(it.RefSpecs) == 0 {
					it.RefSpecs = extractRunRefMeta(linkedRun)
				}
			}
		}
		items = append(items, it)
	}

	type folderCount struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	folderSeen := map[string]bool{}
	folderItems := make([]folderCount, 0, len(savedFolders)+len(folderCounts))
	folders := make([]string, 0, len(savedFolders)+len(folderCounts))
	for _, f := range savedFolders {
		folderSeen[f] = true
		folderItems = append(folderItems, folderCount{Name: f, Count: folderCounts[f]})
		folders = append(folders, f)
	}
	var extraFolders []string
	for f := range folderCounts {
		if !folderSeen[f] {
			extraFolders = append(extraFolders, f)
		}
	}
	sort.Strings(extraFolders)
	for _, f := range extraFolders {
		folderItems = append(folderItems, folderCount{Name: f, Count: folderCounts[f]})
		folders = append(folders, f)
	}

	type categoryCount struct {
		Category string `json:"category"`
		Count    int    `json:"count"`
	}
	categories := make([]categoryCount, 0, len(catsSet))
	for _, rule := range inspirationCategoryRules {
		if c := catsSet[rule.Name]; c > 0 {
			categories = append(categories, categoryCount{Category: rule.Name, Count: c})
		}
	}
	if c := catsSet["其他灵感"]; c > 0 {
		categories = append(categories, categoryCount{Category: "其他灵感", Count: c})
	}

	type tagCount struct {
		Tag   string `json:"tag"`
		Count int    `json:"count"`
	}
	var tags []tagCount
	for t, c := range tagsSet {
		tags = append(tags, tagCount{Tag: t, Count: c})
	}
	sort.Slice(tags, func(i, j int) bool {
		if tags[i].Count != tags[j].Count {
			return tags[i].Count > tags[j].Count
		}
		return tags[i].Tag < tags[j].Tag
	})

	clipEp := strings.TrimRight(s.Addr(), "/")
	clipExtDir, clipExtExists := s.EnsureClipperExtension()
	return map[string]any{
		"ok":                  true,
		"items":               items,
		"totalCount":          totalCount,
		"ungroupedCount":      ungroupedCount,
		"folderItems":         folderItems,
		"categories":          categories,
		"folders":             folders,
		"tags":                tags,
		"clipToken":           settings.EnsureClipToken(),
		"clipEndpoint":        clipEp,
		"clipExtensionDir":    clipExtDir,
		"clipExtensionExists": clipExtExists,
		"siteBase":            s.Site.Base(),
	}, nil
}

func (s *Server) inspirationsFolderCreate(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	name, err := cleanInspirationFolderName(body.Name)
	if err != nil {
		return nil, err
	}
	existing := s.loadSavedInspirationFolders()
	for _, f := range existing {
		if f == name {
			return nil, bad("分组「" + name + "」已存在")
		}
	}
	saved, err := s.saveInspirationFolders(append(existing, name))
	if err != nil {
		return nil, err
	}
	s.Emit("inspirations", map[string]any{"updated": true, "folders": true})
	return map[string]any{"ok": true, "name": name, "folders": saved}, nil
}

func (s *Server) inspirationsFolderRename(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		OldName string `json:"oldName"`
		NewName string `json:"newName"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	oldName := strings.TrimSpace(body.OldName)
	if oldName == "" {
		return nil, bad("缺少原分组名称")
	}
	newName, err := cleanInspirationFolderName(body.NewName)
	if err != nil {
		return nil, err
	}
	existing := s.loadSavedInspirationFolders()
	if oldName != newName {
		for _, f := range existing {
			if f == newName {
				return nil, bad("分组「" + newName + "」已存在")
			}
		}
	}
	replaced := false
	next := make([]string, 0, len(existing)+1)
	for _, f := range existing {
		if f == oldName {
			next = append(next, newName)
			replaced = true
		} else {
			next = append(next, f)
		}
	}
	if !replaced {
		next = append(next, newName)
	}
	saved, err := s.saveInspirationFolders(next)
	if err != nil {
		return nil, err
	}

	docs, err := s.DB.ListDocs("inspiration", false)
	if err != nil {
		return nil, err
	}
	updatedCount := 0
	for _, d := range docs {
		var data inspirationData
		_ = json.Unmarshal(d.Data, &data)
		if strings.TrimSpace(data.Folder) == oldName {
			data.Folder = newName
			if _, sErr := s.saveInspiration(d.ID, data); sErr == nil {
				updatedCount++
			}
		}
	}
	s.Emit("inspirations", map[string]any{"updated": true, "folders": true})
	return map[string]any{
		"ok":           true,
		"oldName":      oldName,
		"newName":      newName,
		"updatedCount": updatedCount,
		"folders":      saved,
	}, nil
}

func (s *Server) inspirationsFolderDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" && r.Body != nil {
		var body struct {
			Name string `json:"name"`
		}
		_ = decode(r, &body)
		name = strings.TrimSpace(body.Name)
	}
	if name == "" {
		return nil, bad("缺少要删除的分组名称")
	}
	existing := s.loadSavedInspirationFolders()
	next := make([]string, 0, len(existing))
	for _, f := range existing {
		if f != name {
			next = append(next, f)
		}
	}
	saved, err := s.saveInspirationFolders(next)
	if err != nil {
		return nil, err
	}

	docs, err := s.DB.ListDocs("inspiration", false)
	if err != nil {
		return nil, err
	}
	moved := 0
	for _, d := range docs {
		var data inspirationData
		_ = json.Unmarshal(d.Data, &data)
		if strings.TrimSpace(data.Folder) == name {
			data.Folder = ""
			if _, sErr := s.saveInspiration(d.ID, data); sErr == nil {
				moved++
			}
		}
	}
	s.Emit("inspirations", map[string]any{"updated": true, "folders": true})
	return map[string]any{
		"ok":               true,
		"name":             name,
		"movedToUngrouped": moved,
		"folders":          saved,
	}, nil
}

func (s *Server) inspirationsBatchFolder(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		IDs    []string `json:"ids"`
		Folder string   `json:"folder"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.IDs) == 0 {
		return nil, bad("请先选择至少一条灵感")
	}
	targetFolder := strings.TrimSpace(body.Folder)
	if targetFolder == inspirationUngroupedToken {
		targetFolder = ""
	}
	if targetFolder != "" {
		clean, err := cleanInspirationFolderName(targetFolder)
		if err != nil {
			return nil, err
		}
		targetFolder = clean
		s.ensureInspirationFolder(targetFolder)
	}

	updatedCount := 0
	for _, rawID := range body.IDs {
		id := strings.TrimSpace(rawID)
		if id == "" {
			continue
		}
		cur, err := s.readInspiration(id)
		if err != nil {
			continue
		}
		d := cur.inspirationData
		d.Folder = targetFolder
		if _, err := s.saveInspiration(id, d); err == nil {
			updatedCount++
		}
	}
	s.Emit("inspirations", map[string]any{"updated": true, "folders": true})
	return map[string]any{
		"ok":           true,
		"folder":       targetFolder,
		"updatedCount": updatedCount,
	}, nil
}

func resolveClipperExtensionDirFrom(exePath, wd, dataDir string) (string, bool) {
	seen := map[string]struct{}{}
	var candidates []string
	addCand := func(parts ...string) {
		p := filepath.Clean(filepath.Join(parts...))
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		if _, ok := seen[p]; ok {
			return
		}
		seen[p] = struct{}{}
		candidates = append(candidates, p)
	}

	var exeDir string
	if strings.TrimSpace(exePath) != "" {
		if resolved, err := filepath.EvalSymlinks(exePath); err == nil && resolved != "" {
			exePath = resolved
		}
		exeDir = filepath.Dir(exePath)
		// 1. Packaged release: extensions/handraw-clipper alongside executable
		addCand(exeDir, "extensions", "handraw-clipper")
		// 2. macOS .app bundle: Contents/MacOS/handraw -> Contents/Resources/extensions/handraw-clipper
		addCand(exeDir, "..", "Resources", "extensions", "handraw-clipper")
		// 3. Dev build inside dist/: <repo>/dist/handraw.exe -> <repo>/extensions/handraw-clipper
		addCand(exeDir, "..", "extensions", "handraw-clipper")
	}
	if strings.TrimSpace(wd) != "" {
		addCand(wd, "extensions", "handraw-clipper")
		addCand(wd, "..", "extensions", "handraw-clipper")
	}
	if strings.TrimSpace(dataDir) != "" {
		addCand(dataDir, "extensions", "handraw-clipper")
	}

	for _, c := range candidates {
		if fi, err := os.Stat(filepath.Join(c, "manifest.json")); err == nil && !fi.IsDir() {
			return c, true
		}
	}
	if exeDir != "" {
		p := filepath.Join(exeDir, "extensions", "handraw-clipper")
		if abs, err := filepath.Abs(p); err == nil {
			return abs, false
		}
		return filepath.Clean(p), false
	}
	if len(candidates) > 0 {
		return candidates[0], false
	}
	return filepath.Join("extensions", "handraw-clipper"), false
}

func resolveClipperExtensionDir() (string, bool) {
	exe, _ := os.Executable()
	wd, _ := os.Getwd()
	return resolveClipperExtensionDirFrom(exe, wd, appdir.Root())
}

func (s *Server) clipBaseURL() string {
	ep := strings.TrimRight(strings.TrimSpace(s.Addr()), "/")
	if ep == "" {
		return fmt.Sprintf("http://127.0.0.1:%d", DefaultPort)
	}
	return ep
}

// EnsureClipperExtension materializes the embedded handraw-clipper Chrome/Edge
// extension into the user's data directory and writes pre-paired defaults.json
// so single-binary users never have to find files or paste tokens manually (#185).
func (s *Server) EnsureClipperExtension() (string, bool) {
	dst := filepath.Join(appdir.Root(), "extensions", "handraw-clipper")
	if abs, err := filepath.Abs(dst); err == nil {
		dst = abs
	}
	defs := extensions.ClipperDefaults{
		ClientURL: s.clipBaseURL(),
		ClipToken: settings.EnsureClipToken(),
		SiteBase:  settings.Get().SiteBase,
	}
	if err := extensions.EnsureClipper(dst, defs); err == nil {
		return dst, true
	}
	return resolveClipperExtensionDir()
}

func (s *Server) inspirationsFetchURL(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		URL string `json:"url"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	ext, err := s.extractInspirationFromURL(r.Context(), body.URL)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "extracted": ext}, nil
}

func (s *Server) inspirationsCreate(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Title          string            `json:"title"`
		ImagePath      string            `json:"imagePath"`
		ImageDataURL   string            `json:"imageDataUrl"`
		ImageURL       string            `json:"imageUrl"`
		Prompt         string            `json:"prompt"`
		PromptZh       string            `json:"promptZh"`
		RawText        string            `json:"rawText"`
		Slots          []inspirationSlot `json:"slots"`
		Tags           []string          `json:"tags"`
		Folder         string            `json:"folder"`
		Notes          string            `json:"notes"`
		Source         string            `json:"source"`
		SourceURL      string            `json:"sourceUrl"`
		SourceAuthor   string            `json:"sourceAuthor"`
		RunID          string            `json:"runId"`
		WorkID         string            `json:"workId"`
		Recipe         map[string]any    `json:"recipe"`
		RefSpecs       []RunRefMeta      `json:"refSpecs"`
		SuggestedStyle string            `json:"suggestedStyle"`
		AutoOrganize   bool              `json:"autoOrganize"`
		SyncCollection bool              `json:"syncCollection"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}

	// If the caller pasted a bare URL instead of actual text, fetch real content via
	// the platform URL adapter registry so AI organize never hallucinates from a URL (#88).
	bareCandidate := ""
	if u, ok := isBareURL(body.RawText); ok && (strings.TrimSpace(body.Prompt) == "" || strings.TrimSpace(body.Prompt) == strings.TrimSpace(body.RawText)) {
		bareCandidate = u
	} else if u, ok := isBareURL(body.Prompt); ok && strings.TrimSpace(body.RawText) == "" {
		bareCandidate = u
	} else if strings.TrimSpace(body.RawText) == "" && strings.TrimSpace(body.Prompt) == "" && strings.TrimSpace(body.ImageDataURL) == "" && strings.TrimSpace(body.ImagePath) == "" {
		if u, ok := isBareURL(body.SourceURL); ok {
			bareCandidate = u
		}
	}
	if bareCandidate != "" {
		ext, err := s.extractInspirationFromURL(r.Context(), bareCandidate)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(ext.Text) == "" && len(ext.Images) == 0 {
			return nil, bad(firstStr(ext.Warning, "未能从该链接抓取到正文或配图，请改用「Chrome 灵感捕手」剪藏或手动粘贴内容"))
		}
		body.RawText = ext.Text
		body.Prompt = ext.Text
		body.SourceURL = firstStr(ext.SourceURL, bareCandidate)
		if strings.TrimSpace(body.SourceAuthor) == "" {
			body.SourceAuthor = ext.Author
		}
		if strings.TrimSpace(body.Title) == "" {
			body.Title = ext.Title
		}
		if ext.Platform != "" {
			body.Source = ext.Platform
		}
		if strings.TrimSpace(body.ImageURL) == "" && len(ext.Images) > 0 {
			body.ImageURL = ext.Images[0]
		}
	}

	if strings.TrimSpace(body.SourceURL) == "" {
		body.SourceURL = extractFirstNetworkURL(body.RawText, body.Prompt, body.Notes)
	}

	id := jobs.NewID("insp")
	imgPath := strings.TrimSpace(body.ImagePath)
	if imgPath != "" {
		imgPath = normalizeLocalRef(imgPath)
	}
	if imgPath == "" && strings.HasPrefix(strings.TrimSpace(body.ImageDataURL), "data:image/") {
		raw, err := decodeDataURL(body.ImageDataURL)
		if err != nil {
			return nil, bad("图片格式无效：" + err.Error())
		}
		saved, _, err := saveInspirationImageBytes(id, raw)
		if err != nil {
			return nil, err
		}
		imgPath = saved
	}
	imageWarning := ""
	if imgPath == "" && strings.HasPrefix(strings.TrimSpace(body.ImageURL), "http") {
		if raw, err := fetchRemoteImageBytes(r.Context(), body.ImageURL, body.SourceURL); err == nil && len(raw) > 0 {
			if saved, _, sErr := saveInspirationImageBytes(id, raw); sErr == nil {
				imgPath = saved
			}
		} else if err != nil {
			imageWarning = "远端图片下载到本地失败，已保留原图链接（可在详情页点击重新拉取）"
			if s.Telemetry != nil {
				s.Telemetry.ReportError(telemetry.ErrorReport{
					Category: "clip_image_fail",
					Severity: "warn",
					Source:   "backend",
					Route:    "POST /api/inspirations",
					Domain:   telemetry.SanitizeDomain(body.ImageURL),
					Message:  err.Error(),
				})
			}
		}
	}

	if imgPath == "" && strings.TrimSpace(body.ImageURL) == "" && strings.TrimSpace(body.Prompt) == "" && strings.TrimSpace(body.RawText) == "" {
		return nil, bad("请至少提供图片或提示词内容")
	}

	folderVal := strings.TrimSpace(body.Folder)
	if folderVal == inspirationUngroupedToken {
		folderVal = ""
	}
	if folderVal != "" {
		if clean, fErr := cleanInspirationFolderName(folderVal); fErr == nil {
			folderVal = clean
			s.ensureInspirationFolder(folderVal)
		}
	}
	refSpecs := body.RefSpecs
	if len(refSpecs) == 0 && strings.TrimSpace(body.RunID) != "" {
		if linkedRun, rErr := s.DB.GetRun(strings.TrimSpace(body.RunID)); rErr == nil {
			refSpecs = extractRunRefMeta(linkedRun)
		}
	}
	data := inspirationData{
		Title:          strings.TrimSpace(body.Title),
		ImagePath:      imgPath,
		ImageURL:       strings.TrimSpace(body.ImageURL),
		Prompt:         strings.TrimSpace(firstStr(body.Prompt, body.RawText)),
		PromptZh:       strings.TrimSpace(body.PromptZh),
		RawText:        strings.TrimSpace(body.RawText),
		Slots:          body.Slots,
		Tags:           normalizeInspirationTags(body.Tags),
		Folder:         folderVal,
		Notes:          strings.TrimSpace(body.Notes),
		Source:         firstStr(strings.TrimSpace(body.Source), "import"),
		SourceURL:      strings.TrimSpace(body.SourceURL),
		SourceAuthor:   strings.TrimSpace(body.SourceAuthor),
		RunID:          strings.TrimSpace(body.RunID),
		WorkID:         strings.TrimSpace(body.WorkID),
		Recipe:         body.Recipe,
		RefSpecs:       refSpecs,
		SuggestedStyle: strings.TrimSpace(body.SuggestedStyle),
	}
	item, err := s.saveInspiration(id, data)
	if err != nil {
		return nil, err
	}
	if body.SyncCollection && body.WorkID != "" && s.Site != nil && s.Site.LoggedIn() {
		_, _ = s.Site.Send(r.Context(), http.MethodPost, "/api/collections/toggle", map[string]any{
			"bucket":   "works",
			"targetId": body.WorkID,
			"action":   "set",
		})
	}
	if body.AutoOrganize && strings.TrimSpace(firstStr(item.RawText, item.Prompt)) != "" {
		if org, oErr := s.organizeInspirationItem(r.Context(), item); oErr == nil {
			item = org
		}
	}
	s.Emit("inspirations", map[string]any{"updated": true, "id": item.ID})
	resp := map[string]any{"ok": true, "item": item}
	if imageWarning != "" {
		resp["imageWarning"] = imageWarning
	}
	return resp, nil
}

func (s *Server) inspirationsPatch(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	cur, err := s.readInspiration(id)
	if err != nil {
		return nil, err
	}
	var body struct {
		Title          *string            `json:"title"`
		Prompt         *string            `json:"prompt"`
		PromptZh       *string            `json:"promptZh"`
		Notes          *string            `json:"notes"`
		Folder         *string            `json:"folder"`
		Tags           *[]string          `json:"tags"`
		Slots          *[]inspirationSlot `json:"slots"`
		SuggestedStyle *string            `json:"suggestedStyle"`
		SourceURL      *string            `json:"sourceUrl"`
		Recipe         map[string]any     `json:"recipe"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	d := cur.inspirationData
	if body.Title != nil {
		d.Title = strings.TrimSpace(*body.Title)
	}
	if body.Prompt != nil {
		d.Prompt = strings.TrimSpace(*body.Prompt)
	}
	if body.PromptZh != nil {
		d.PromptZh = strings.TrimSpace(*body.PromptZh)
	}
	if body.Notes != nil {
		d.Notes = strings.TrimSpace(*body.Notes)
	}
	if body.Folder != nil {
		fv := strings.TrimSpace(*body.Folder)
		if fv == inspirationUngroupedToken {
			fv = ""
		}
		if fv != "" {
			clean, fErr := cleanInspirationFolderName(fv)
			if fErr != nil {
				return nil, fErr
			}
			fv = clean
			s.ensureInspirationFolder(fv)
		}
		d.Folder = fv
	}
	if body.Tags != nil {
		d.Tags = normalizeInspirationTags(*body.Tags)
	}
	if body.Slots != nil {
		d.Slots = *body.Slots
	}
	if body.SuggestedStyle != nil {
		d.SuggestedStyle = strings.TrimSpace(*body.SuggestedStyle)
	}
	if body.SourceURL != nil {
		d.SourceURL = strings.TrimSpace(*body.SourceURL)
	}
	if body.Recipe != nil {
		d.Recipe = body.Recipe
	}
	item, err := s.saveInspiration(id, d)
	if err != nil {
		return nil, err
	}
	s.Emit("inspirations", map[string]any{"updated": true, "id": item.ID})
	return map[string]any{"ok": true, "item": item}, nil
}

// cleanupInspirationLocalImage removes a cached inspiration image ONLY when it
// resides inside <appdir>/library/inspirations/, never touching original files
// in the user's works directory (#195).
func cleanupInspirationLocalImage(imgPath string) {
	p := strings.TrimSpace(imgPath)
	if p == "" {
		return
	}
	baseDir, err1 := filepath.Abs(inspirationImageDir())
	absPath, err2 := filepath.Abs(p)
	if err1 != nil || err2 != nil {
		return
	}
	rel, err := filepath.Rel(baseDir, absPath)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return
	}
	_ = os.Remove(absPath)
}

func (s *Server) inspirationsDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if cur, err := s.readInspiration(id); err == nil {
		cleanupInspirationLocalImage(cur.ImagePath)
	}
	if err := s.DB.DeleteDocHard("inspiration", id); err != nil {
		return nil, err
	}
	s.Emit("inspirations", map[string]any{"updated": true, "deleted": id})
	return okv, nil
}

func (s *Server) inspirationsBatchDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.IDs) == 0 {
		return nil, bad("请先选择要删除的灵感")
	}
	seen := map[string]bool{}
	deleted := 0
	for _, rawID := range body.IDs {
		id := strings.TrimSpace(rawID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if cur, err := s.readInspiration(id); err == nil {
			cleanupInspirationLocalImage(cur.ImagePath)
		}
		if err := s.DB.DeleteDocHard("inspiration", id); err == nil {
			deleted++
		}
	}
	s.Emit("inspirations", map[string]any{"updated": true, "batchDeleted": deleted})
	return map[string]any{"ok": true, "deleted": deleted}, nil
}

func (s *Server) inspirationsClipPing(w http.ResponseWriter, r *http.Request) (any, error) {
	return map[string]any{
		"ok":       true,
		"app":      "handraw-client",
		"version":  s.Version,
		"loggedIn": s.Site != nil && s.Site.LoggedIn(),
	}, nil
}

func (s *Server) inspirationsClip(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Title         string   `json:"title"`
		ImageDataURL  string   `json:"imageDataUrl"`
		ImageURL      string   `json:"imageUrl"`
		RawText       string   `json:"rawText"`
		Text          string   `json:"text"`
		Prompt        string   `json:"prompt"`
		ReplyTexts    []string `json:"replyTexts"`
		SourceURL     string   `json:"sourceUrl"`
		SourceAuthor  string   `json:"sourceAuthor"`
		SourceChannel string   `json:"sourceChannel"`
		Tags          []string `json:"tags"`
		AutoOrganize  *bool    `json:"autoOrganize"`
		Truncated     bool     `json:"truncated"`
		LastClipError *struct {
			Channel string `json:"channel"`
			Reason  string `json:"reason"`
		} `json:"lastClipError,omitempty"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.LastClipError != nil && strings.TrimSpace(body.LastClipError.Reason) != "" && s.Telemetry != nil {
		s.Telemetry.ReportError(telemetry.ErrorReport{
			Category: "clipper_fail",
			Severity: "warn",
			Source:   "clipper",
			Route:    strings.ToLower(strings.TrimSpace(firstStr(body.LastClipError.Channel, "chrome"))),
			Message:  strings.TrimSpace(body.LastClipError.Reason),
		})
	}
	rawTxt := strings.TrimSpace(firstStr(body.RawText, body.Text))
	prm := strings.TrimSpace(firstStr(body.Prompt, rawTxt))
	if len(body.ReplyTexts) > 0 {
		var extra []string
		for _, rt := range body.ReplyTexts {
			c := strings.TrimSpace(rt)
			if c != "" && !strings.Contains(rawTxt, c) {
				extra = append(extra, c)
			}
		}
		if len(extra) > 0 {
			joined := strings.Join(extra, "\n\n")
			if rawTxt == "" {
				rawTxt = joined
			} else {
				rawTxt = "[主推文]\n" + rawTxt + "\n\n[作者评论区补充]\n" + joined
			}
			prm = rawTxt
		}
	}
	if strings.TrimSpace(body.SourceURL) == "" {
		body.SourceURL = extractFirstNetworkURL(rawTxt, prm)
	}

	// X timeline/list views truncate long Note Tweets (~140 CJK / ~250 ASCII chars)
	// behind a "Show more" / "显示更多" link. When clipped from X and truncated (or long
	// enough to be a collapsed Note Tweet), enrich via FxTwitter/VxTwitter so the full
	// prompt is captured automatically without manually expanding (#96).
	hasAuthorReplies := len(body.ReplyTexts) > 0 || strings.Contains(rawTxt, "[作者评论区补充]")
	if !hasAuthorReplies && isXStatusURL(body.SourceURL) && (body.Truncated || looksLikeTruncatedXClip(rawTxt)) {
		fetchCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		ext, err := s.extractInspirationFromURL(fetchCtx, strings.TrimSpace(body.SourceURL))
		cancel()
		if err == nil {
			extText := strings.TrimSpace(ext.Text)
			if len([]rune(extText)) > len([]rune(rawTxt)) {
				rawTxt = extText
				prm = extText
			}
			if strings.TrimSpace(body.ImageURL) == "" && strings.TrimSpace(body.ImageDataURL) == "" && len(ext.Images) > 0 {
				body.ImageURL = ext.Images[0]
			}
			if strings.TrimSpace(body.SourceAuthor) == "" && strings.TrimSpace(ext.Author) != "" {
				body.SourceAuthor = strings.TrimSpace(ext.Author)
			}
			if strings.TrimSpace(ext.SourceURL) != "" {
				body.SourceURL = strings.TrimSpace(ext.SourceURL)
			}
		}
	}

	if strings.TrimSpace(body.ImageDataURL) == "" && strings.TrimSpace(body.ImageURL) == "" && prm == "" {
		return nil, bad("剪藏内容至少需要包含图片或文字")
	}

	id := jobs.NewID("insp")
	imgPath := ""
	imageWarning := ""
	if strings.HasPrefix(strings.TrimSpace(body.ImageDataURL), "data:image/") {
		if raw, err := decodeDataURL(body.ImageDataURL); err == nil {
			if p, _, sErr := saveInspirationImageBytes(id, raw); sErr == nil {
				imgPath = p
			}
		}
	}
	if imgPath == "" && strings.HasPrefix(strings.TrimSpace(body.ImageURL), "http") {
		if raw, err := fetchRemoteImageBytes(r.Context(), body.ImageURL, body.SourceURL); err == nil {
			if p, _, sErr := saveInspirationImageBytes(id, raw); sErr == nil {
				imgPath = p
			}
		} else if err != nil {
			imageWarning = "远端图片暂未拉到本地，已保留原图链接（可在灵感详情页重试）"
			if s.Telemetry != nil {
				s.Telemetry.ReportError(telemetry.ErrorReport{
					Category: "clip_image_fail",
					Severity: "warn",
					Source:   "backend",
					Route:    "POST /api/inspirations/clip",
					Domain:   telemetry.SanitizeDomain(body.ImageURL),
					Message:  err.Error(),
				})
			}
		}
	}

	ch := strings.ToLower(strings.TrimSpace(body.SourceChannel))
	if ch == "" {
		if strings.Contains(strings.ToLower(body.SourceURL), "x.com") || strings.Contains(strings.ToLower(body.SourceURL), "twitter.com") {
			ch = "x"
		} else {
			ch = "chrome"
		}
	}
	data := inspirationData{
		Title:        strings.TrimSpace(body.Title),
		ImagePath:    imgPath,
		ImageURL:     strings.TrimSpace(body.ImageURL),
		Prompt:       prm,
		RawText:      rawTxt,
		Tags:         body.Tags,
		Source:       ch,
		SourceURL:    strings.TrimSpace(body.SourceURL),
		SourceAuthor: strings.TrimSpace(body.SourceAuthor),
	}
	item, err := s.saveInspiration(id, data)
	if err != nil {
		return nil, err
	}
	s.Emit("inspirations", map[string]any{"updated": true, "clipped": true, "id": item.ID, "title": item.Title})

	// Run AI organization in the background so the Chrome extension gets an instant response.
	shouldOrg := body.AutoOrganize == nil || *body.AutoOrganize
	if shouldOrg && strings.TrimSpace(firstStr(item.RawText, item.Prompt)) != "" {
		go func(it inspirationItem) {
			cctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			if org, err := s.organizeInspirationItem(cctx, it); err == nil {
				s.Emit("inspirations", map[string]any{"updated": true, "organized": true, "id": org.ID})
			}
		}(item)
	}
	resp := map[string]any{"ok": true, "item": item}
	if imageWarning != "" {
		resp["imageWarning"] = imageWarning
	}
	return resp, nil
}

// inspirationsRefetchImage downloads a clipped inspiration's remote image URL
// (or re-extracts it from SourceURL) and caches it locally on disk (#193).
func (s *Server) inspirationsRefetchImage(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	cur, err := s.readInspiration(id)
	if err != nil {
		return nil, err
	}
	targetURL := strings.TrimSpace(cur.ImageURL)
	if targetURL == "" && strings.HasPrefix(strings.TrimSpace(cur.SourceURL), "http") {
		if ext, eErr := s.extractInspirationFromURL(r.Context(), cur.SourceURL); eErr == nil && len(ext.Images) > 0 {
			targetURL = strings.TrimSpace(ext.Images[0])
		}
	}
	if targetURL == "" {
		return nil, bad("该灵感没有可重新拉取的图片地址")
	}
	raw, err := fetchRemoteImageBytes(r.Context(), targetURL, cur.SourceURL)
	if err != nil {
		return nil, bad("重新拉取图片失败：" + err.Error())
	}
	saved, _, err := saveInspirationImageBytes(id, raw)
	if err != nil {
		return nil, err
	}
	d := cur.inspirationData
	d.ImagePath = saved
	d.ImageURL = targetURL
	item, err := s.saveInspiration(id, d)
	if err != nil {
		return nil, err
	}
	s.Emit("inspirations", map[string]any{"updated": true, "id": item.ID})
	return map[string]any{"ok": true, "item": item}, nil
}

func (s *Server) organizeInspirationItem(ctx context.Context, item inspirationItem) (inspirationItem, error) {
	sourceText := strings.TrimSpace(firstStr(item.RawText, item.Prompt, item.Title))
	if sourceText == "" {
		return item, bad("没有可供 AI 整理的原文或提示词")
	}

	// Anti-hallucination guard: never send a bare URL to the LLM; resolve real content first (#88).
	if bareURL, ok := isBareURL(sourceText); ok {
		ext, err := s.extractInspirationFromURL(ctx, bareURL)
		if err != nil {
			return item, bad("原始内容仅为链接且抓取失败（" + err.Error() + "），已中止 AI 整理以避免编造内容")
		}
		if ext == nil || strings.TrimSpace(ext.Text) == "" {
			msg := "原始内容仅为链接且未能抓取到正文，已中止 AI 整理以避免编造内容；请改用「Chrome 灵感捕手」剪藏或手动粘贴正文"
			if ext != nil && strings.TrimSpace(ext.Warning) != "" {
				msg = ext.Warning
			}
			return item, bad(msg)
		}
		d := item.inspirationData
		d.RawText = ext.Text
		d.Prompt = ext.Text
		d.SourceURL = firstStr(ext.SourceURL, bareURL)
		if d.SourceAuthor == "" {
			d.SourceAuthor = ext.Author
		}
		if ext.Platform != "" {
			d.Source = ext.Platform
		}
		if d.ImagePath == "" && len(ext.Images) > 0 {
			d.ImageURL = ext.Images[0]
			if rawImg, dErr := fetchRemoteImageBytes(ctx, ext.Images[0]); dErr == nil && len(rawImg) > 0 {
				if saved, _, sErr := saveInspirationImageBytes(item.ID, rawImg); sErr == nil {
					d.ImagePath = saved
				}
			}
		}
		if updated, sErr := s.saveInspiration(item.ID, d); sErr == nil {
			item = updated
		}
		sourceText = strings.TrimSpace(ext.Text)
	}

	styleHint := ""
	if p := s.Pack(); p != nil && len(p.Styles) > 0 {
		snap := s.communityCatalog(ctx, false)
		overridden := map[string]bool{}
		for _, st := range snap.Styles {
			overridden[strings.ToUpper(strings.TrimSpace(st.Number))] = true
		}
		var sample []string
		for _, st := range p.Styles {
			if len(sample) >= 40 {
				break
			}
			if overridden[strings.ToUpper(strings.TrimSpace(st.Number))] {
				continue
			}
			sample = append(sample, st.Number+":"+firstStr(st.NameZh, st.GenerationName))
		}
		if len(sample) > 0 {
			styleHint = "\n部分可选手绘风画风编号参考：" + strings.Join(sample, " | ")
		}
	}

	existingFolders := s.loadSavedInspirationFolders()
	folderHint := ""
	if len(existingFolders) > 0 {
		folderHint = "\n用户现有自定义分组列表（仅当高度匹配时从以下名称中精确选 1 个填入 folder 字段，不确定请留空 \"\"，严禁自造新分组名）：" + strings.Join(existingFolders, "、")
	}

	sysPrompt := `你是手绘风「灵感库」的 AI 提示词整理专家。
用户会粘贴一段从 X (Twitter)、小红书或网页抓取的真实内容（可能含英文推文、emoji、话题标签、求赞废话、中英混杂的生图提示词；有时主推文只发了效果图和「提示词在评论区 / Prompt below 👇」等引导语，真正的提示词在【作者评论区补充】中）。
请严格忠实于原始内容（严禁凭空编造原文中不存在的场景或主体），若包含【作者评论区补充】，优先提取作者评论区中的完整生图提示词作为 prompt 并剥离主推文引导废话；输出合法 JSON（不要 markdown 代码块，不要解释文字），包含以下字段：
{
  "title": "不超过22字的精准中文灵感标题",
  "prompt": "剥离推文废话/emoji/hashtag后的纯净可执行生图提示词（若是英文提示词保留高质量英文；若本为中文保留高质量中文；尽量保留原文的 [变量] 或核心指令）",
  "promptZh": "自然易读的中文完整提示词版本（方便中文用户阅读与改写）",
  "slots": [
    {"key": "subject", "label": "主体", "defaultValue": "原提示词中的主体"},
    {"key": "scene", "label": "场景/氛围", "defaultValue": "原场景"}
  ],
  "folder": "",
  "tags": ["标签1", "标签2", "标签3"],
  "suggestedStyle": "仅当原提示词明确属于手绘/水彩/插画且高度匹配下方编号时才填写如 FA-002；若原提示词为 3D/写实摄影/电影/通用外部风格，请务必留空字符串 \"\""
}
要求：slots 提炼 1~4 个最值得用户「做同款」时替换的关键变量；tags 提炼 2~4 个简洁可复用的中文多维标签（如画风/题材/用途，2~5 字，不带#），避免造生僻词；folder 仅在提供了用户现有分组列表且高度匹配时填写精确分组名，否则留空字符串 ""。` + folderHint + styleHint

	userPrompt := fmt.Sprintf("来源：%s\n作者：%s\n原标题：%s\n原始内容：\n%s",
		firstStr(item.Source, "web"),
		firstStr(item.SourceAuthor, "未知"),
		firstStr(item.Title, "未命名"),
		sourceText,
	)

	var rawReply string
	var callErr error
	if s.Site != nil && s.Site.LoggedIn() {
		res, err := s.Site.AIChat(ctx, site.AIChatRequest{
			Capability:   "text",
			FeatureScope: "client_inspiration_organize",
			JSONMode:     true,
			Messages: []providers.ChatMessage{
				{Role: "system", Content: sysPrompt},
				{Role: "user", Content: userPrompt},
			},
		})
		rawReply, callErr = res.Content, err
	} else {
		// Fall back to configured third-party OpenAI text provider
		if tp, modelID, ok := findTextProviderFor("text"); !ok {
			return item, bad("请先登录手绘风账号，或在「设置 → 第三方接口」配置文本模型以使用 AI 整理")
		} else {
			rawReply, callErr = providers.Chat(ctx, tp, modelID, []providers.ChatMessage{
				{Role: "system", Content: sysPrompt},
				{Role: "user", Content: userPrompt},
			}, true)
		}
	}
	if callErr != nil {
		return item, callErr
	}

	cleaned := strings.TrimSpace(rawReply)
	cleaned = strings.TrimPrefix(cleaned, "```json")
	cleaned = strings.TrimPrefix(cleaned, "```")
	cleaned = strings.TrimSuffix(cleaned, "```")
	cleaned = strings.TrimSpace(cleaned)
	if start := strings.Index(cleaned, "{"); start >= 0 {
		if end := strings.LastIndex(cleaned, "}"); end > start {
			cleaned = cleaned[start : end+1]
		}
	}

	var parsed struct {
		Title          string            `json:"title"`
		Prompt         string            `json:"prompt"`
		PromptZh       string            `json:"promptZh"`
		Slots          []inspirationSlot `json:"slots"`
		Folder         string            `json:"folder"`
		Tags           []string          `json:"tags"`
		SuggestedStyle string            `json:"suggestedStyle"`
	}
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		return item, fmt.Errorf("AI 整理结果解析失败：%w", err)
	}

	d := item.inspirationData
	if strings.TrimSpace(parsed.Title) != "" {
		d.Title = strings.TrimSpace(parsed.Title)
	}
	if strings.TrimSpace(parsed.Prompt) != "" {
		d.Prompt = strings.TrimSpace(parsed.Prompt)
	}
	if strings.TrimSpace(parsed.PromptZh) != "" {
		d.PromptZh = strings.TrimSpace(parsed.PromptZh)
	}
	if len(parsed.Slots) > 0 {
		d.Slots = parsed.Slots
	}
	if len(parsed.Tags) > 0 {
		d.Tags = normalizeInspirationTags(parsed.Tags)
	}
	if d.Folder == "" && strings.TrimSpace(parsed.Folder) != "" && len(existingFolders) > 0 {
		want := strings.TrimSpace(parsed.Folder)
		for _, f := range existingFolders {
			if f == want {
				d.Folder = f
				break
			}
		}
	}
	if strings.TrimSpace(parsed.SuggestedStyle) != "" {
		d.SuggestedStyle = strings.TrimSpace(parsed.SuggestedStyle)
	}
	d.AIOrganized = true
	return s.saveInspiration(item.ID, d)
}

func (s *Server) inspirationsOrganize(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	cur, err := s.readInspiration(id)
	if err != nil {
		return nil, err
	}
	org, err := s.organizeInspirationItem(r.Context(), cur)
	if err != nil {
		return nil, bad(err.Error())
	}
	s.Emit("inspirations", map[string]any{"updated": true, "organized": true, "id": org.ID})
	return map[string]any{"ok": true, "item": org}, nil
}

func (s *Server) inspirationsPublish(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.Site == nil || !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	id := strings.TrimSpace(r.PathValue("id"))
	cur, err := s.readInspiration(id)
	if err != nil {
		return nil, err
	}
	var body struct {
		Title      string            `json:"title"`
		Prompt     string            `json:"prompt"`
		Notes      string            `json:"notes"`
		Price      int               `json:"price"`
		Tags       []string          `json:"tags"`
		SourceURL  string            `json:"sourceUrl"`
		Encoded    string            `json:"encoded"`
		RefEncoded map[string]string `json:"refEncoded"`
		Images     []string          `json:"images"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.Price < 1 || body.Price > 20 {
		return nil, bad("灵感提示词须设置 1~20 积分解锁，暂不支持免费分享")
	}

	// Single-channel mutual exclusion (#118):
	// 1. Handraw Skill works belong exclusively to Community Works (protects Skill prompts & prevents duplicates).
	// 2. Runs already published as Community Works cannot be republished to Community Inspirations.
	sourceRunID := ""
	publishRefs := cur.RefSpecs
	if cur.RunID != "" {
		if linkedRun, rErr := s.DB.GetRun(cur.RunID); rErr == nil {
			if !isDirectPromptRun(linkedRun, s.resolveRunRecipe(linkedRun, nil)) {
				return nil, bad("该图片使用手绘 Skill 配方生成，请前往画廊发布为「社区作品」，不可重复发布到灵感库")
			}
			if linkedRun.PublishedWorkID != "" {
				return nil, bad("该图片已发布为社区作品，同一张图片不可重复上架到灵感库")
			}
			sourceRunID = uuid.NewSHA1(uuid.NameSpaceURL, []byte("handraw-run:"+linkedRun.ID)).String()
			if len(publishRefs) == 0 {
				publishRefs = extractRunRefMeta(linkedRun)
			}
		}
	}

	title := firstStr(strings.TrimSpace(body.Title), cur.Title, "灵感分享")
	promptTxt := firstStr(strings.TrimSpace(body.Prompt), cur.Prompt, cur.PromptZh, cur.RawText)
	if promptTxt == "" {
		return nil, bad("分享灵感卡需要包含提示词")
	}
	tags := cur.Tags
	if len(body.Tags) > 0 {
		tags = body.Tags
	}

	imageDataOrURL := strings.TrimSpace(body.Encoded)
	imageSHA := ""
	if cur.ImagePath != "" {
		if encodedURL, _, sErr := shareImage(store.Image{Path: cur.ImagePath}, imageDataOrURL); sErr == nil && encodedURL != "" {
			imageDataOrURL = encodedURL
			if idx := strings.Index(encodedURL, ","); idx > 0 {
				if rawBytes, dErr := base64.StdEncoding.DecodeString(encodedURL[idx+1:]); dErr == nil {
					sum := sha256.Sum256(rawBytes)
					imageSHA = hex.EncodeToString(sum[:])
				}
			}
		} else if imageDataOrURL == "" {
			return nil, bad("读取或压缩本地灵感图失败：" + sErr.Error())
		}
	} else if imageDataOrURL == "" && cur.ImageURL != "" {
		imageDataOrURL = cur.ImageURL
	}
	if imageDataOrURL == "" {
		return nil, bad("分享灵感卡需要至少一张图片")
	}

	sourceURL := firstStr(strings.TrimSpace(body.SourceURL), cur.SourceURL, extractFirstNetworkURL(cur.RawText, cur.Prompt))
	payload := map[string]any{
		"title":          title,
		"prompt":         promptTxt,
		"promptZh":       cur.PromptZh,
		"slots":          cur.Slots,
		"tags":           tags,
		"recipe":         cur.Recipe,
		"suggestedStyle": cur.SuggestedStyle,
		"sourceUrl":      sourceURL,
		"sourceAuthor":   cur.SourceAuthor,
		"sourceChannel":  firstStr(cur.Source, "client"),
		"notes":          firstStr(strings.TrimSpace(body.Notes), cur.Notes),
		"price":          body.Price,
		"imageUrl":       imageDataOrURL,
		"imageSha256":    imageSHA,
	}
	if sourceRunID != "" {
		payload["sourceRunId"] = sourceRunID
	}
	if len(publishRefs) > 0 {
		refSpecs, rErr := s.preparePublishRefSpecs(r.Context(), publishRefs, body.RefEncoded)
		if rErr != nil {
			return nil, bad(rErr.Error())
		}
		if len(refSpecs) > 0 {
			payload["refSpecs"] = refSpecs
		}
	}
	if len(body.Images) > 0 {
		payload["images"] = body.Images
	}
	rawResp, err := s.Site.Send(r.Context(), http.MethodPost, "/api/inspirations", payload)
	if err != nil {
		return nil, err
	}
	var resp map[string]any
	_ = json.Unmarshal(rawResp, &resp)

	pubID, _ := resp["id"].(string)
	pubURL, _ := resp["url"].(string)
	if strings.HasPrefix(pubURL, "/") {
		pubURL = strings.TrimRight(s.Site.Base(), "/") + pubURL
	}
	d := cur.inspirationData
	d.Title = title
	d.Prompt = promptTxt
	d.Tags = tags
	d.Notes = firstStr(strings.TrimSpace(body.Notes), cur.Notes)
	if sourceURL != "" {
		d.SourceURL = sourceURL
	}
	d.PublishedID = pubID
	d.PublishedURL = pubURL
	d.PublishedPrice = body.Price
	updated, _ := s.saveInspiration(id, d)
	if cur.RunID != "" && pubID != "" {
		_ = s.DB.UpdateRun(cur.RunID, map[string]any{
			"published_inspiration_id":  pubID,
			"published_inspiration_url": pubURL,
		})
		_ = jobs.WriteRunJSON(s.DB, cur.RunID)
		s.Emit("work_published", map[string]any{"runId": cur.RunID, "inspirationId": pubID, "url": pubURL, "price": body.Price})
	}
	s.Emit("inspirations", map[string]any{"updated": true, "published": true, "id": id})
	s.Emit("balance", map[string]any{"refresh": true})
	resp["item"] = updated
	resp["fullUrl"] = pubURL
	return resp, nil
}

func (s *Server) clipTokenRotate(w http.ResponseWriter, r *http.Request) (any, error) {
	tok, err := settings.RotateClipToken()
	if err != nil {
		return nil, err
	}
	dir, exists := s.EnsureClipperExtension()
	return map[string]any{
		"ok":                  true,
		"clipToken":           tok,
		"clipExtensionDir":    dir,
		"clipExtensionExists": exists,
	}, nil
}

func (s *Server) clipperPrepare(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		OpenFolder bool `json:"openFolder"`
	}
	_ = decode(r, &body)
	dir, exists := s.EnsureClipperExtension()
	if !exists {
		return nil, bad("无法释放内置浏览器扩展目录")
	}
	opened := false
	if body.OpenFolder && s.Host != nil {
		if err := s.Host.OpenPath(dir); err == nil {
			opened = true
		}
	}
	return map[string]any{
		"ok":                  true,
		"clipExtensionDir":    dir,
		"clipExtensionExists": exists,
		"clipToken":           settings.EnsureClipToken(),
		"clipEndpoint":        s.clipBaseURL(),
		"prePaired":           true,
		"opened":              opened,
	}, nil
}

func (s *Server) siteGetOptionalAuth(ctx context.Context, path string) (json.RawMessage, error) {
	if s.Site == nil {
		return nil, bad("未初始化网站客户端")
	}
	if s.Site.LoggedIn() {
		return s.Site.Send(ctx, http.MethodGet, path, nil)
	}
	return s.Site.GetPublic(ctx, path)
}

func (s *Server) siteWorkDetail(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return nil, bad("缺少作品 ID")
	}
	raw, err := s.siteGetOptionalAuth(r.Context(), "/api/works/"+url.PathEscape(id))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	out["siteBase"] = s.Site.Base()
	return out, nil
}

func (s *Server) siteWorkUnlock(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.Site == nil || !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return nil, bad("缺少作品 ID")
	}
	raw, err := s.Site.Send(r.Context(), http.MethodPost, "/api/unlocks", map[string]any{
		"targetType": "work",
		"targetId":   id,
	})
	if err != nil {
		return nil, err
	}
	s.Emit("balance", map[string]any{"refresh": true})
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	out["siteBase"] = s.Site.Base()
	return out, nil
}

func (s *Server) siteInspirationsFeed(w http.ResponseWriter, r *http.Request) (any, error) {
	qs := r.URL.Query().Encode()
	ep := "/api/inspirations/feed"
	if qs != "" {
		ep += "?" + qs
	}
	raw, err := s.siteGetOptionalAuth(r.Context(), ep)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	out["siteBase"] = s.Site.Base()
	return out, nil
}

func (s *Server) siteInspirationDetail(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	raw, err := s.siteGetOptionalAuth(r.Context(), "/api/inspirations/"+url.PathEscape(id))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	out["siteBase"] = s.Site.Base()
	return out, nil
}

func (s *Server) siteInspirationUnlock(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.Site == nil || !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	id := strings.TrimSpace(r.PathValue("id"))
	raw, err := s.Site.Send(r.Context(), http.MethodPost, "/api/inspirations/"+url.PathEscape(id)+"/unlock", map[string]any{})
	if err != nil {
		return nil, err
	}
	s.Emit("balance", map[string]any{"refresh": true})
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	out["siteBase"] = s.Site.Base()
	return out, nil
}

func (s *Server) siteInspirationCommentsList(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return nil, bad("缺少灵感 ID")
	}
	qs := r.URL.Query().Encode()
	ep := "/api/inspirations/" + url.PathEscape(id) + "/comments"
	if qs != "" {
		ep += "?" + qs
	}
	raw, err := s.siteGetOptionalAuth(r.Context(), ep)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	out["siteBase"] = s.Site.Base()
	return out, nil
}

func (s *Server) siteInspirationCommentCreate(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.Site == nil || !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		return nil, bad("缺少灵感 ID")
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	body.Text = strings.TrimSpace(body.Text)
	if body.Text == "" {
		return nil, bad("请输入评论内容")
	}
	raw, err := s.Site.Send(r.Context(), http.MethodPost, "/api/inspirations/"+url.PathEscape(id)+"/comments", map[string]any{
		"text": body.Text,
	})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{}
	}
	out["siteBase"] = s.Site.Base()
	return out, nil
}

func (s *Server) siteCollectionsToggle(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.Site == nil || !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	var body map[string]any
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	raw, err := s.Site.Send(r.Context(), http.MethodPost, "/api/collections/toggle", body)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func isXStatusURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u == nil {
		return false
	}
	return (xPlatformAdapter{}).Match(u) && reXStatusPath.MatchString(u.Path)
}

func looksLikeTruncatedXClip(text string) bool {
	s := strings.TrimSpace(text)
	if s == "" {
		return true
	}
	if strings.HasSuffix(s, "…") || strings.HasSuffix(s, "...") ||
		strings.HasSuffix(s, "显示更多") || strings.HasSuffix(strings.ToLower(s), "show more") {
		return true
	}
	// X weights CJK/non-ASCII runes as 2 chars and truncates timeline previews around
	// 250-280 weighted chars (~125-140 CJK chars). Enrich anything at or above 220.
	weighted := 0
	for _, r := range s {
		if r > 0x7f {
			weighted += 2
		} else {
			weighted++
		}
	}
	return weighted >= 220
}

var reNetworkURL = regexp.MustCompile(`https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+`)

func extractFirstNetworkURL(texts ...string) string {
	fallbackImg := ""
	for _, raw := range texts {
		for _, m := range reNetworkURL.FindAllString(raw, 8) {
			cleaned := strings.TrimRight(m, ".,;:!?)]}，。；：！？）》】'\"")
			u, err := url.Parse(cleaned)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				continue
			}
			lowerPath := strings.ToLower(u.Path)
			isImg := strings.HasSuffix(lowerPath, ".png") || strings.HasSuffix(lowerPath, ".jpg") ||
				strings.HasSuffix(lowerPath, ".jpeg") || strings.HasSuffix(lowerPath, ".webp") ||
				strings.HasSuffix(lowerPath, ".gif") || strings.HasSuffix(lowerPath, ".avif")
			if isImg {
				if fallbackImg == "" {
					fallbackImg = cleaned
				}
				continue
			}
			return cleaned
		}
	}
	return ""
}

func (s *Server) siteCreatorEarnings(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.Site == nil || !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	raw, err := s.Site.Send(r.Context(), http.MethodGet, "/api/me/creator-earnings", nil)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}
