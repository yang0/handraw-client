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

// pollJitterBuffer pads RFC 8628 device polling intervals slightly so network
// RTT jitter never causes two consecutive polls to arrive faster than the
// server's interval and trigger cascading slow_down penalties.
var pollJitterBuffer = 450 * time.Millisecond

type loginState struct {
	mu          sync.Mutex
	active      bool
	checking    bool
	deviceCode  string
	userCode    string
	verifyURL   string
	status      string // idle | pending | syncing | ok | error
	errMsg      string
	intervalSec int
	pollCount   int
	lastPollAt  time.Time
	nextCheckAt time.Time
	expiresAt   time.Time
	user        *site.User
	cancel      context.CancelFunc
	nudge       chan struct{}
}

func (s *Server) loginSnapshotLocked() map[string]any {
	snap := map[string]any{
		"active":          s.login.active,
		"checking":        s.login.checking,
		"status":          s.login.status,
		"userCode":        s.login.userCode,
		"verificationUrl": s.login.verifyURL,
		"error":           s.login.errMsg,
		"loggedIn":        s.Site.LoggedIn() || s.login.status == "syncing" || s.login.status == "ok",
		"intervalSec":     s.login.intervalSec,
		"pollCount":       s.login.pollCount,
	}
	if !s.login.expiresAt.IsZero() {
		snap["expiresAt"] = s.login.expiresAt.UTC().Format(time.RFC3339Nano)
		rem := int(time.Until(s.login.expiresAt).Seconds())
		if rem < 0 {
			rem = 0
		}
		snap["expiresIn"] = rem
	}
	if !s.login.nextCheckAt.IsZero() && s.login.active {
		snap["nextCheckAt"] = s.login.nextCheckAt.UTC().Format(time.RFC3339Nano)
	}
	if s.login.user != nil {
		snap["user"] = s.login.user
	}
	return snap
}

