package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/netutil"
)

// ExtractedInspiration is the standard output contract shared by all built-in
// platform URL adapters and future external platform collector skills/plugins (#88).
type ExtractedInspiration struct {
	Platform    string   `json:"platform"`              // x | xiaohongshu | web
	Adapter     string   `json:"adapter"`               // fxtwitter | vxtwitter | xhs-meta | html-meta | direct-image
	Title       string   `json:"title"`
	Author      string   `json:"author"`
	Text        string   `json:"text"`
	Images      []string `json:"images"`
	SourceURL   string   `json:"sourceUrl"`
	Warning     string   `json:"warning,omitempty"`
	NeedClipper bool     `json:"needClipper,omitempty"`
}

// URLPlatformAdapter encapsulates platform-specific extraction rules so each
// social or web platform can be maintained and extended independently (#88).
type URLPlatformAdapter interface {
	ID() string
	Platform() string
	Match(u *url.URL) bool
	Extract(ctx context.Context, rawURL string, u *url.URL) (*ExtractedInspiration, error)
}

var (
	fxTwitterAPIBase            = "https://api.fxtwitter.com"
	vxTwitterAPIBase            = "https://api.vxtwitter.com"
	allowPrivateURLFetchForTest = false
)

func defaultURLAdapters() []URLPlatformAdapter {
	return []URLPlatformAdapter{
		xPlatformAdapter{},
		xhsPlatformAdapter{},
		genericWebAdapter{},
	}
}

func isBareURL(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	s = strings.Trim(s, "<>\"'")
	if s == "" || strings.ContainsAny(s, " \t\r\n") {
		return "", false
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false
	}
	return s, true
}

func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast()
}

func isPrivateOrLocalHost(host string) bool {
	if allowPrivateURLFetchForTest {
		return false
	}
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return isBlockedIP(ip)
	}
	return false
}

func validatePublicHTTPURL(u *url.URL) error {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return fmt.Errorf("请输入有效的 http:// 或 https:// 链接")
	}
	if isPrivateOrLocalHost(u.Hostname()) {
		return fmt.Errorf("出于安全限制，不支持抓取本机或局域网地址")
	}
	return nil
}

// safeExtractDialContext resolves DNS upfront, rejects any host resolving to
// loopback/private/link-local/multicast IPs, and pins the connection to the
// verified IP to prevent DNS bypass and TOCTOU DNS rebinding (#179).
func safeExtractDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if allowPrivateURLFetchForTest {
		return dialer.DialContext(ctx, network, addr)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("目标地址无效：%w", err)
	}
	if isPrivateOrLocalHost(host) {
		return nil, errors.New("出于安全限制，不支持抓取本机或局域网地址")
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("无法解析域名 %s", host)
	}
	for _, ip := range ips {
		if isBlockedIP(ip.IP) {
			return nil, errors.New("出于安全限制，目标域名解析到本机或局域网地址")
		}
	}
	var lastErr error
	for _, ip := range netutil.OrderIPsPreferIPv4(ips) {
		conn, derr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if derr == nil {
			return conn, nil
		}
		lastErr = derr
	}
	return nil, lastErr
}

func newSafeExtractHTTPClient(timeout time.Duration) *http.Client {
	tr := netutil.NewTransport()
	var approvedProxies sync.Map
	tr.Proxy = func(req *http.Request) (*url.URL, error) {
		if !allowPrivateURLFetchForTest {
			if err := validatePublicHTTPURL(req.URL); err != nil {
				return nil, err
			}
		}
		pURL, err := netutil.SystemProxyFunc(req)
		if err == nil && pURL != nil {
			if ep := netutil.ProxyEndpointAddr(pURL); ep != "" {
				approvedProxies.Store(ep, struct{}{})
			}
		}
		return pURL, err
	}
	proxyDialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if _, ok := approvedProxies.Load(strings.ToLower(strings.TrimSpace(addr))); ok {
			return proxyDialer.DialContext(ctx, network, addr)
		}
		return safeExtractDialContext(ctx, network, addr)
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 6 {
				return errors.New("重定向次数过多")
			}
			return validatePublicHTTPURL(req.URL)
		},
	}
}

