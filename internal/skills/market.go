package skills

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	SkillMirrorGitee  = "gitee"
	SkillMirrorGitHub = "github"

	OfficialSkillMarketGiteeURL  = "https://gitee.com/yang02010/handraw-skills/raw/main/index.json"
	OfficialSkillMarketGitHubURL = "https://raw.githubusercontent.com/yang0/handraw-skills/main/index.json"
	OfficialSkillRawGiteeBase    = "https://gitee.com/yang02010/handraw-skills/raw/main/"
	OfficialSkillRawGitHubBase   = "https://raw.githubusercontent.com/yang0/handraw-skills/main/"

	maxSkillMarketIndexBytes = 4 << 20
	skillMarketCacheTTL      = 5 * time.Minute
)

var skillMarketHTTPClient = &http.Client{Timeout: 25 * time.Second}

type MarketSource struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	URL      string            `json:"url"`
	Mirrors  map[string]string `json:"mirrors,omitempty"`
	Official bool              `json:"official,omitempty"`
	Enabled  bool              `json:"enabled"`
}

type MarketLocalized struct {
	Zh string `json:"zh,omitempty"`
	En string `json:"en,omitempty"`
}

func (l MarketLocalized) Label() string {
	return firstNonEmpty(strings.TrimSpace(l.Zh), strings.TrimSpace(l.En))
}

type MarketPricing struct {
	Model      string `json:"model,omitempty"` // free | pro | credits | paid
	Credits    int    `json:"credits,omitempty"`
	PriceCents int    `json:"priceCents,omitempty"`
}

type MarketDelivery struct {
	Auth string `json:"auth,omitempty"` // none | handraw-account
}

type MarketSkillSource struct {
	Type    string            `json:"type"` // skill-md | zip
	URL     string            `json:"url,omitempty"`
	Mirrors map[string]string `json:"mirrors,omitempty"`
}

type MarketSkill struct {
	ID          string            `json:"id"`
	Version     string            `json:"version,omitempty"`
	Name        string            `json:"name"`
	NameEn      string            `json:"nameEn,omitempty"`
	Badge       string            `json:"badge,omitempty"`
	Description string            `json:"description,omitempty"`
	Author      string            `json:"author,omitempty"`
	License     string            `json:"license,omitempty"`
	Homepage    string            `json:"homepage,omitempty"`
	Categories  []string          `json:"categories,omitempty"`
	Labels      []string          `json:"labels,omitempty"`
	Tags        []string          `json:"tags,omitempty"`
	Pricing     *MarketPricing    `json:"pricing,omitempty"`
	Delivery    *MarketDelivery   `json:"delivery,omitempty"`
	Source      MarketSkillSource `json:"source"`
}

type MarketIndex struct {
	Format      int               `json:"format"`
	Title       MarketLocalized   `json:"title,omitempty"`
	Description MarketLocalized   `json:"description,omitempty"`
	Mirrors     map[string]string `json:"mirrors,omitempty"`
	Metadata    struct {
		Categories map[string]struct {
			Title MarketLocalized `json:"title"`
		} `json:"categories,omitempty"`
		Labels map[string]struct {
			Title MarketLocalized `json:"title"`
		} `json:"labels,omitempty"`
	} `json:"metadata,omitempty"`
	Skills []MarketSkill `json:"skills"`
}

type MarketSourceStatus struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	ActiveMirror string `json:"activeMirror,omitempty"`
	ActiveURL    string `json:"activeUrl,omitempty"`
	Official     bool   `json:"official,omitempty"`
	Enabled      bool   `json:"enabled"`
	Count        int    `json:"count"`
	Error        string `json:"error,omitempty"`
	Fallback     bool   `json:"fallback,omitempty"`
}

type MarketCategory struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type MarketSkillStatus struct {
	ID               string            `json:"id"`
	Version          string            `json:"version,omitempty"`
	InstalledVersion string            `json:"installedVersion,omitempty"`
	HasUpdate        bool              `json:"hasUpdate,omitempty"`
	Name             string            `json:"name"`
	NameEn           string            `json:"nameEn,omitempty"`
	Badge            string            `json:"badge,omitempty"`
	Description      string            `json:"description,omitempty"`
	Author           string            `json:"author,omitempty"`
	License          string            `json:"license,omitempty"`
	Homepage         string            `json:"homepage,omitempty"`
	Categories       []string          `json:"categories,omitempty"`
	Labels           []string          `json:"labels,omitempty"`
	Tags             []string          `json:"tags,omitempty"`
	Pricing          *MarketPricing    `json:"pricing,omitempty"`
	Delivery         *MarketDelivery   `json:"delivery,omitempty"`
	Source           MarketSkillSource `json:"source"`
	MarketID         string            `json:"marketId,omitempty"`
	MarketName       string            `json:"marketName,omitempty"`
	MarketURL        string            `json:"marketUrl,omitempty"`
	Installed        bool              `json:"installed"`
	Enabled          bool              `json:"enabled,omitempty"`
	Builtin          bool              `json:"builtin,omitempty"`
}