func (s *Server) nudgeLoginPoll() {
	s.login.mu.Lock()
	ch := s.login.nudge
	active := s.login.active
	s.login.mu.Unlock()
	if active && ch != nil {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
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
	meCtx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	me, err := s.Site.Me(meCtx)
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
	firstDelay := time.Duration(ds.Interval) * time.Second
	if firstDelay > 2*time.Second {
		// First poll has no previous last_polled_at on the server, so checking
		// promptly catches quick browser approvals without triggering slow_down.
		firstDelay = 2 * time.Second
	}
	nudge := make(chan struct{}, 1)

	s.login.mu.Lock()
	if s.login.cancel != nil {
		s.login.cancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(ds.ExpiresIn)*time.Second)
	s.login.active = true
	s.login.checking = false
	s.login.deviceCode = ds.DeviceCode
	s.login.userCode = ds.UserCode
	s.login.verifyURL = ds.VerificationURL
	s.login.status = "pending"
	s.login.errMsg = ""
	s.login.intervalSec = ds.Interval
	s.login.pollCount = 0
	s.login.lastPollAt = time.Time{}
	s.login.nextCheckAt = time.Now().Add(firstDelay)
	s.login.expiresAt = time.Now().Add(time.Duration(ds.ExpiresIn) * time.Second)
	s.login.user = nil
	s.login.cancel = cancel
	s.login.nudge = nudge
	snap := s.loginSnapshotLocked()
	s.login.mu.Unlock()

	if ds.VerificationURL != "" {
		_ = s.Host.OpenURL(ds.VerificationURL)
	}
	s.Emit("account", snap)
	go s.pollLogin(ctx, ds.DeviceCode, firstDelay, nudge)
	return snap, nil
}

func (s *Server) pollLogin(ctx context.Context, deviceCode string, firstDelay time.Duration, nudge <-chan struct{}) {
	timer := time.NewTimer(firstDelay)
	defer timer.Stop()

	resetTimer := func(d time.Duration) {
		if d < 0 {
			d = 0
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(d)
	}

	for {
		select {
		case <-ctx.Done():
			var snap map[string]any
			s.login.mu.Lock()
			if s.login.deviceCode == deviceCode && s.login.status == "pending" {
				s.login.active = false
				s.login.checking = false
				s.login.status = "error"
				s.login.errMsg = "登录授权已超时，请重新发起登录"
				s.login.nextCheckAt = time.Time{}
				snap = s.loginSnapshotLocked()
			}
			s.login.mu.Unlock()
			if snap != nil {
				s.Emit("account", snap)
			}
			return
		case <-nudge:
			// Honour the server's minimum polling interval even on manual/focus
			// nudges so we never provoke a slow_down backoff penalty.
			s.login.mu.Lock()
			if !s.login.active || s.login.deviceCode != deviceCode {
				s.login.mu.Unlock()
				return
			}
			minWait := time.Duration(s.login.intervalSec)*time.Second + pollJitterBuffer
			var wait time.Duration
			if !s.login.lastPollAt.IsZero() {
				elapsed := time.Since(s.login.lastPollAt)
				if elapsed < minWait {
					wait = minWait - elapsed
				}
			}
			if wait > 0 {
				s.login.nextCheckAt = time.Now().Add(wait)
				snap := s.loginSnapshotLocked()
				s.login.mu.Unlock()
				s.Emit("account", snap)
				resetTimer(wait)
				continue
			}
			s.login.mu.Unlock()
		case <-timer.C:
		}

		done, nextWait := s.tryExchangeDevice(ctx, deviceCode)
		if done {
			return
		}
		resetTimer(nextWait)
	}
}

func (s *Server) tryExchangeDevice(ctx context.Context, deviceCode string) (bool, time.Duration) {
	s.login.mu.Lock()
	if !s.login.active || s.login.deviceCode != deviceCode {
		s.login.mu.Unlock()
		return true, 0
	}
	if s.login.checking {
		wait := time.Duration(s.login.intervalSec)*time.Second + pollJitterBuffer
		s.login.mu.Unlock()
		return false, wait
	}
	s.login.checking = true
	s.login.nextCheckAt = time.Time{}
	checkingSnap := s.loginSnapshotLocked()
	s.login.mu.Unlock()

	s.Emit("account", checkingSnap)

	res, code, err := s.Site.PollDevice(ctx, deviceCode)
	now := time.Now()

	if err != nil {
		// If the poll was canceled locally (user clicked cancel or restarted),
		// don't overwrite the newer state with context.Canceled.
		if ctx.Err() != nil {
			s.login.mu.Lock()
			if s.login.deviceCode == deviceCode {
				s.login.checking = false
			}
			s.login.mu.Unlock()
			return true, 0
		}
		var errSnap map[string]any
		s.login.mu.Lock()
		if s.login.deviceCode == deviceCode {
			s.login.active = false
			s.login.checking = false
			s.login.status = "error"
			s.login.errMsg = err.Error()
			s.login.nextCheckAt = time.Time{}
			errSnap = s.loginSnapshotLocked()
		}
		s.login.mu.Unlock()
		if errSnap != nil {
			s.Emit("account", errSnap)
		}
		return true, 0
	}

	if res == nil {
		var pendingSnap map[string]any
		var nextWait time.Duration
		s.login.mu.Lock()
		if s.login.deviceCode == deviceCode && s.login.active {
			s.login.checking = false
			s.login.pollCount++
			s.login.lastPollAt = now
			if code == "slow_down" {
				// RFC 8628: back off by +5s when server signals slow_down.
				s.login.intervalSec += 5
			}
			nextWait = time.Duration(s.login.intervalSec)*time.Second + pollJitterBuffer
			s.login.nextCheckAt = now.Add(nextWait)
			pendingSnap = s.loginSnapshotLocked()
		}
		s.login.mu.Unlock()
		if pendingSnap != nil {
			s.Emit("account", pendingSnap)
		}
		return false, nextWait
	}

	// Authorization succeeded! Emit immediate "syncing" stage and focus the app
	// window before writing credentials and refreshing account assets.
	var syncingSnap map[string]any
	userCopy := res.User
	s.login.mu.Lock()
	if s.login.deviceCode == deviceCode {
		s.login.checking = false
		s.login.status = "syncing"
		s.login.user = &userCopy
		s.login.nextCheckAt = time.Time{}
		syncingSnap = s.loginSnapshotLocked()
	}
	s.login.mu.Unlock()
	if syncingSnap != nil {
		s.Emit("account", syncingSnap)
	}
	s.Host.ShowMain()

	if err := secrets.Set(secrets.SiteToken, res.Token); err != nil {
		var errSnap map[string]any
		s.login.mu.Lock()
		if s.login.deviceCode == deviceCode {
			s.login.active = false
			s.login.checking = false
			s.login.status = "error"
			s.login.errMsg = "保存令牌到系统凭据库失败：" + err.Error()
			errSnap = s.loginSnapshotLocked()
		}
		s.login.mu.Unlock()
		if errSnap != nil {
			s.Emit("account", errSnap)
		}
		return true, 0
	}
	_ = s.DB.SetKV("account_user", res.User)

	var okSnap map[string]any
	s.login.mu.Lock()
	if s.login.deviceCode == deviceCode {
		if s.login.cancel != nil {
			s.login.cancel()
		}
		s.login.active = false
		s.login.checking = false
		s.login.status = "ok"
		s.login.errMsg = ""
		s.login.nextCheckAt = time.Time{}
		s.login.user = &userCopy
		okSnap = s.loginSnapshotLocked()
	}
	s.login.mu.Unlock()
	if okSnap != nil {
		s.Emit("account", okSnap)
	}
	go func() {
		_, _ = s.syncResourcesInternal(context.Background())
	}()
	return true, 0
}

// HandleDeepLink handles handraw:// URL callbacks from the browser.
func (s *Server) HandleDeepLink(rawURL string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return
	}
	s.Host.ShowMain()
	if u.Host == "auth" || strings.HasPrefix(u.Path, "/auth") {
		s.nudgeLoginPoll()
	}
}

func (s *Server) loginStatus(w http.ResponseWriter, r *http.Request) (any, error) {
	if r.URL.Query().Get("check") == "1" {
		s.nudgeLoginPoll()
	}
	s.login.mu.Lock()
	snap := s.loginSnapshotLocked()
	s.login.mu.Unlock()
	return snap, nil
}

func (s *Server) loginCancel(w http.ResponseWriter, r *http.Request) (any, error) {
	s.login.mu.Lock()
	if s.login.cancel != nil {
		s.login.cancel()
	}
	s.login.active = false
	s.login.checking = false
	s.login.deviceCode = ""
	s.login.userCode = ""
	s.login.verifyURL = ""
	s.login.status = "idle"
	s.login.errMsg = ""
	s.login.nextCheckAt = time.Time{}
	s.login.expiresAt = time.Time{}
	s.login.user = nil
	snap := s.loginSnapshotLocked()
	s.login.mu.Unlock()
	s.Emit("account", snap)
	return snap, nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) (any, error) {
	s.login.mu.Lock()
	if s.login.cancel != nil {
		s.login.cancel()
	}
	s.login.active = false
	s.login.checking = false
	s.login.deviceCode = ""
	s.login.userCode = ""
	s.login.verifyURL = ""
	s.login.status = "idle"
	s.login.errMsg = ""
	s.login.nextCheckAt = time.Time{}
	s.login.expiresAt = time.Time{}
	s.login.user = nil
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
	ecoCtx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	raw, err := s.Site.Economy(ecoCtx)
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
		WorkID  string   `json:"workId"`
		WorkURL string   `json:"workUrl"`
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
	pubWID := strings.TrimSpace(body.WorkID)
	pubURL := strings.TrimSpace(body.WorkURL)
	if pubWID != "" && pubURL == "" && s.Site != nil {
		pubURL = strings.TrimRight(s.Site.Base(), "/") + "/t/work-" + pubWID
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
		PublishedWorkID: pubWID,
		PublishedURL:    pubURL,
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