func (s *Server) extractInspirationFromURL(ctx context.Context, rawURL string) (*ExtractedInspiration, error) {
	cleaned, ok := isBareURL(rawURL)
	if !ok {
		return nil, bad("请输入有效的网页或推文链接（以 http:// 或 https:// 开头）")
	}
	u, err := url.Parse(cleaned)
	if err != nil {
		return nil, bad("链接格式无效")
	}
	if err := validatePublicHTTPURL(u); err != nil {
		return nil, bad(err.Error())
	}
	for _, ad := range defaultURLAdapters() {
		if ad.Match(u) {
			return ad.Extract(ctx, cleaned, u)
		}
	}
	return nil, bad("暂不支持解析该链接类型")
}

// ---------- Adapter 1: X / Twitter (FxTwitter -> VxTwitter fallback) ----------

var reXStatusPath = regexp.MustCompile(`(?i)^/(?:([^/]+)/status(?:es)?|i/(?:web/)?status)/(\d+)`)

type xPlatformAdapter struct{}

func (xPlatformAdapter) ID() string       { return "x-twitter" }
func (xPlatformAdapter) Platform() string { return "x" }

func (xPlatformAdapter) Match(u *url.URL) bool {
	h := strings.ToLower(u.Hostname())
	switch h {
	case "x.com", "www.x.com", "mobile.x.com",
		"twitter.com", "www.twitter.com", "mobile.twitter.com",
		"fxtwitter.com", "www.fxtwitter.com",
		"vxtwitter.com", "www.vxtwitter.com",
		"fixupx.com", "www.fixupx.com":
		return true
	}
	return false
}

func normalizeTwitterMediaOrig(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if strings.EqualFold(u.Hostname(), "pbs.twimg.com") && strings.HasPrefix(u.Path, "/media/") {
		q := u.Query()
		if q.Get("name") == "" || q.Get("name") == "small" || q.Get("name") == "medium" || q.Get("name") == "large" {
			q.Set("name", "orig")
			u.RawQuery = q.Encode()
			return u.String()
		}
	}
	return raw
}

func appendUniqueURL(list []string, raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return list
	}
	for _, existing := range list {
		if existing == raw {
			return list
		}
	}
	return append(list, raw)
}

func (xPlatformAdapter) Extract(ctx context.Context, rawURL string, u *url.URL) (*ExtractedInspiration, error) {
	m := reXStatusPath.FindStringSubmatch(u.Path)
	if len(m) < 3 {
		return nil, bad("请粘贴具体的 X 推文详情链接（格式如 https://x.com/用户名/status/推文ID）")
	}
	userSeg := strings.TrimSpace(m[1])
	if userSeg == "" {
		userSeg = "i"
	}
	statusID := m[2]

	if ext, err := fetchViaFxTwitter(ctx, userSeg, statusID); err == nil && ext != nil {
		return ext, nil
	}
	if ext, err := fetchViaVxTwitter(ctx, userSeg, statusID); err == nil && ext != nil {
		return ext, nil
	}
	return &ExtractedInspiration{
		Platform:    "x",
		Adapter:     "x-fallback",
		SourceURL:   fmt.Sprintf("https://x.com/%s/status/%s", userSeg, statusID),
		NeedClipper: true,
		Warning:     "暂时无法直接拉取该 X 推文（可能是网络代理未覆盖、推文受保护/仅订阅者可见或原帖已删除）。你可以开启本机代理后重试，或在浏览器打开该推文用「Chrome 灵感捕手」一键剪藏。",
	}, nil
}

type fxTweetNode struct {
	URL    string `json:"url"`
	ID     string `json:"id"`
	Text   string `json:"text"`
	Author struct {
		Name       string `json:"name"`
		ScreenName string `json:"screen_name"`
	} `json:"author"`
	Media *struct {
		Photos []struct {
			URL string `json:"url"`
		} `json:"photos"`
		Videos []struct {
			ThumbnailURL string `json:"thumbnail_url"`
		} `json:"videos"`
	} `json:"media"`
	Article *struct {
		Title       string `json:"title"`
		PreviewText string `json:"preview_text"`
		CoverMedia  *struct {
			MediaInfo *struct {
				OriginalImgURL string `json:"original_img_url"`
			} `json:"media_info"`
		} `json:"cover_media"`
		Content *struct {
			Blocks []struct {
				Text string `json:"text"`
			} `json:"blocks"`
		} `json:"content"`
	} `json:"article"`
	Quote *fxTweetNode `json:"quote"`
}

