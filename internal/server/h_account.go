package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/profile"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

type loginState struct {
	mu         sync.Mutex
	active     bool
	deviceCode string
	userCode   string
	verifyURL  string
	status     string // idle | pending | ok | error
	errMsg     string
	expiresAt  time.Time
	cancel     context.CancelFunc
}

func (s *Server) account(w http.ResponseWriter, r *http.Request) (any, error) {
	skillUser, skillFound := profile.SkillAuthDetected()
	if !s.Site.LoggedIn() {
		return map[string]any{
			"loggedIn":       false,
			"skillDetected":  skillFound,
			"skillUsername":  skillUser,
			"siteBase":       s.Site.Base(),
		}, nil
	}
	me, err := s.Site.Me(r.Context())
	if err != nil {
		if site.IsAuthError(err) {
			_ = secrets.Delete(secrets.SiteToken)
			_ = s.DB.SetKV("account_user", map[string]any{})
			_ = s.DB.SetKV("balance_cache", map[string]any{})
			return map[string]any{
				"loggedIn":      false,
				"expired":       true,
				"error":         "登录授权已失效，请重新登录（本地创作不受影响）",
				"skillDetected": skillFound,
				"skillUsername": skillUser,
				"siteBase":      s.Site.Base(),
			}, nil
		}
		var cached map[string]any
		_ = s.DB.GetKV("account_user", &cached)
		return map[string]any{
			"loggedIn":      true,
			"offline":       true,
			"user":          cached,
			"error":         err.Error(),
			"skillDetected": skillFound,
			"skillUsername": skillUser,
			"siteBase":      s.Site.Base(),
		}, nil
	}
	_ = s.DB.SetKV("account_user", me)
	return map[string]any{
		"loggedIn":      true,
		"user":          me,
		"skillDetected": skillFound,
		"skillUsername": skillUser,
		"siteBase":      s.Site.Base(),
	}, nil
}

func (s *Server) loginStart(w http.ResponseWriter, r *http.Request) (any, error) {
	ds, err := s.Site.StartDevice(r.Context())
	if err != nil {
		return nil, err
	}
	if ds.Interval <= 0 {
		ds.Interval = 3
	}
	if ds.ExpiresIn <= 0 {
		ds.ExpiresIn = 300
	}
	s.login.mu.Lock()
	if s.login.cancel != nil {
		s.login.cancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(ds.ExpiresIn)*time.Second)
	s.login.active = true
	s.login.deviceCode = ds.DeviceCode
	s.login.userCode = ds.UserCode
	s.login.verifyURL = ds.VerificationURL
	s.login.status = "pending"
	s.login.errMsg = ""
	s.login.expiresAt = time.Now().Add(time.Duration(ds.ExpiresIn) * time.Second)
	s.login.cancel = cancel
	s.login.mu.Unlock()

	if ds.VerificationURL != "" {
		_ = s.Host.OpenURL(ds.VerificationURL)
	}
	go s.pollLogin(ctx, ds.DeviceCode, ds.Interval)
	return map[string]any{
		"status":          "pending",
		"userCode":        ds.UserCode,
		"verificationUrl": ds.VerificationURL,
		"expiresIn":       ds.ExpiresIn,
	}, nil
}

func (s *Server) pollLogin(ctx context.Context, deviceCode string, interval int) {
	t := time.NewTicker(time.Duration(interval) * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.login.mu.Lock()
			if s.login.deviceCode == deviceCode && s.login.status == "pending" {
				s.login.active = false
				s.login.status = "error"
				s.login.errMsg = "登录授权已超时，请重试"
			}
			s.login.mu.Unlock()
			s.Emit("account", map[string]any{"status": "error"})
			return
		case <-t.C:
			done, _ := s.tryExchangeDevice(ctx, deviceCode)
			if done {
				return
			}
		}
	}
}

func (s *Server) tryExchangeDevice(ctx context.Context, deviceCode string) (bool, error) {
	res, code, err := s.Site.PollDevice(ctx, deviceCode)
	if err != nil {
		s.login.mu.Lock()
		if s.login.deviceCode == deviceCode {
			s.login.active = false
			s.login.status = "error"
			s.login.errMsg = err.Error()
		}
		s.login.mu.Unlock()
		s.Emit("account", map[string]any{"status": "error", "error": err.Error()})
		return true, err
	}
	if res == nil {
		_ = code
		return false, nil
	}
	if err := secrets.Set(secrets.SiteToken, res.Token); err != nil {
		s.login.mu.Lock()
		s.login.active = false
		s.login.status = "error"
		s.login.errMsg = "保存令牌到系统凭据库失败：" + err.Error()
		s.login.mu.Unlock()
		return true, err
	}
	_ = s.DB.SetKV("account_user", res.User)
	s.login.mu.Lock()
	if s.login.cancel != nil {
		s.login.cancel()
	}
	s.login.active = false
	s.login.status = "ok"
	s.login.errMsg = ""
	s.login.mu.Unlock()
	s.Emit("account", map[string]any{"loggedIn": true, "user": res.User})
	s.Emit("balance", nil)
	go func() {
		_, _ = s.syncResourcesInternal(context.Background())
	}()
	return true, nil
}