type MarketCatalogResult struct {
	DefaultMirror string               `json:"defaultMirror"`
	Sources       []MarketSourceStatus `json:"sources"`
	Categories    []MarketCategory     `json:"categories"`
	Skills        []MarketSkillStatus  `json:"skills"`
}

type skillMarketCacheEntry struct {
	fetchedAt time.Time
	index     MarketIndex
}

var (
	skillMarketCacheMu sync.Mutex
	skillMarketCache   = map[string]skillMarketCacheEntry{}
)

func ClearMarketCache() {
	skillMarketCacheMu.Lock()
	skillMarketCache = map[string]skillMarketCacheEntry{}
	skillMarketCacheMu.Unlock()
}

func skillMirrorOrder(preferred string) []string {
	if strings.EqualFold(strings.TrimSpace(preferred), SkillMirrorGitHub) {
		return []string{SkillMirrorGitHub, SkillMirrorGitee}
	}
	return []string{SkillMirrorGitee, SkillMirrorGitHub}
}

func FetchMarketIndex(ctx context.Context, rawURL string, forceRefresh bool) (MarketIndex, error) {
	rawURL = strings.TrimSpace(rawURL)
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://") {
		return MarketIndex{}, errors.New("Skill 市场地址必须以 http:// 或 https:// 开头")
	}
	if !forceRefresh {
		skillMarketCacheMu.Lock()
		ent, ok := skillMarketCache[rawURL]
		skillMarketCacheMu.Unlock()
		if ok && time.Since(ent.fetchedAt) < skillMarketCacheTTL {
			return ent.index, nil
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return MarketIndex{}, err
	}
	req.Header.Set("User-Agent", "handraw-client")
	req.Header.Set("Accept", "application/json")
	resp, err := skillMarketHTTPClient.Do(req)
	if err != nil {
		return MarketIndex{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return MarketIndex{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSkillMarketIndexBytes))
	if err != nil {
		return MarketIndex{}, err
	}
	var idx MarketIndex
	if err := json.Unmarshal(body, &idx); err != nil {
		return MarketIndex{}, fmt.Errorf("Skill 市场索引 JSON 无效：%w", err)
	}
	if idx.Format != 1 || len(idx.Skills) == 0 {
		return MarketIndex{}, errors.New("Skill 市场索引必须是 Format 1 且包含 skills 条目")
	}
	skillMarketCacheMu.Lock()
	skillMarketCache[rawURL] = skillMarketCacheEntry{fetchedAt: time.Now(), index: idx}
	skillMarketCacheMu.Unlock()
	return idx, nil
}

func FetchMarketIndexForSource(ctx context.Context, src MarketSource, preferredMirror string, forceRefresh bool) (MarketIndex, string, string, error) {
	type cand struct {
		mirror string
		url    string
	}
	var cands []cand
	seen := map[string]bool{}
	add := func(m, u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			seen[u] = true
			cands = append(cands, cand{mirror: m, url: u})
		}
	}
	for _, m := range skillMirrorOrder(preferredMirror) {
		if src.Mirrors != nil {
			add(m, src.Mirrors[m])
		}
	}
	for m, u := range src.Mirrors {
		add(m, u)
	}
	add("", src.URL)
	if len(cands) == 0 {
		return MarketIndex{}, "", "", errors.New("未配置有效的 Skill 市场源地址")
	}
	var lastErr error
	for _, c := range cands {
		idx, err := FetchMarketIndex(ctx, c.url, forceRefresh)
		if err == nil {
			return idx, c.mirror, c.url, nil
		}
		lastErr = err
	}
	return MarketIndex{}, "", "", lastErr
}