func fetchViaFxTwitter(ctx context.Context, userSeg, statusID string) (*ExtractedInspiration, error) {
	ep := fmt.Sprintf("%s/%s/status/%s", strings.TrimRight(fxTwitterAPIBase, "/"), url.PathEscape(userSeg), url.PathEscape(statusID))
	hc := netutil.NewClient(15 * time.Second)
	resp, err := netutil.DoWithRetry(ctx, hc, func() (*http.Request, error) {
		r, rerr := http.NewRequestWithContext(ctx, http.MethodGet, ep, nil)
		if rerr != nil {
			return nil, rerr
		}
		r.Header.Set("User-Agent", "HandrawClient/1.0 (+https://handraw-style.com)")
		r.Header.Set("Accept", "application/json")
		return r, nil
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fxtwitter http %d", resp.StatusCode)
	}
	var payload struct {
		Code    int          `json:"code"`
		Message string       `json:"message"`
		Tweet   *fxTweetNode `json:"tweet"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	if payload.Tweet == nil {
		return nil, errors.New("fxtwitter empty tweet")
	}
	tw := payload.Tweet
	var textParts []string
	var images []string
	title := ""

	if tw.Article != nil {
		if t := strings.TrimSpace(tw.Article.Title); t != "" {
			title = t
			textParts = append(textParts, t)
		}
		if tw.Article.CoverMedia != nil && tw.Article.CoverMedia.MediaInfo != nil {
			images = appendUniqueURL(images, normalizeTwitterMediaOrig(tw.Article.CoverMedia.MediaInfo.OriginalImgURL))
		}
		if tw.Article.Content != nil && len(tw.Article.Content.Blocks) > 0 {
			var blocks []string
			for _, blk := range tw.Article.Content.Blocks {
				if bt := strings.TrimSpace(blk.Text); bt != "" {
					blocks = append(blocks, bt)
				}
			}
			if len(blocks) > 0 {
				textParts = append(textParts, strings.Join(blocks, "\n\n"))
			}
		} else if prev := strings.TrimSpace(tw.Article.PreviewText); prev != "" {
			textParts = append(textParts, prev)
		}
	}

	if mainTxt := strings.TrimSpace(tw.Text); mainTxt != "" {
		textParts = append(textParts, mainTxt)
	}
	if tw.Media != nil {
		for _, ph := range tw.Media.Photos {
			images = appendUniqueURL(images, normalizeTwitterMediaOrig(ph.URL))
		}
		if len(images) == 0 {
			for _, vd := range tw.Media.Videos {
				images = appendUniqueURL(images, normalizeTwitterMediaOrig(vd.ThumbnailURL))
			}
		}
	}
	if tw.Quote != nil {
		if qt := strings.TrimSpace(tw.Quote.Text); qt != "" {
			qAuthor := strings.TrimSpace(tw.Quote.Author.ScreenName)
			if qAuthor != "" {
				textParts = append(textParts, fmt.Sprintf("[引用 @%s]\n%s", qAuthor, qt))
			} else {
				textParts = append(textParts, "[引用推文]\n"+qt)
			}
		}
		if len(images) == 0 && tw.Quote.Media != nil {
			for _, ph := range tw.Quote.Media.Photos {
				images = appendUniqueURL(images, normalizeTwitterMediaOrig(ph.URL))
			}
		}
	}

	fullText := strings.TrimSpace(strings.Join(textParts, "\n\n"))
	if fullText == "" && len(images) == 0 {
		return nil, errors.New("fxtwitter no content")
	}
	screen := firstStr(strings.TrimSpace(tw.Author.ScreenName), userSeg)
	author := strings.TrimSpace(tw.Author.Name)
	if screen != "" && screen != "i" {
		if author != "" && !strings.EqualFold(author, screen) {
			author = author + " (@" + screen + ")"
		} else {
			author = "@" + screen
		}
	}
	if title == "" {
		firstLine := strings.TrimSpace(strings.Split(fullText, "\n")[0])
		title = firstNRunes(firstLine, 28)
	}
	canonicalURL := fmt.Sprintf("https://x.com/%s/status/%s", firstStr(screen, "i"), firstStr(tw.ID, statusID))
	return &ExtractedInspiration{
		Platform:  "x",
		Adapter:   "fxtwitter",
		Title:     title,
		Author:    author,
		Text:      fullText,
		Images:    images,
		SourceURL: canonicalURL,
	}, nil
}

func fetchViaVxTwitter(ctx context.Context, userSeg, statusID string) (*ExtractedInspiration, error) {
	ep := fmt.Sprintf("%s/%s/status/%s", strings.TrimRight(vxTwitterAPIBase, "/"), url.PathEscape(userSeg), url.PathEscape(statusID))
	hc := netutil.NewClient(12 * time.Second)
	resp, err := netutil.DoWithRetry(ctx, hc, func() (*http.Request, error) {
		r, rerr := http.NewRequestWithContext(ctx, http.MethodGet, ep, nil)
		if rerr != nil {
			return nil, rerr
		}
		r.Header.Set("User-Agent", "HandrawClient/1.0")
		r.Header.Set("Accept", "application/json")
		return r, nil
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vxtwitter http %d", resp.StatusCode)
	}
	var payload struct {
		Text           string   `json:"text"`
		UserName       string   `json:"user_name"`
		UserScreenName string   `json:"user_screen_name"`
		TweetID        string   `json:"tweetID"`
		MediaURLs      []string `json:"mediaURLs"`
		MediaExtended  []struct {
			Type         string `json:"type"`
			URL          string `json:"url"`
			ThumbnailURL string `json:"thumbnail_url"`
		} `json:"media_extended"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	var images []string
	for _, m := range payload.MediaExtended {
		if m.Type == "image" && m.URL != "" {
			images = appendUniqueURL(images, normalizeTwitterMediaOrig(m.URL))
		} else if m.ThumbnailURL != "" {
			images = appendUniqueURL(images, normalizeTwitterMediaOrig(m.ThumbnailURL))
		}
	}
	if len(images) == 0 {
		for _, mu := range payload.MediaURLs {
			images = appendUniqueURL(images, normalizeTwitterMediaOrig(mu))
		}
	}
	fullText := strings.TrimSpace(payload.Text)
	if fullText == "" && len(images) == 0 {
		return nil, errors.New("vxtwitter no content")
	}
	screen := firstStr(strings.TrimSpace(payload.UserScreenName), userSeg)
	author := strings.TrimSpace(payload.UserName)
	if screen != "" && screen != "i" {
		if author != "" && !strings.EqualFold(author, screen) {
			author = author + " (@" + screen + ")"
		} else {
			author = "@" + screen
		}
	}
	firstLine := strings.TrimSpace(strings.Split(fullText, "\n")[0])
	return &ExtractedInspiration{
		Platform:  "x",
		Adapter:   "vxtwitter",
		Title:     firstNRunes(firstLine, 28),
		Author:    author,
		Text:      fullText,
		Images:    images,
		SourceURL: fmt.Sprintf("https://x.com/%s/status/%s", firstStr(screen, "i"), firstStr(payload.TweetID, statusID)),
	}, nil
}

// ---------- Adapter 2: Xiaohongshu (best-effort public meta + honest clipper guidance) ----------

type xhsPlatformAdapter struct{}

func (xhsPlatformAdapter) ID() string       { return "xiaohongshu" }
func (xhsPlatformAdapter) Platform() string { return "xiaohongshu" }

func (xhsPlatformAdapter) Match(u *url.URL) bool {
	h := strings.ToLower(u.Hostname())
	return h == "xiaohongshu.com" || strings.HasSuffix(h, ".xiaohongshu.com") || h == "xhslink.com" || strings.HasSuffix(h, ".xhslink.com")
}

func (xhsPlatformAdapter) Extract(ctx context.Context, rawURL string, u *url.URL) (*ExtractedInspiration, error) {
	meta, finalURL, err := fetchHTMLMetadata(ctx, rawURL)
	if err == nil && meta != nil {
		title := strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(meta.Title, " - 小红书"), "- 小红书"))
		desc := strings.TrimSpace(meta.Description)
		isGenericWall := title == "" || strings.Contains(title, "小红书 - 你的生活兴趣社区") || strings.Contains(title, "安全限制") || strings.Contains(title, "登录")
		if !isGenericWall && (desc != "" || len(meta.Images) > 0) {
			txt := desc
			if title != "" && !strings.Contains(txt, title) {
				if txt != "" {
					txt = title + "\n\n" + txt
				} else {
					txt = title
				}
			}
			return &ExtractedInspiration{
				Platform:  "xiaohongshu",
				Adapter:   "xhs-meta",
				Title:     firstNRunes(title, 28),
				Author:    meta.Author,
				Text:      txt,
				Images:    meta.Images,
				SourceURL: firstStr(finalURL, rawURL),
				Warning:   "已提取小红书公开摘要信息；如需抓取完整长文案与全部多图，推荐在浏览器打开该笔记后用「Chrome 灵感捕手」一键剪藏。",
			}, nil
		}
	}
	return &ExtractedInspiration{
		Platform:    "xiaohongshu",
		Adapter:     "xhs-meta",
		SourceURL:   firstStr(finalURL, rawURL),
		NeedClipper: true,
		Warning:     "小红书链接受 xsec_token 与登录态限制，无法直接后台抓取。请点击右上角「🧩 Chrome 灵感捕手」在浏览器打开笔记后一键剪藏，或直接复制粘贴正文与配图。",
	}, nil
}