// HandleDeepLink handles handraw:// URL callbacks from the browser.
func (s *Server) HandleDeepLink(rawURL string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return
	}
	s.Host.ShowMain()
	if u.Host == "auth" || strings.HasPrefix(u.Path, "/auth") {
		s.login.mu.Lock()
		dc := s.login.deviceCode
		s.login.mu.Unlock()
		if dc != "" {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				_, _ = s.tryExchangeDevice(ctx, dc)
			}()
		}
	}
}

func (s *Server) loginStatus(w http.ResponseWriter, r *http.Request) (any, error) {
	s.login.mu.Lock()
	defer s.login.mu.Unlock()
	return map[string]any{
		"active":          s.login.active,
		"status":          s.login.status,
		"userCode":        s.login.userCode,
		"verificationUrl": s.login.verifyURL,
		"error":           s.login.errMsg,
		"loggedIn":        s.Site.LoggedIn(),
	}, nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) (any, error) {
	s.login.mu.Lock()
	if s.login.cancel != nil {
		s.login.cancel()
	}
	s.login.active = false
	s.login.status = "idle"
	s.login.mu.Unlock()

	if s.Site.LoggedIn() {
		// Best-effort token revocation on the server before wiping local keyring.
		var tokens struct {
			Items []struct {
				ID      string `json:"id"`
				Current bool   `json:"current"`
			} `json:"items"`
		}
		if raw, err := s.Site.Get(r.Context(), "/api/auth/tokens"); err == nil && json.Unmarshal(raw, &tokens) == nil {
			for _, it := range tokens.Items {
				if it.Current && it.ID != "" {
					_, _ = s.Site.Send(r.Context(), "POST", "/api/auth/tokens/"+url.PathEscape(it.ID)+"/revoke", map[string]any{})
				}
			}
		}
	}
	_ = secrets.Delete(secrets.SiteToken)
	_ = s.DB.SetKV("account_user", map[string]any{})
	_ = s.DB.SetKV("balance_cache", map[string]any{})
	s.Emit("account", map[string]any{"loggedIn": false})
	return okv, nil
}

func (s *Server) balance(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return map[string]any{"loggedIn": false}, nil
	}
	raw, err := s.Site.Economy(r.Context())
	if err != nil {
		if site.IsAuthError(err) {
			_ = secrets.Delete(secrets.SiteToken)
			_ = s.DB.SetKV("account_user", map[string]any{})
			_ = s.DB.SetKV("balance_cache", map[string]any{})
			return map[string]any{
				"loggedIn": false,
				"expired":  true,
				"error":    "登录授权已失效，请重新登录（本地创作不受影响）",
			}, nil
		}
		var ae *site.APIError
		errCode := ""
		scopeDenied := false
		if errors.As(err, &ae) {
			errCode = ae.Code
			scopeDenied = ae.Status == http.StatusForbidden || ae.Code == "token_scope_denied"
		}
		var cached json.RawMessage
		if s.DB.GetKV("balance_cache", &cached) == nil && hasNonEmptyJSONObject(cached) {
			return map[string]any{
				"loggedIn":    true,
				"offline":     true,
				"scopeDenied": scopeDenied,
				"code":        errCode,
				"economy":     cached,
				"error":       err.Error(),
			}, nil
		}
		return map[string]any{
			"loggedIn":    true,
			"unavailable": true,
			"scopeDenied": scopeDenied,
			"code":        errCode,
			"error":       err.Error(),
		}, nil
	}
	_ = s.DB.SetKV("balance_cache", raw)
	return map[string]any{"loggedIn": true, "economy": raw}, nil
}

func hasNonEmptyJSONObject(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var obj map[string]any
	return json.Unmarshal(raw, &obj) == nil && len(obj) > 0
}

func (s *Server) siteCollections(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	raw, err := s.Site.Get(r.Context(), "/api/v1/me/collection-items")
	if err != nil {
		return nil, err
	}
	return map[string]any{"data": raw, "siteBase": s.Site.Base()}, nil
}

func (s *Server) siteHistory(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	cursor := r.URL.Query().Get("cursor")
	q := "/api/v1/me/generations?limit=24"
	if cursor != "" {
		q += "&cursor=" + url.QueryEscape(cursor)
	}
	raw, err := s.Site.Get(r.Context(), q)
	if err != nil {
		// Fallback to legacy studio history when V3 generations endpoint is unavailable.
		raw2, err2 := s.Site.Get(r.Context(), "/api/studio/history?limit=40")
		if err2 != nil {
			return nil, err
		}
		return map[string]any{"data": raw2, "siteBase": s.Site.Base()}, nil
	}
	return map[string]any{"data": raw, "siteBase": s.Site.Base()}, nil
}