// BuiltinFallbackSkills provides an offline starter list matching yang0/handraw-skills
// if both Gitee and GitHub index endpoints are temporarily unreachable.
func BuiltinFallbackSkills() []MarketSkill {
	mk := func(id, name, badge, cat, desc string) MarketSkill {
		return MarketSkill{
			ID:          id,
			Version:     "1.0.0",
			Name:        name,
			Badge:       badge,
			Description: desc,
			Author:      "handraw-official",
			License:     "MIT",
			Homepage:    "https://github.com/yang0/handraw-skills",
			Categories:  []string{cat},
			Labels:      []string{"official-curated", "open-source"},
			Pricing:     &MarketPricing{Model: "free"},
			Source: MarketSkillSource{
				Type: "skill-md",
				URL:  OfficialSkillRawGitHubBase + "skills/" + id + "/SKILL.md",
				Mirrors: map[string]string{
					SkillMirrorGitee:  OfficialSkillRawGiteeBase + "skills/" + id + "/SKILL.md",
					SkillMirrorGitHub: OfficialSkillRawGitHubBase + "skills/" + id + "/SKILL.md",
				},
			},
		}
	}
	return []MarketSkill{
		mk("wechat-article-polish", "公众号文章润色与节奏优化", "写作润色", "writing", "针对微信公众号长文优化开头钩子、段落长度、金句节奏与过渡衔接。"),
		mk("de-ai-tone", "去 AI 味与机器腔清理", "去机器味", "writing", "识别并消除典型大模型套话，让文案恢复自然真人口吻。"),
		mk("xiaohongshu-card-copy", "小红书爆款图文策划", "图文策划", "writing", "将主题拆成 4–8 页高收藏小红书图文卡片与生图提示词。"),
		mk("article-illustration-planner", "长文自动配图规划师", "文章配图", "illustration", "通读文章自动识别 3–6 个最需要视觉化的段落并输出手绘风配图提示词。"),
		mk("picturebook-storyboard", "多页手绘绘本分镜脚本", "绘本分镜", "illustration", "把故事拆解成 6–12 页连贯绘本分镜并锁定主角一致性。"),
		mk("knowledge-note-linker", "Obsidian 双链笔记整理师", "知识库整理", "workflow", "为草稿自动补全规范 YAML Frontmatter、标签体系与 [[双链]] 建议。"),
	}
}

func (m *Manager) ListMarketSkills(ctx context.Context, sources []MarketSource, preferredMirror string, forceRefresh bool) MarketCatalogResult {
	installedMap := map[string]Skill{}
	if list, err := m.List(); err == nil {
		for _, sk := range list {
			installedMap[strings.ToLower(sk.ID)] = sk
		}
	}

	catLabels := map[string]string{
		"writing":      "写作与自媒体",
		"illustration": "生图与分镜",
		"workflow":     "效率与知识库",
	}

	var srcStatuses []MarketSourceStatus
	byID := map[string]*MarketSkillStatus{}
	order := []string{}

	addSkill := func(sk MarketSkill, mID, mName, mURL string) {
		id := SanitizeID(sk.ID)
		if id == "" {
			return
		}
		if _, exists := byID[id]; exists {
			return
		}
		st := &MarketSkillStatus{
			ID:          id,
			Version:     firstNonEmpty(strings.TrimSpace(sk.Version), "1.0.0"),
			Name:        firstNonEmpty(strings.TrimSpace(sk.Name), id),
			NameEn:      strings.TrimSpace(sk.NameEn),
			Badge:       strings.TrimSpace(sk.Badge),
			Description: strings.TrimSpace(sk.Description),
			Author:      strings.TrimSpace(sk.Author),
			License:     strings.TrimSpace(sk.License),
			Homepage:    strings.TrimSpace(sk.Homepage),
			Categories:  sk.Categories,
			Labels:      sk.Labels,
			Tags:        sk.Tags,
			Pricing:     sk.Pricing,
			Delivery:    sk.Delivery,
			Source:      sk.Source,
			MarketID:    mID,
			MarketName:  mName,
			MarketURL:   mURL,
		}
		if inst, ok := installedMap[id]; ok {
			st.Installed = true
			st.Enabled = inst.Enabled
			st.Builtin = inst.Builtin
			st.InstalledVersion = inst.Version
			if st.Version != "" && inst.Version != "" && st.Version != inst.Version {
				st.HasUpdate = true
			}
		}
		byID[id] = st
		order = append(order, id)
	}

	for _, src := range sources {
		sst := MarketSourceStatus{
			ID:       src.ID,
			Name:     firstNonEmpty(src.Name, src.ID),
			URL:      src.URL,
			Official: src.Official,
			Enabled:  src.Enabled,
		}
		if !src.Enabled {
			srcStatuses = append(srcStatuses, sst)
			continue
		}
		idx, activeMirror, activeURL, err := FetchMarketIndexForSource(ctx, src, preferredMirror, forceRefresh)
		if err != nil {
			sst.Error = err.Error()
			if src.Official {
				sst.Fallback = true
				fb := BuiltinFallbackSkills()
				sst.Count = len(fb)
				for _, sk := range fb {
					addSkill(sk, src.ID, sst.Name, src.URL)
				}
			}
		} else {
			sst.ActiveMirror = activeMirror
			sst.ActiveURL = activeURL
			if title := idx.Title.Label(); title != "" && !src.Official {
				sst.Name = title
			}
			for ck, cv := range idx.Metadata.Categories {
				if lbl := cv.Title.Label(); lbl != "" {
					catLabels[ck] = lbl
				}
			}
			sst.Count = len(idx.Skills)
			for _, sk := range idx.Skills {
				addSkill(sk, src.ID, sst.Name, firstNonEmpty(activeURL, src.URL))
			}
		}
		srcStatuses = append(srcStatuses, sst)
	}

	outSkills := make([]MarketSkillStatus, 0, len(order))
	catCounts := map[string]int{}
	catOrder := []string{}
	for _, id := range order {
		st := byID[id]
		outSkills = append(outSkills, *st)
		for _, c := range st.Categories {
			if _, seen := catCounts[c]; !seen {
				catOrder = append(catOrder, c)
			}
			catCounts[c]++
		}
	}
	cats := make([]MarketCategory, 0, len(catOrder))
	for _, cid := range catOrder {
		cats = append(cats, MarketCategory{
			ID:    cid,
			Name:  firstNonEmpty(catLabels[cid], cid),
			Count: catCounts[cid],
		})
	}
	pref := SkillMirrorGitee
	if strings.EqualFold(strings.TrimSpace(preferredMirror), SkillMirrorGitHub) {
		pref = SkillMirrorGitHub
	}
	return MarketCatalogResult{
		DefaultMirror: pref,
		Sources:       srcStatuses,
		Categories:    cats,
		Skills:        outSkills,
	}
}