// ---------- Adapter 3: Generic Web Page (OpenGraph + readable text) ----------

type genericWebAdapter struct{}

func (genericWebAdapter) ID() string       { return "generic-web" }
func (genericWebAdapter) Platform() string { return "web" }
func (genericWebAdapter) Match(u *url.URL) bool {
	return u != nil && (u.Scheme == "http" || u.Scheme == "https")
}

func (genericWebAdapter) Extract(ctx context.Context, rawURL string, u *url.URL) (*ExtractedInspiration, error) {
	hc := newSafeExtractHTTPClient(15 * time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, bad("抓取网页失败：" + err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, bad(fmt.Sprintf("目标网页返回 HTTP %d，可能需要登录或触发了防爬拦截，请改用「Chrome 灵感捕手」剪藏", resp.StatusCode))
	}
	finalURL := rawURL
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.HasPrefix(ct, "image/") {
		return &ExtractedInspiration{
			Platform:  "web",
			Adapter:   "direct-image",
			Title:     "图片灵感",
			Images:    []string{finalURL},
			SourceURL: finalURL,
		}, nil
	}
	rawBytes, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, bad("读取网页内容失败：" + err.Error())
	}
	meta := parseHTMLMetadata(string(rawBytes), finalURL)
	text := strings.TrimSpace(meta.BodyText)
	if text == "" {
		text = strings.TrimSpace(meta.Description)
	}
	if text == "" && len(meta.Images) == 0 {
		return &ExtractedInspiration{
			Platform:    "web",
			Adapter:     "html-meta",
			Title:       firstNRunes(meta.Title, 28),
			SourceURL:   finalURL,
			NeedClipper: true,
			Warning:     "该页面内容为客户端动态渲染或需要登录才能查看，未能提取到正文与图片。建议在浏览器打开后用「Chrome 灵感捕手」一键剪藏。",
		}, nil
	}
	return &ExtractedInspiration{
		Platform:  "web",
		Adapter:   "html-meta",
		Title:     firstNRunes(firstStr(meta.Title, strings.Split(text, "\n")[0]), 28),
		Author:    meta.Author,
		Text:      text,
		Images:    meta.Images,
		SourceURL: finalURL,
	}, nil
}