func (s *Server) siteHistoryDownload(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Title   string   `json:"title"`
		Prompt  string   `json:"prompt"`
		Model   string   `json:"model"`
		Images  []string `json:"images"`
		SiteRun string   `json:"siteRunId"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.Images) == 0 {
		return nil, bad("没有可下载的图片")
	}
	runID := jobs.NewID("run")
	dir := jobs.RunDir(runID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	run := &store.Run{
		ID:              runID,
		Mode:            "single",
		Title:           firstStr(body.Title, "网站历史作品"),
		OriginalRequest: body.Prompt,
		PromptZh:        body.Prompt,
		Model:           firstStr(body.Model, "site"),
		ModelLabel:      firstStr(body.Model, "网站模型"),
		Source:          "site",
		Status:          "done",
		Dir:             dir,
		RemoteRunID:     firstStr(body.SiteRun, r.PathValue("id")),
	}
	var imgs []store.Image
	for i, imgURL := range body.Images {
		data, _, err := s.Site.Fetch(r.Context(), imgURL)
		if err != nil {
			return nil, err
		}
		im := store.Image{
			ID:     jobs.NewID("img"),
			Idx:    i,
			Status: "done",
			Prompt: body.Prompt,
		}
		fp := filepath.Join(dir, imgName(i, data))
		if err := os.WriteFile(fp, data, 0o644); err != nil {
			return nil, err
		}
		wpx, hpx, sha, thumb := inspectAndThumb(dir, i, data)
		im.Path, im.Width, im.Height, im.SHA256, im.Thumb = fp, wpx, hpx, sha, thumb
		imgs = append(imgs, im)
	}
	if err := s.DB.InsertRun(run, imgs); err != nil {
		return nil, err
	}
	_ = jobs.WriteRunJSON(s.DB, runID)
	run.Images = imgs
	return map[string]any{"run": run}, nil
}

func (s *Server) siteHot(w http.ResponseWriter, r *http.Request) (any, error) {
	force := r.URL.Query().Get("refresh") == "1"
	type hotCache struct {
		At     time.Time       `json:"at"`
		Works  json.RawMessage `json:"works"`
		Topics json.RawMessage `json:"topics"`
	}
	var cached hotCache
	_ = s.DB.GetKV("site_hot_cache", &cached)
	if !force && !cached.At.IsZero() && time.Since(cached.At) < 30*time.Minute && len(cached.Works) > 0 {
		return map[string]any{"works": cached.Works, "topics": cached.Topics, "cachedAt": cached.At, "siteBase": s.Site.Base()}, nil
	}
	var worksRaw, topicsRaw json.RawMessage
	var err error
	if s.Site.LoggedIn() {
		worksRaw, err = s.Site.Get(r.Context(), "/api/works/feed?sort=popular&limit=18")
	} else {
		worksRaw, err = s.Site.GetPublic(r.Context(), "/api/works/feed?sort=popular&limit=18")
	}
	if err != nil && len(cached.Works) > 0 {
		return map[string]any{"works": cached.Works, "topics": cached.Topics, "cachedAt": cached.At, "offline": true, "error": err.Error(), "siteBase": s.Site.Base()}, nil
	}
	if s.Site.LoggedIn() {
		topicsRaw, _ = s.Site.Get(r.Context(), "/api/forum/topics?sort=popular&limit=20")
	} else {
		topicsRaw, _ = s.Site.GetPublic(r.Context(), "/api/forum/topics?sort=popular&limit=20")
	}
	// Fallback: derive popular topics from /api/boot?surface=discover if W4 is not deployed yet.
	if len(topicsRaw) == 0 {
		var bootRaw json.RawMessage
		if s.Site.LoggedIn() {
			bootRaw, _ = s.Site.Get(r.Context(), "/api/boot?surface=discover")
		} else {
			bootRaw, _ = s.Site.GetPublic(r.Context(), "/api/boot?surface=discover")
		}
		var boot struct {
			Topics json.RawMessage `json:"topics"`
		}
		if json.Unmarshal(bootRaw, &boot) == nil && len(boot.Topics) > 0 {
			topicsRaw = boot.Topics
		}
	}
	if len(worksRaw) == 0 {
		worksRaw = json.RawMessage("[]")
	}
	if len(topicsRaw) == 0 {
		topicsRaw = json.RawMessage("[]")
	}
	cached = hotCache{At: time.Now(), Works: worksRaw, Topics: topicsRaw}
	_ = s.DB.SetKV("site_hot_cache", cached)
	return map[string]any{"works": worksRaw, "topics": topicsRaw, "cachedAt": cached.At, "siteBase": s.Site.Base()}, nil
}

func (s *Server) open(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		URL  string `json:"url"`
		Path string `json:"path"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.URL != "" {
		u, err := url.Parse(body.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
			return nil, bad("只允许打开 http/https 链接")
		}
		if err := s.Host.OpenURL(body.URL); err != nil {
			return nil, errors.New("打开浏览器失败：" + err.Error())
		}
		return okv, nil
	}
	if body.Path != "" {
		if err := s.Host.OpenPath(body.Path); err != nil {
			return nil, err
		}
		return okv, nil
	}
	return nil, bad("缺少 url 或 path")
}

func firstStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
