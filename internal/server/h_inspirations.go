package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
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
	SuggestedStyle string            `json:"suggestedStyle,omitempty"`
	AIOrganized    bool              `json:"aiOrganized,omitempty"`
	CreatedAt      string            `json:"createdAt,omitempty"`
}

type inspirationItem struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	UpdatedAt string `json:"updatedAt"`
	inspirationData
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

func fetchRemoteImageBytes(ctx context.Context, rawURL string) ([]byte, error) {
	rawURL = strings.TrimSpace(rawURL)
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return nil, fmt.Errorf("不支持的图片链接")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 HandrawClient/1.0")
	hc := &http.Client{Timeout: 20 * time.Second}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("下载图片失败 (HTTP %d)", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 12<<20))
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
			if rawImg, dErr := fetchRemoteImageBytes(ctx, imgURL); dErr == nil && len(rawImg) > 0 {
				if p, _, sErr := saveInspirationImageBytes(cl.ID, rawImg); sErr == nil {
					imgPath = p
				}
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
		cctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		_ = s.pullCloudClipsBestEffort(cctx)
		cancel()
	}
	docs, err := s.DB.ListDocs("inspiration", false)
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	srcFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("source")))
	folderFilter := strings.TrimSpace(r.URL.Query().Get("folder"))
	tagFilter := strings.TrimPrefix(strings.TrimSpace(r.URL.Query().Get("tag")), "#")

	foldersSet := map[string]bool{}
	tagsSet := map[string]int{}
	items := make([]inspirationItem, 0, len(docs))

	for _, d := range docs {
		var data inspirationData
		_ = json.Unmarshal(d.Data, &data)
		if data.Title == "" {
			data.Title = d.Name
		}
		if data.Folder != "" {
			foldersSet[data.Folder] = true
		}
		for _, t := range data.Tags {
			if strings.TrimSpace(t) != "" {
				tagsSet[strings.TrimSpace(t)]++
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
		if folderFilter != "" && data.Folder != folderFilter {
			continue
		}
		if tagFilter != "" {
			matched := false
			for _, t := range data.Tags {
				if strings.EqualFold(t, tagFilter) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		if q != "" {
			hay := strings.ToLower(strings.Join([]string{
				data.Title, data.Prompt, data.PromptZh, data.RawText, data.Notes,
				data.SourceAuthor, data.SuggestedStyle, strings.Join(data.Tags, " "),
			}, " "))
			if !strings.Contains(hay, q) {
				continue
			}
		}
		items = append(items, inspirationItem{
			ID:              d.ID,
			Name:            d.Name,
			UpdatedAt:       d.UpdatedAt,
			inspirationData: data,
		})
	}

	folders := make([]string, 0, len(foldersSet))
	for f := range foldersSet {
		folders = append(folders, f)
	}
	sort.Strings(folders)

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

	clipEp := ""
	if s.Addr() != "" {
		clipEp = strings.TrimRight(s.Addr(), "/") + "/api/inspirations/clip"
	}
	return map[string]any{
		"ok":           true,
		"items":        items,
		"folders":      folders,
		"tags":         tags,
		"clipToken":    settings.EnsureClipToken(),
		"clipEndpoint": clipEp,
		"siteBase":     s.Site.Base(),
	}, nil
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
		SuggestedStyle string            `json:"suggestedStyle"`
		AutoOrganize   bool              `json:"autoOrganize"`
		SyncCollection bool              `json:"syncCollection"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
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
	if imgPath == "" && strings.HasPrefix(strings.TrimSpace(body.ImageURL), "http") {
		if raw, err := fetchRemoteImageBytes(r.Context(), body.ImageURL); err == nil && len(raw) > 0 {
			if saved, _, sErr := saveInspirationImageBytes(id, raw); sErr == nil {
				imgPath = saved
			}
		}
	}

	if imgPath == "" && strings.TrimSpace(body.ImageURL) == "" && strings.TrimSpace(body.Prompt) == "" && strings.TrimSpace(body.RawText) == "" {
		return nil, bad("请至少提供图片或提示词内容")
	}

	data := inspirationData{
		Title:          strings.TrimSpace(body.Title),
		ImagePath:      imgPath,
		ImageURL:       strings.TrimSpace(body.ImageURL),
		Prompt:         strings.TrimSpace(firstStr(body.Prompt, body.RawText)),
		PromptZh:       strings.TrimSpace(body.PromptZh),
		RawText:        strings.TrimSpace(body.RawText),
		Slots:          body.Slots,
		Tags:           body.Tags,
		Folder:         strings.TrimSpace(body.Folder),
		Notes:          strings.TrimSpace(body.Notes),
		Source:         firstStr(strings.TrimSpace(body.Source), "import"),
		SourceURL:      strings.TrimSpace(body.SourceURL),
		SourceAuthor:   strings.TrimSpace(body.SourceAuthor),
		RunID:          strings.TrimSpace(body.RunID),
		WorkID:         strings.TrimSpace(body.WorkID),
		Recipe:         body.Recipe,
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
	return map[string]any{"ok": true, "item": item}, nil
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
		d.Folder = strings.TrimSpace(*body.Folder)
	}
	if body.Tags != nil {
		d.Tags = *body.Tags
	}
	if body.Slots != nil {
		d.Slots = *body.Slots
	}
	if body.SuggestedStyle != nil {
		d.SuggestedStyle = strings.TrimSpace(*body.SuggestedStyle)
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

func (s *Server) inspirationsDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if err := s.DB.DeleteDocHard("inspiration", id); err != nil {
		return nil, err
	}
	s.Emit("inspirations", map[string]any{"updated": true, "deleted": id})
	return okv, nil
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
		SourceURL     string   `json:"sourceUrl"`
		SourceAuthor  string   `json:"sourceAuthor"`
		SourceChannel string   `json:"sourceChannel"`
		Tags          []string `json:"tags"`
		AutoOrganize  *bool    `json:"autoOrganize"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	rawTxt := strings.TrimSpace(firstStr(body.RawText, body.Text))
	prm := strings.TrimSpace(firstStr(body.Prompt, rawTxt))
	if strings.TrimSpace(body.ImageDataURL) == "" && strings.TrimSpace(body.ImageURL) == "" && prm == "" {
		return nil, bad("剪藏内容至少需要包含图片或文字")
	}

	id := jobs.NewID("insp")
	imgPath := ""
	if strings.HasPrefix(strings.TrimSpace(body.ImageDataURL), "data:image/") {
		if raw, err := decodeDataURL(body.ImageDataURL); err == nil {
			if p, _, sErr := saveInspirationImageBytes(id, raw); sErr == nil {
				imgPath = p
			}
		}
	} else if strings.HasPrefix(strings.TrimSpace(body.ImageURL), "http") {
		if raw, err := fetchRemoteImageBytes(r.Context(), body.ImageURL); err == nil {
			if p, _, sErr := saveInspirationImageBytes(id, raw); sErr == nil {
				imgPath = p
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
	return map[string]any{"ok": true, "item": item}, nil
}

func (s *Server) organizeInspirationItem(ctx context.Context, item inspirationItem) (inspirationItem, error) {
	sourceText := strings.TrimSpace(firstStr(item.RawText, item.Prompt, item.Title))
	if sourceText == "" {
		return item, bad("没有可供 AI 整理的原文或提示词")
	}

	styleHint := ""
	if p := s.Pack(); p != nil && len(p.Styles) > 0 {
		var sample []string
		for i, st := range p.Styles {
			if i >= 40 {
				break
			}
			sample = append(sample, st.Number+":"+firstStr(st.NameZh, st.GenerationName))
		}
		styleHint = "\n部分可选手绘风画风编号参考：" + strings.Join(sample, " | ")
	}

	sysPrompt := `你是手绘风「灵感库」的 AI 提示词整理专家。
用户会粘贴一段从 X (Twitter)、小红书或网页抓取的杂乱内容（可能含英文推文、emoji、话题标签、求赞废话、中英混杂的生图提示词）。
请严格输出合法 JSON（不要 markdown 代码块，不要解释文字），包含以下字段：
{
  "title": "不超过22字的精准中文灵感标题",
  "prompt": "剥离推文废话/emoji/hashtag后的纯净可执行生图提示词（若是英文提示词保留高质量英文；若本为中文保留高质量中文）",
  "promptZh": "自然易读的中文完整提示词版本（方便中文用户阅读与改写）",
  "slots": [
    {"key": "subject", "label": "主体", "defaultValue": "原提示词中的主体"},
    {"key": "scene", "label": "场景/氛围", "defaultValue": "原场景"}
  ],
  "tags": ["标签1", "标签2", "标签3"],
  "suggestedStyle": "如果与手绘风库中某个编号相近则填编号如 FA-013，否则留空"
}
要求：slots 提炼 1~4 个最值得用户「做同款」时替换的关键变量；tags 给 3~5 个简洁中文标签（不带#）。` + styleHint

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
		st := settings.Get()
		var tp settings.Provider
		var modelID string
		for _, p := range st.Providers {
			if p.Enabled && (p.Purpose == "text" || p.Purpose == "vision") && len(p.Models) > 0 {
				tp = p
				modelID = p.Models[0].ID
				break
			}
		}
		if tp.ID == "" {
			return item, bad("请先登录手绘风账号，或在「设置 → 第三方接口」配置文本模型以使用 AI 整理")
		}
		rawReply, callErr = providers.Chat(ctx, tp, modelID, []providers.ChatMessage{
			{Role: "system", Content: sysPrompt},
			{Role: "user", Content: userPrompt},
		}, true)
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
		d.Tags = parsed.Tags
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
		Title   string   `json:"title"`
		Prompt  string   `json:"prompt"`
		Notes   string   `json:"notes"`
		Price   int      `json:"price"`
		Tags    []string `json:"tags"`
		Encoded string   `json:"encoded"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.Price < 1 || body.Price > 20 {
		return nil, bad("灵感提示词须设置 1~20 积分解锁，暂不支持免费分享")
	}

	title := firstStr(strings.TrimSpace(body.Title), cur.Title)
	promptTxt := firstStr(strings.TrimSpace(body.Prompt), cur.Prompt, cur.PromptZh)
	if promptTxt == "" {
		return nil, bad("分享灵感卡需要包含提示词")
	}
	tags := cur.Tags
	if len(body.Tags) > 0 {
		tags = body.Tags
	}

	imageDataOrURL := strings.TrimSpace(body.Encoded)
	imageSHA := ""
	if imageDataOrURL == "" && cur.ImagePath != "" {
		raw, rErr := os.ReadFile(cur.ImagePath)
		if rErr != nil {
			return nil, bad("读取本地灵感图失败：" + rErr.Error())
		}
		sum := sha256.Sum256(raw)
		imageSHA = hex.EncodeToString(sum[:])
		mime := "image/png"
		switch sniffImageExt(raw) {
		case ".jpg":
			mime = "image/jpeg"
		case ".webp":
			mime = "image/webp"
		case ".gif":
			mime = "image/gif"
		}
		imageDataOrURL = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
	} else if imageDataOrURL == "" && cur.ImageURL != "" {
		imageDataOrURL = cur.ImageURL
	}
	if imageDataOrURL == "" {
		return nil, bad("分享灵感卡需要至少一张图片")
	}

	payload := map[string]any{
		"title":          title,
		"prompt":         promptTxt,
		"promptZh":       cur.PromptZh,
		"slots":          cur.Slots,
		"tags":           tags,
		"recipe":         cur.Recipe,
		"suggestedStyle": cur.SuggestedStyle,
		"sourceUrl":      cur.SourceURL,
		"sourceAuthor":   cur.SourceAuthor,
		"sourceChannel":  firstStr(cur.Source, "client"),
		"notes":          firstStr(strings.TrimSpace(body.Notes), cur.Notes),
		"price":          body.Price,
		"imageUrl":       imageDataOrURL,
		"imageSha256":    imageSHA,
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
	d.PublishedID = pubID
	d.PublishedURL = pubURL
	d.PublishedPrice = body.Price
	updated, _ := s.saveInspiration(id, d)
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
	return map[string]any{"ok": true, "clipToken": tok}, nil
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