type htmlMetaResult struct {
	Title       string
	Description string
	Author      string
	Images      []string
	BodyText    string
}

var (
	reHTMLTitle    = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reHTMLMetaTag  = regexp.MustCompile(`(?is)<meta\b[^>]*>`)
	reHTMLAttr     = regexp.MustCompile(`(?is)([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>` + "`" + `]+))`)
	reHTMLStripBlk = regexp.MustCompile(`(?is)<(?:script|style|noscript|svg|nav|header|footer)[^>]*>.*?</(?:script|style|noscript|svg|nav|header|footer)>`)
	reHTMLPara     = regexp.MustCompile(`(?is)<(?:p|h1|h2|h3|blockquote|pre|code|li)[^>]*>(.*?)</(?:p|h1|h2|h3|blockquote|pre|code|li)>`)
	reHTMLTags     = regexp.MustCompile(`(?is)<[^>]+>`)
	reMultiSpaces  = regexp.MustCompile(`[ \t\f\r]+`)
)

func fetchHTMLMetadata(ctx context.Context, rawURL string) (*htmlMetaResult, string, error) {
	hc := newSafeExtractHTTPClient(12 * time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, rawURL, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, rawURL, err
	}
	defer resp.Body.Close()
	finalURL := rawURL
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	if resp.StatusCode >= 400 {
		return nil, finalURL, fmt.Errorf("http %d", resp.StatusCode)
	}
	rawBytes, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, finalURL, err
	}
	return parseHTMLMetadata(string(rawBytes), finalURL), finalURL, nil
}