func (m *Manager) InstallMarketSkill(ctx context.Context, item MarketSkillStatus, preferredMirror string) (Skill, error) {
	id := SanitizeID(item.ID)
	if id == "" {
		return Skill{}, errors.New("Skill ID 无效")
	}
	if id == BuiltinHandrawSkillID {
		return Skill{}, errors.New("不能覆盖内置官方手绘 Skill")
	}
	var urls []string
	seen := map[string]bool{}
	addURL := func(u string) {
		u = strings.TrimSpace(u)
		if u == "" || seen[u] {
			return
		}
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			seen[u] = true
			urls = append(urls, u)
		}
	}
	for _, mk := range skillMirrorOrder(preferredMirror) {
		if item.Source.Mirrors != nil {
			addURL(item.Source.Mirrors[mk])
		}
	}
	addURL(item.Source.URL)
	for _, u := range item.Source.Mirrors {
		addURL(u)
	}
	if len(urls) == 0 {
		return Skill{}, errors.New("该 Skill 条目缺少有效的下载地址")
	}

	var (
		raw     []byte
		usedURL string
		lastErr error
	)
	for _, u := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("User-Agent", "handraw-client")
		resp, err := skillMarketHTTPClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, rerr := io.ReadAll(io.LimitReader(resp.Body, maxZipBytes+1))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			continue
		}
		if rerr != nil {
			lastErr = rerr
			continue
		}
		if len(body) == 0 || len(body) > maxZipBytes {
			lastErr = errors.New("Skill 文件为空或超过 16MB 限制")
			continue
		}
		raw = body
		usedURL = u
		break
	}
	if len(raw) == 0 {
		if lastErr != nil {
			return Skill{}, fmt.Errorf("下载 Skill 失败：%w", lastErr)
		}
		return Skill{}, errors.New("下载 Skill 失败")
	}

	srcTag := "market:" + firstNonEmpty(item.MarketID, "official") + ":" + usedURL
	isZip := strings.EqualFold(item.Source.Type, "zip") ||
		strings.HasSuffix(strings.ToLower(strings.Split(usedURL, "?")[0]), ".zip") ||
		(len(raw) >= 4 && string(raw[:4]) == "PK\x03\x04")
	if isZip {
		return m.installZipBytes(raw, id, srcTag)
	}
	return m.InstallInline(id, item.Name, item.Description, string(raw), srcTag)
}