func resolveAbsURL(baseStr, ref string) string {
	ref = strings.TrimSpace(html.UnescapeString(ref))
	if ref == "" || strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "javascript:") {
		return ""
	}
	bu, err := url.Parse(baseStr)
	if err != nil {
		return ref
	}
	ru, err := url.Parse(ref)
	if err != nil {
		return ""
	}
	resolved := bu.ResolveReference(ru)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return ""
	}
	return resolved.String()
}

func parseHTMLMetadata(doc, baseURL string) *htmlMetaResult {
	res := &htmlMetaResult{}
	if m := reHTMLTitle.FindStringSubmatch(doc); len(m) > 1 {
		res.Title = strings.TrimSpace(reMultiSpaces.ReplaceAllString(html.UnescapeString(reHTMLTags.ReplaceAllString(m[1], " ")), " "))
	}

	for _, tag := range reHTMLMetaTag.FindAllString(doc, 120) {
		attrs := map[string]string{}
		for _, am := range reHTMLAttr.FindAllStringSubmatch(tag, -1) {
			k := strings.ToLower(am[1])
			v := firstStr(am[2], am[3], am[4])
			attrs[k] = strings.TrimSpace(html.UnescapeString(v))
		}
		key := strings.ToLower(firstStr(attrs["property"], attrs["name"]))
		val := attrs["content"]
		if key == "" || val == "" {
			continue
		}
		switch key {
		case "og:title", "twitter:title":
			if val != "" {
				res.Title = val
			}
		case "og:description", "twitter:description", "description":
			if res.Description == "" || key == "og:description" {
				res.Description = val
			}
		case "author", "og:site_name", "twitter:creator":
			if res.Author == "" {
				res.Author = val
			}
		case "og:image", "og:image:url", "twitter:image", "twitter:image:src":
			if abs := resolveAbsURL(baseURL, val); abs != "" {
				res.Images = appendUniqueURL(res.Images, abs)
			}
		}
	}

	cleaned := reHTMLStripBlk.ReplaceAllString(doc, " ")
	var paras []string
	totalRunes := 0
	for _, pm := range reHTMLPara.FindAllStringSubmatch(cleaned, 40) {
		plain := html.UnescapeString(reHTMLTags.ReplaceAllString(pm[1], " "))
		plain = strings.TrimSpace(reMultiSpaces.ReplaceAllString(plain, " "))
		if len([]rune(plain)) < 8 {
			continue
		}
		paras = append(paras, plain)
		totalRunes += len([]rune(plain))
		if totalRunes >= 2400 {
			break
		}
	}
	if len(paras) > 0 {
		res.BodyText = strings.Join(paras, "\n\n")
	}
	return res
}

func isValidImageBytes(contentType string, raw []byte) bool {
	if len(raw) < 16 {
		return false
	}
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if strings.HasPrefix(ct, "text/") || strings.Contains(ct, "html") || strings.Contains(ct, "json") || strings.Contains(ct, "xml") {
		return false
	}
	detected := strings.ToLower(http.DetectContentType(raw))
	if strings.HasPrefix(detected, "image/") {
		return true
	}
	// WEBP / AVIF / HEIC magic headers not always matched by DetectContentType
	if len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WEBP" {
		return true
	}
	if len(raw) >= 12 && string(raw[4:8]) == "ftyp" {
		return true
	}
	return false
}
