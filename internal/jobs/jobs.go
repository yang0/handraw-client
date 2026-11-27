// Package jobs runs image generations in the background, saves results to
// the works folder and indexes them. Site-model jobs keep their requestId so
// a restart resumes them by lookup instead of paying twice.
package jobs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Event is pushed to the UI.
type Event struct {
	Type    string `json:"type"` // image | run | balance
	RunID   string `json:"runId"`
	ImageID string `json:"imageId,omitempty"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

// Spec is everything needed to generate one image; stored in image meta.
type Spec struct {
	ModelRef   string            `json:"modelRef"` // site:<id> | <providerId>:<modelId>
	Prompt     string            `json:"prompt"`
	Ratio      string            `json:"ratio"`
	Resolution string            `json:"resolution,omitempty"`
	Quality    string            `json:"quality,omitempty"`
	Refs       []string          `json:"refs,omitempty"` // local file paths or pack image paths
	Mask       string            `json:"mask,omitempty"`
	SiteBody   map[string]any    `json:"siteBody,omitempty"`
	RequestID  string            `json:"requestId,omitempty"`
	QuoteID    string            `json:"quoteId,omitempty"`
	QuoteIndex int               `json:"quoteIndex,omitempty"`
	Extra      map[string]string `json:"extra,omitempty"`
}

// DefaultWorkers is the default concurrent image generation limit (#154).
const DefaultWorkers = 5

type Manager struct {
	DB              *store.DB
	Site            *site.Client
	Emit            func(Event)
	PluginProviders func() []settings.Provider
	// Overridable timings for tests (zero uses defaults).
	BusyRetryBase time.Duration
	BusyRetryMax  time.Duration
	MaxBusyWait   time.Duration
	SiteConfigTTL time.Duration

	queue           chan string
	mu              sync.Mutex
	workers         int
	running         map[string]context.CancelFunc
	waiting         map[string]context.CancelFunc
	siteInFlight    int
	sitePending     []string
	siteCfgMu       sync.Mutex
	siteMaxInflight int
	siteCfgAt       time.Time
	busyAttempts    map[string]int
	busyFirstAt     map[string]time.Time
	canceled        map[string]bool // user-canceled ids; guards against resurrection (#167)
	slotSignal      chan struct{}
	runCtx          context.Context
	wg              sync.WaitGroup
}

func New(db *store.DB, sc *site.Client, emit func(Event)) *Manager {
	if emit == nil {
		emit = func(Event) {}
	}
	return &Manager{
		DB:           db,
		Site:         sc,
		Emit:         emit,
		queue:        make(chan string, 1024),
		workers:      DefaultWorkers,
		running:      map[string]context.CancelFunc{},
		waiting:      map[string]context.CancelFunc{},
		busyAttempts: map[string]int{},
		busyFirstAt:  map[string]time.Time{},
		canceled:     map[string]bool{},
		slotSignal:   make(chan struct{}),
	}
}

// Start launches workers and resumes unfinished images.
func (m *Manager) Start(ctx context.Context, workers int) {
	if workers <= 0 {
		workers = DefaultWorkers
	}
	m.mu.Lock()
	m.workers = workers
	m.runCtx = ctx
	m.mu.Unlock()
	for i := 0; i < workers; i++ {
		m.wg.Add(1)
		go m.worker(ctx)
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		active, _ := m.DB.ActiveImages()
		for _, im := range active {
			if ctx.Err() != nil {
				return
			}
			m.Enqueue(im.ID)
		}
	}()
}

func (m *Manager) Enqueue(imageID string) { m.enqueueAsync(imageID) }

// Wait blocks until all workers have exited after the Start context is
// canceled, so callers (tests, shutdown) know no job is still writing files.
func (m *Manager) Wait() { m.wg.Wait() }

func (m *Manager) enqueueAsync(imageID string) {
	m.mu.Lock()
	ctx := m.runCtx
	m.mu.Unlock()
	if ctx != nil && ctx.Err() != nil {
		return
	}
	select {
	case m.queue <- imageID:
	default:
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			if ctx == nil {
				select {
				case m.queue <- imageID:
				case <-time.After(30 * time.Second):
				}
				return
			}
			select {
			case m.queue <- imageID:
			case <-ctx.Done():
			}
		}()
	}
}

// Active reports how many images are queued or running.
func (m *Manager) Active() int {
	a, _ := m.DB.ActiveImages()
	return len(a)
}

// Cancel stops a queued or running image. A site job already submitted
// keeps running on the site; its result is still collected later.
func (m *Manager) Cancel(imageID string) error {
	im, err := m.DB.GetImage(imageID)
	if err != nil {
		return err
	}
	if im.Status != "queued" && im.Status != "running" {
		return nil
	}
	accepted := im.Status == "running" && im.RemoteTaskID != ""
	m.mu.Lock()
	cancel := m.running[imageID]
	waitCancel := m.waiting[imageID]
	delete(m.waiting, imageID)
	m.removeSitePendingLocked(imageID)
	delete(m.busyAttempts, imageID)
	delete(m.busyFirstAt, imageID)
	if !accepted {
		// Set under the same lock process() uses to register, so a worker that
		// already picked the id up cannot start or requeue it afterwards.
		m.canceled[imageID] = true
	}
	m.mu.Unlock()
	if accepted {
		return errors.New("网站已受理该任务，无法取消；结果完成后仍会保存")
	}
	if waitCancel != nil {
		waitCancel()
	}
	if cancel != nil {
		cancel()
	}
	_ = m.DB.UpdateImage(imageID, map[string]any{"status": "canceled"})
	m.refreshRun(im.RunID)
	m.Emit(Event{Type: "image", RunID: im.RunID, ImageID: imageID, Status: "canceled"})
	return nil
}

func (m *Manager) worker(ctx context.Context) {
	defer m.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-m.queue:
			m.process(ctx, id)
		}
	}
}

func (m *Manager) removeSitePendingLocked(imageID string) {
	for i, id := range m.sitePending {
		if id == imageID {
			m.sitePending = append(m.sitePending[:i], m.sitePending[i+1:]...)
			return
		}
	}
}

func (m *Manager) hasSitePendingLocked(imageID string) bool {
	for _, id := range m.sitePending {
		if id == imageID {
			return true
		}
	}
	return false
}

func (m *Manager) notifySlotFreedLocked() {
	if m.slotSignal != nil {
		close(m.slotSignal)
		m.slotSignal = make(chan struct{})
	}
}

func (m *Manager) clearBusyState(imageID string) {
	m.mu.Lock()
	delete(m.busyAttempts, imageID)
	delete(m.busyFirstAt, imageID)
	if wc := m.waiting[imageID]; wc != nil {
		delete(m.waiting, imageID)
		wc()
	}
	m.mu.Unlock()
}

func (m *Manager) busyBaseDelay() time.Duration {
	if m.BusyRetryBase > 0 {
		return m.BusyRetryBase
	}
	return 2 * time.Second
}

func (m *Manager) busyMaxDelay() time.Duration {
	if m.BusyRetryMax > 0 {
		return m.BusyRetryMax
	}
	return 8 * time.Second
}

func (m *Manager) maxBusyWait() time.Duration {
	if m.MaxBusyWait > 0 {
		return m.MaxBusyWait
	}
	return 15 * time.Minute
}

// effectiveSiteLimit fetches and caches /api/studio/config.maxInflightPerUser
// so desktop batches stay within the site's per-user inflight cap and keep
// excess items cleanly queued instead of self-triggering HTTP 429 (#154).
func (m *Manager) effectiveSiteLimit(ctx context.Context) int {
	m.mu.Lock()
	limit := m.workers
	m.mu.Unlock()
	if limit <= 0 {
		limit = DefaultWorkers
	}
	if m.Site == nil {
		return limit
	}
	ttl := m.SiteConfigTTL
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	m.siteCfgMu.Lock()
	defer m.siteCfgMu.Unlock()

	m.mu.Lock()
	cached := m.siteMaxInflight
	fresh := !m.siteCfgAt.IsZero() && time.Since(m.siteCfgAt) < ttl
	m.mu.Unlock()
	if !fresh {
		cfgCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		cfg, err := m.Site.StudioConfig(cfgCtx)
		cancel()
		m.mu.Lock()
		if err == nil {
			m.siteMaxInflight = cfg.MaxInflightPerUser
			cached = cfg.MaxInflightPerUser
		}
		m.siteCfgAt = time.Now()
		m.mu.Unlock()
	}
	if cached > 0 && cached < limit {
		return cached
	}
	return limit
}

func (m *Manager) releaseSiteSlot(parent context.Context, serverSlotFreed bool) {
	var nextNow string
	var nextDelayed string
	m.mu.Lock()
	if m.siteInFlight > 0 {
		m.siteInFlight--
	}
	if serverSlotFreed {
		if len(m.sitePending) > 0 {
			nextNow = m.sitePending[0]
			m.sitePending = m.sitePending[1:]
		}
		m.notifySlotFreedLocked()
	} else if m.siteInFlight == 0 && len(m.sitePending) > 0 {
		nextDelayed = m.sitePending[0]
		m.sitePending = m.sitePending[1:]
	}
	m.mu.Unlock()
	if nextNow != "" {
		m.enqueueAsync(nextNow)
	}
	if nextDelayed != "" {
		m.scheduleBusyRetry(parent, nextDelayed, 1)
	}
}

func isConcurrencyBusyError(isSite bool, err error) bool {
	if err == nil {
		return false
	}
	if isSite {
		var ae *site.APIError
		if errors.As(err, &ae) {
			code := strings.ToLower(strings.TrimSpace(ae.Code))
			switch code {
			case "generation_in_progress", "global_generation_busy":
				return true
			case "free_concurrency_limited":
				// Single-item desktop requests only hit free_concurrency_limited
				// when another free image is currently in flight; waiting frees a slot.
				msg := ae.Message
				return strings.Contains(msg, "当前已有") || strings.Contains(msg, "等待") || strings.Contains(msg, "进行中")
			case "quota_daily_limit_reached", "insufficient_balance", "insufficient_quota":
				return false
			}
			if ae.Status == 429 {
				low := strings.ToLower(ae.Message)
				if strings.Contains(low, "余额") || strings.Contains(low, "次日") || strings.Contains(low, "今日免费") || strings.Contains(low, "insufficient") {
					return false
				}
				return true
			}
		}
		return false
	}
	var pe *providers.APIError
	if errors.As(err, &pe) && pe.Status == 429 {
		low := strings.ToLower(pe.Code + " " + pe.Message)
		for _, perm := range []string{"insufficient_quota", "billing", "余额不足", "配额用尽", "credit", "quota_exceeded", "exceeded your current quota"} {
			if strings.Contains(low, perm) {
				return false
			}
		}
		return true
	}
	return false
}

func (m *Manager) recordBusyAttempt(imageID string) (int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	first, ok := m.busyFirstAt[imageID]
	if !ok {
		first = now
		m.busyFirstAt[imageID] = first
	}
	if now.Sub(first) >= m.maxBusyWait() {
		return 0, false
	}
	m.busyAttempts[imageID]++
	return m.busyAttempts[imageID], true
}

func (m *Manager) scheduleBusyRetry(parent context.Context, imageID string, attempt int) {
	base := m.busyBaseDelay()
	maxD := m.busyMaxDelay()
	delay := base * time.Duration(attempt)
	if delay < base {
		delay = base
	}
	if delay > maxD {
		delay = maxD
	}
	settle := base / 8
	if settle > 250*time.Millisecond {
		settle = 250 * time.Millisecond
	}
	if settle < 10*time.Millisecond {
		settle = 10 * time.Millisecond
	}

	waitCtx, waitCancel := context.WithCancel(parent)
	m.mu.Lock()
	if prev := m.waiting[imageID]; prev != nil {
		prev()
	}
	m.waiting[imageID] = waitCancel
	sig := m.slotSignal
	m.mu.Unlock()

	go func() {
		defer func() {
			waitCancel()
			m.mu.Lock()
			delete(m.waiting, imageID)
			m.mu.Unlock()
		}()
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-waitCtx.Done():
			return
		case <-timer.C:
		case <-sig:
			select {
			case <-waitCtx.Done():
				return
			case <-time.After(settle):
			}
		}
		if waitCtx.Err() != nil {
			return
		}
		im, err := m.DB.GetImage(imageID)
		if err != nil || im.Status != "queued" || m.isCanceled(imageID) {
			return
		}
		m.enqueueAsync(imageID)
	}()
}

func (m *Manager) isCanceled(imageID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.canceled[imageID]
}

func (m *Manager) process(parent context.Context, imageID string) {
	im, err := m.DB.GetImage(imageID)
	if err != nil || (im.Status != "queued" && im.Status != "running") {
		return
	}
	var spec Spec
	if err := json.Unmarshal(im.Meta, &spec); err != nil {
		m.fail(im, "任务参数损坏")
		return
	}
	isSite := strings.HasPrefix(spec.ModelRef, "site:")
	requeuedBusy := false

	if isSite {
		siteLimit := m.effectiveSiteLimit(parent)
		m.mu.Lock()
		if _, dup := m.running[imageID]; dup {
			m.mu.Unlock()
			return
		}
		if m.siteInFlight >= siteLimit {
			if !m.hasSitePendingLocked(imageID) {
				m.sitePending = append(m.sitePending, imageID)
			}
			m.mu.Unlock()
			return
		}
		m.siteInFlight++
		m.mu.Unlock()
		defer func() {
			m.releaseSiteSlot(parent, !requeuedBusy)
		}()
	}

	ctx, cancel := context.WithCancel(parent)
	m.mu.Lock()
	if _, dup := m.running[imageID]; dup || m.canceled[imageID] {
		m.mu.Unlock()
		cancel()
		return
	}
	if wc := m.waiting[imageID]; wc != nil {
		delete(m.waiting, imageID)
		wc()
	}
	m.running[imageID] = cancel
	m.mu.Unlock()
	defer func() {
		cancel()
		m.mu.Lock()
		delete(m.running, imageID)
		if !isSite && !requeuedBusy {
			m.notifySlotFreedLocked()
		}
		m.mu.Unlock()
	}()
	_ = m.DB.UpdateImage(imageID, map[string]any{"status": "running", "error": ""})
	m.DB.UpdateRun(im.RunID, map[string]any{"status": "running"})
	m.Emit(Event{Type: "image", RunID: im.RunID, ImageID: imageID, Status: "running"})

	var data []byte
	var cost int
	if isSite {
		data, cost, err = m.runSite(ctx, im, spec)
	} else {
		data, err = m.runProvider(ctx, spec)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil || m.isCanceled(imageID) {
			// Canceled while the request was in flight: keep the canceled
			// status instead of requeueing or marking failed (#167).
			return
		}
		if isConcurrencyBusyError(isSite, err) {
			if attempt, ok := m.recordBusyAttempt(imageID); ok {
				requeuedBusy = true
				if isSite {
					m.mu.Lock()
					m.siteCfgAt = time.Time{}
					m.mu.Unlock()
				}
				_ = m.DB.UpdateImage(imageID, map[string]any{"status": "queued", "error": "", "remote_task_id": ""})
				m.refreshRun(im.RunID)
				m.Emit(Event{Type: "image", RunID: im.RunID, ImageID: imageID, Status: "queued"})
				m.scheduleBusyRetry(parent, imageID, attempt)
				return
			}
		}
		m.clearBusyState(imageID)
		m.fail(im, err.Error())
		return
	}
	if err := m.save(im, data, cost); err != nil {
		m.clearBusyState(imageID)
		m.fail(im, "保存图片失败："+err.Error())
		return
	}
	m.clearBusyState(imageID)
	m.refreshRun(im.RunID)
	m.Emit(Event{Type: "image", RunID: im.RunID, ImageID: imageID, Status: "done"})
	if isSite {
		m.Emit(Event{Type: "balance"})
	}
}

func (m *Manager) fail(im store.Image, msg string) {
	_ = m.DB.UpdateImage(im.ID, map[string]any{"status": "failed", "error": msg})
	m.refreshRun(im.RunID)
	m.Emit(Event{Type: "image", RunID: im.RunID, ImageID: im.ID, Status: "failed", Error: msg})
}

func (m *Manager) runProvider(ctx context.Context, spec Spec) ([]byte, error) {
	pid, model, ok := strings.Cut(spec.ModelRef, ":")
	if !ok {
		return nil, fmt.Errorf("未知模型 %s", spec.ModelRef)
	}
	var prov *settings.Provider
	allProvs := settings.Get().Providers
	if m.PluginProviders != nil {
		allProvs = append(allProvs, m.PluginProviders()...)
	}
	for _, p := range allProvs {
		if p.ID == pid {
			p := p
			prov = &p
		}
	}
	if prov == nil {
		return nil, fmt.Errorf("接口 %s 已被删除", pid)
	}
	req := providers.ImageRequest{Model: model, Prompt: spec.Prompt, Size: providers.SizeForRatio(spec.Ratio), Quality: spec.Quality, N: 1}
	for _, sz := range modelSizes(*prov, model) {
		if sz != "" {
			req.Size = pickSize(sz, spec.Ratio, req.Size)
		}
	}
	for _, r := range spec.Refs {
		b, err := os.ReadFile(r)
		if err != nil {
			return nil, fmt.Errorf("读取参考图失败：%w", err)
		}
		req.Refs = append(req.Refs, providers.RefImage{Name: filepath.Base(r), Data: b})
	}
	if spec.Mask != "" {
		b, err := os.ReadFile(spec.Mask)
		if err == nil {
			req.Mask = &providers.RefImage{Name: "mask.png", Data: b, Mime: "image/png"}
		}
	}
	imgs, err := providers.GenerateImage(ctx, *prov, req)
	if err != nil {
		return nil, err
	}
	if imgs[0].Data != nil {
		return imgs[0].Data, nil
	}
	return providers.Download(ctx, imgs[0].URL)
}

func modelSizes(p settings.Provider, model string) []string {
	for _, m := range p.Models {
		if m.ID == model {
			return m.Sizes
		}
	}
	return nil
}

// pickSize keeps the default unless the model lists sizes; then picks the
// first listed size with the same orientation.
func pickSize(listed, ratio, def string) string {
	want := "square"
	switch providers.SizeForRatio(ratio) {
	case "1024x1536":
		want = "portrait"
	case "1536x1024":
		want = "landscape"
	}
	var w, h int
	if _, err := fmt.Sscanf(listed, "%dx%d", &w, &h); err != nil {
		return def
	}
	orient := "square"
	if h > w {
		orient = "portrait"
	} else if w > h {
		orient = "landscape"
	}
	if orient == want {
		return listed
	}
	return def
}

func strFromMap(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[key].(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	}
	return ""
}

// requoteSiteItem fetches a fresh single-item quote from the website for a
// retried or quote-expired site generation (#64).
func (m *Manager) requoteSiteItem(ctx context.Context, im store.Image, spec *Spec, body map[string]any) error {
	rawModel := firstNonEmptyStr(strFromMap(body, "model"), strings.TrimPrefix(spec.ModelRef, "site:"))
	qItem := map[string]any{
		"model":      rawModel,
		"resolution": firstNonEmptyStr(spec.Resolution, strFromMap(body, "resolution"), "1k"),
		"quality":    firstNonEmptyStr(spec.Quality, strFromMap(body, "quality"), "standard"),
		"ratio":      firstNonEmptyStr(spec.Ratio, strFromMap(body, "ratio"), "3:4"),
		"count":      1,
	}
	if sid := strFromMap(body, "specId"); sid != "" {
		qItem["specId"] = sid
	}
	rawQ, err := m.Site.Quote(ctx, []map[string]any{qItem})
	if err != nil {
		return fmt.Errorf("重试获取报价失败：%w", err)
	}
	var q struct {
		QuoteID string `json:"quoteId"`
	}
	if err := json.Unmarshal(rawQ, &q); err != nil || strings.TrimSpace(q.QuoteID) == "" {
		return errors.New("重试获取报价失败：网站未返回有效 quoteId")
	}
	spec.QuoteID = strings.TrimSpace(q.QuoteID)
	spec.QuoteIndex = 0
	body["quoteId"] = spec.QuoteID
	body["quoteIndex"] = 0
	if meta, err := json.Marshal(spec); err == nil {
		_ = m.DB.UpdateImage(im.ID, map[string]any{"meta": json.RawMessage(meta)})
	}
	return nil
}

func sniffRefMime(raw []byte) string {
	switch {
	case bytes.HasPrefix(raw, []byte{0x89, 'P', 'N', 'G'}):
		return "image/png"
	case bytes.HasPrefix(raw, []byte{0xFF, 0xD8}):
		return "image/jpeg"
	case len(raw) > 12 && string(raw[0:4]) == "RIFF" && string(raw[8:12]) == "WEBP":
		return "image/webp"
	case bytes.HasPrefix(raw, []byte("GIF8")):
		return "image/gif"
	}
	return ""
}

// encodeSiteRefDataURL encodes a local reference image as a compact data URL
// accepted by handraw-web's /api/studio/generate refImages field (#67).
func encodeSiteRefDataURL(refPath string) (string, error) {
	refPath = strings.TrimSpace(refPath)
	if refPath == "" {
		return "", nil
	}
	if strings.HasPrefix(refPath, "data:image/") || strings.HasPrefix(refPath, "http://") || strings.HasPrefix(refPath, "https://") || strings.HasPrefix(refPath, "/images/") {
		return refPath, nil
	}
	raw, err := os.ReadFile(refPath)
	if err != nil {
		return "", fmt.Errorf("读取参考图失败：%w", err)
	}
	mime := sniffRefMime(raw)
	// Re-encode oversized files (>2 MiB) or unknown formats to <=1600px JPEG so
	// multi-reference edit uploads stay well below web proxy payload limits.
	if mime == "" || len(raw) > 2<<20 {
		if src, _, dErr := image.Decode(bytes.NewReader(raw)); dErr == nil {
			b := src.Bounds()
			w, h := b.Dx(), b.Dy()
			const maxEdge = 1600
			if w > maxEdge || h > maxEdge {
				if w >= h {
					h = h * maxEdge / w
					w = maxEdge
				} else {
					w = w * maxEdge / h
					h = maxEdge
				}
			}
			dst := image.NewRGBA(image.Rect(0, 0, w, h))
			draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
			var buf bytes.Buffer
			if eErr := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 88}); eErr == nil {
				raw = buf.Bytes()
				mime = "image/jpeg"
			}
		}
	}
	if mime == "" {
		mime = "image/png"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func isTransientSiteError(err error) bool {
	if err == nil {
		return false
	}
	var ae *site.APIError
	if errors.As(err, &ae) {
		switch ae.Status {
		case 502, 503, 504, 520, 521, 522, 523, 524:
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "cloudflare") ||
		strings.Contains(msg, "origin web server") ||
		strings.Contains(msg, "unexpected eof") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "timeout")
}

func isInsufficientCashError(err error) bool {
	if err == nil {
		return false
	}
	var ae *site.APIError
	if errors.As(err, &ae) && strings.EqualFold(strings.TrimSpace(ae.Code), "insufficient_cash") {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "通用人民币余额不足") || strings.Contains(strings.ToLower(msg), "insufficient_cash")
}

// ProbeSiteEconomy1k queries /api/economy with a short timeout to read the
// signed-in user's usable 1K free quota and whether they hold AI bonus credit (#190).
func ProbeSiteEconomy1k(ctx context.Context, sc *site.Client) (free1k int, hasBonus bool, known bool) {
	if sc == nil || !sc.LoggedIn() {
		return 0, false, false
	}
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	raw, err := sc.Economy(probeCtx)
	if err != nil || len(raw) == 0 {
		return 0, false, false
	}
	var eco struct {
		FreeQuota []struct {
			Resolution      string `json:"resolution"`
			Remaining       int    `json:"remaining"`
			UsableRemaining *int   `json:"usableRemaining"`
		} `json:"freeQuota"`
		AIBonus *struct {
			BalanceMicros   int64 `json:"balanceMicros"`
			AvailableMicros int64 `json:"availableMicros"`
		} `json:"aiBonus"`
	}
	if json.Unmarshal(raw, &eco) != nil {
		return 0, false, false
	}
	if eco.AIBonus != nil && (eco.AIBonus.AvailableMicros > 0 || eco.AIBonus.BalanceMicros > 0) {
		hasBonus = true
	}
	for _, q := range eco.FreeQuota {
		if strings.EqualFold(strings.TrimSpace(q.Resolution), "1k") {
			known = true
			if q.UsableRemaining != nil {
				free1k = *q.UsableRemaining
			} else {
				free1k = q.Remaining
			}
			break
		}
	}
	return free1k, hasBonus, known
}

// FormatInsufficientCashError builds an actionable Chinese message explaining
// why generation failed when cash balance is insufficient — especially when
// the user selected 2K/4K while 1K free quota is still available (#190).
func FormatInsufficientCashError(resolution string, totalCents, balanceCents int, free1k int, free1kKnown, hasBonus, dailyCapReached bool) string {
	res := strings.ToLower(strings.TrimSpace(resolution))
	resUpper := strings.ToUpper(res)
	amountNote := ""
	if totalCents > 0 {
		amountNote = fmt.Sprintf("（本次需 ¥%.2f，当前可用现金 ¥%.2f）", float64(totalCents)/100, float64(balanceCents)/100)
	}
	bonusNote := ""
	if hasBonus {
		bonusNote = "，账户内赠金仅用于文字/视觉 AI，不可抵扣生图"
	}
	if res != "" && res != "1k" {
		if free1kKnown && free1k > 0 {
			return fmt.Sprintf("生图现金余额不足%s：因为你选择了 %s 清晰度（付费档位%s）。你当前还有 %d 张 1K 免费生图额度，切回 1K 清晰度即可免费使用，或先充值后再出 %s。", amountNote, resUpper, bonusNote, free1k, resUpper)
		}
		return fmt.Sprintf("生图现金余额不足%s：因为你选择了 %s 清晰度（付费档位%s）。如果账号还有 1K 免费生图额度，切回 1K 清晰度仍可免费使用，或先充值后再出 %s。", amountNote, resUpper, bonusNote, resUpper)
	}
	if dailyCapReached {
		return fmt.Sprintf("今日 1K 免费生图额度已达 24 小时上限，继续生图需消耗现金余额%s%s；请等待次日免费额度恢复，或先充值。", amountNote, bonusNote)
	}
	return fmt.Sprintf("生图现金余额不足%s%s，请先充值后再试。", amountNote, bonusNote)
}

func friendlySiteError(ctx context.Context, sc *site.Client, spec Spec, err error) error {
	if err == nil {
		return nil
	}
	if isInsufficientCashError(err) {
		res := firstNonEmptyStr(spec.Resolution, strFromMap(spec.SiteBody, "resolution"), "1k")
		free1k, hasBonus, known := ProbeSiteEconomy1k(ctx, sc)
		return errors.New(FormatInsufficientCashError(res, 0, 0, free1k, known, hasBonus, false))
	}
	msg := err.Error()
	low := strings.ToLower(msg)
	if strings.Contains(low, "cloudflare") || strings.Contains(low, "origin web server") {
		var ae *site.APIError
		code := 520
		if errors.As(err, &ae) && ae.Status >= 500 {
			code = ae.Status
		}
		return fmt.Errorf("网站上游响应中断（Cloudflare %d），已自动尝试恢复与重试仍未成功；通常是服务临时波动，请稍后重试（未出图不会重复扣费）", code)
	}
	return err
}

func (m *Manager) runSite(ctx context.Context, im store.Image, spec Spec) ([]byte, int, error) {
	body := map[string]any{}
	for k, v := range spec.SiteBody {
		body[k] = v
	}
	body["requestId"] = spec.RequestID
	body["clientRequestId"] = spec.RequestID
	body["source"] = "client"
	if settings.Get().KeepSiteGenerationsPrivate || len(spec.Refs) > 0 {
		body["visibility"] = "private"
	}
	if len(spec.Refs) > 0 {
		refURLs := make([]string, 0, len(spec.Refs))
		seen := map[string]bool{}
		for _, rp := range spec.Refs {
			if len(refURLs) >= 6 {
				break
			}
			rp = strings.TrimSpace(rp)
			if rp == "" || seen[rp] {
				continue
			}
			seen[rp] = true
			dataURL, rErr := encodeSiteRefDataURL(rp)
			if rErr != nil {
				return nil, 0, rErr
			}
			if dataURL != "" {
				refURLs = append(refURLs, dataURL)
			}
		}
		if len(refURLs) > 0 {
			body["refImages"] = refURLs
		}
	}
	requoted := false
	if spec.QuoteID != "" {
		body["quoteId"] = spec.QuoteID
		body["quoteIndex"] = spec.QuoteIndex
	}
	var res site.GenerateResult
	var err error
	// Resume: an image that was submitted before a restart is looked up first.
	if im.RemoteTaskID != "" || im.Status == "running" {
		res, err = m.Site.Task(ctx, im.RemoteTaskID, spec.RequestID)
		if err != nil {
			var ae *site.APIError
			if errors.As(err, &ae) && ae.Status == 404 {
				err = nil
				res = site.GenerateResult{}
			} else {
				return nil, 0, err
			}
		}
	}
	if res.Status == "" {
		if spec.QuoteID == "" {
			if qErr := m.requoteSiteItem(ctx, im, &spec, body); qErr != nil {
				return nil, 0, qErr
			}
			requoted = true
		}
		res, err = m.Site.Generate(ctx, body)
		if err != nil && !requoted {
			var ae *site.APIError
			if errors.As(err, &ae) && (ae.Code == "quote_expired" || ae.Code == "quote_required") {
				if qErr := m.requoteSiteItem(ctx, im, &spec, body); qErr == nil {
					res, err = m.Site.Generate(ctx, body)
				}
			}
		}
		// Recover from transient Cloudflare 520/5xx or dropped connections (#77):
		// first probe the idempotent requestId via Task (in case the server already
		// created/finished the image), and if 404 retry Generate once with the same requestId.
		if err != nil && isTransientSiteError(err) {
			select {
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			case <-time.After(1500 * time.Millisecond):
			}
			tRes, tErr := m.Site.Task(ctx, "", spec.RequestID)
			if tErr == nil && tRes.Status != "" {
				res, err = tRes, nil
			} else {
				var tae *site.APIError
				if tErr == nil || (errors.As(tErr, &tae) && tae.Status == 404) {
					rRetry, retryErr := m.Site.Generate(ctx, body)
					if retryErr == nil {
						res, err = rRetry, nil
					} else {
						err = retryErr
						if isTransientSiteError(retryErr) {
							if tRes2, tErr2 := m.Site.Task(ctx, "", spec.RequestID); tErr2 == nil && tRes2.Status != "" {
								res, err = tRes2, nil
							}
						}
					}
				}
			}
		}
		if err != nil {
			return nil, 0, friendlySiteError(ctx, m.Site, spec, err)
		}
	}
	if res.TaskID != "" {
		_ = m.DB.UpdateImage(im.ID, map[string]any{"remote_task_id": res.TaskID})
	}
	deadline := time.Now().Add(10 * time.Minute)
	for !done(res.Status) {
		if time.Now().After(deadline) {
			return nil, 0, errors.New("网站生成超时；稍后重启客户端会继续查询结果，不会重复扣费")
		}
		select {
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		case <-time.After(3 * time.Second):
		}
		r2, err := m.Site.Task(ctx, res.TaskID, spec.RequestID)
		if err != nil {
			continue
		}
		if r2.Status != "" {
			res.Status, res.Images, res.Error = r2.Status, r2.Images, r2.Error
			if r2.GenID != "" {
				res.GenID = r2.GenID
			}
			if r2.WorkID != "" {
				res.WorkID = r2.WorkID
				res.WorkURL = r2.WorkURL
				res.WorkPrice = r2.WorkPrice
			}
		}
	}
	if !success(res.Status) || len(res.Images) == 0 {
		msg := res.Error
		if msg == "" {
			msg = "网站生成失败（" + res.Status + "），费用会自动退还"
		}
		return nil, 0, errors.New(msg)
	}
	data, _, err := m.Site.Fetch(ctx, res.Images[0])
	if err != nil {
		return nil, 0, fmt.Errorf("下载网站生成的图片失败：%w", err)
	}
	if res.FinalPrompt != "" {
		_ = m.DB.UpdateImage(im.ID, map[string]any{"prompt": res.FinalPrompt})
	}
	runFields := map[string]any{}
	if rem := firstNonEmptyStr(res.GenID, res.TaskID); rem != "" {
		runFields["remote_run_id"] = rem
	}
	if res.WorkID != "" {
		workURL := firstNonEmptyStr(res.WorkURL, strings.TrimRight(m.Site.Base(), "/")+"/t/work-"+res.WorkID)
		runFields["published_work_id"] = res.WorkID
		runFields["published_url"] = workURL
		defer func(rid string) {
			if m.Emit != nil {
				m.Emit(Event{Type: "work_published", RunID: rid, Status: "published"})
			}
		}(im.RunID)
	}
	if len(runFields) > 0 {
		_ = m.DB.UpdateRun(im.RunID, runFields)
	}
	return data, res.AmountCents, nil
}

func done(s string) bool {
	switch strings.ToLower(s) {
	case "success", "succeeded", "done", "completed", "failed", "error", "refunded", "cancelled", "canceled":
		return true
	}
	return false
}

func success(s string) bool {
	switch strings.ToLower(s) {
	case "success", "succeeded", "done", "completed":
		return true
	}
	return false
}

// save writes the original and a thumbnail next to run.json.
func (m *Manager) save(im store.Image, data []byte, cost int) error {
	run, err := m.DB.GetRun(im.RunID)
	if err != nil {
		return err
	}
	dir := run.Dir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ext := sniffExt(data)
	name := fmt.Sprintf("%02d%s", im.Idx+1, ext)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	w, h := 0, 0
	thumb := ""
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		w, h = cfg.Width, cfg.Height
	}
	if t, err := makeThumb(data, 480); err == nil {
		tp := filepath.Join(dir, ".thumbs", fmt.Sprintf("%02d.jpg", im.Idx+1))
		_ = os.MkdirAll(filepath.Dir(tp), 0o755)
		if os.WriteFile(tp, t, 0o644) == nil {
			thumb = tp
		}
	}
	if err := m.DB.UpdateImage(im.ID, map[string]any{"status": "done", "path": path, "thumb": thumb, "width": w, "height": h,
		"sha256": hex.EncodeToString(sum[:]), "cost_cents": cost, "error": ""}); err != nil {
		return err
	}
	return WriteRunJSON(m.DB, im.RunID)
}

func sniffExt(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0x89, 'P', 'N', 'G'}):
		return ".png"
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8}):
		return ".jpg"
	case len(b) > 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return ".webp"
	case bytes.HasPrefix(b, []byte("GIF8")):
		return ".gif"
	}
	return ".png"
}

func makeThumb(data []byte, max int) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > max || h > max {
		if w >= h {
			h = h * max / w
			w = max
		} else {
			w = w * max / h
			h = max
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	var out bytes.Buffer
	err = jpeg.Encode(&out, dst, &jpeg.Options{Quality: 82})
	return out.Bytes(), err
}

// refreshRun recomputes a run's status and cost from its images.
func (m *Manager) refreshRun(runID string) {
	imgs, err := m.DB.Images(runID)
	if err != nil {
		return
	}
	counts := map[string]int{}
	cost := 0
	for _, im := range imgs {
		counts[im.Status]++
		cost += im.CostCents
	}
	status := "done"
	switch {
	case counts["queued"]+counts["running"] > 0:
		status = "running"
	case counts["done"] == len(imgs):
		status = "done"
	case counts["done"] > 0:
		status = "partial"
	case counts["canceled"] == len(imgs):
		status = "canceled"
	default:
		status = "failed"
	}
	_ = m.DB.UpdateRun(runID, map[string]any{"status": status, "cost_cents": cost})
	m.Emit(Event{Type: "run", RunID: runID, Status: status})
}

// Retry requeues a failed or canceled image with a fresh request id.
func (m *Manager) Retry(imageID string) error {
	im, err := m.DB.GetImage(imageID)
	if err != nil {
		return err
	}
	if im.Status != "failed" && im.Status != "canceled" {
		return errors.New("只能重试失败或已取消的图片")
	}
	var spec Spec
	_ = json.Unmarshal(im.Meta, &spec)
	spec.RequestID = NewID("req")
	spec.QuoteID = "" // quotes expire; runSite fetches a fresh quote automatically (#64)
	spec.QuoteIndex = 0
	meta, _ := json.Marshal(spec)
	if err := m.DB.UpdateImage(imageID, map[string]any{"status": "queued", "error": "", "remote_task_id": "", "meta": json.RawMessage(meta)}); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.canceled, imageID)
	m.mu.Unlock()
	m.refreshRun(im.RunID)
	m.Enqueue(imageID)
	return nil
}

// WriteRunJSON writes run.json beside the images so the folder is self-describing.
func WriteRunJSON(db *store.DB, runID string) error {
	run, err := db.GetRun(runID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(run.Dir) == "" {
		// No folder of its own (e.g. imported records): never fall back to the
		// process working directory (#167).
		return nil
	}
	type img struct {
		File   string `json:"file"`
		Theme  string `json:"theme,omitempty"`
		Prompt string `json:"prompt,omitempty"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
		SHA256 string `json:"sha256"`
	}
	out := map[string]any{
		"id": run.ID, "createdAt": run.CreatedAt, "mode": run.Mode, "title": run.Title,
		"originalRequest": run.OriginalRequest, "promptZh": run.PromptZh, "promptEn": run.PromptEn,
		"recipe": run.Recipe, "model": run.Model, "modelLabel": run.ModelLabel, "costCents": run.CostCents,
		"publishedUrl": run.PublishedURL, "app": "handraw-client",
	}
	var imgs []img
	for _, im := range run.Images {
		if im.Status == "done" {
			imgs = append(imgs, img{File: filepath.Base(im.Path), Theme: im.Theme, Prompt: im.Prompt, Width: im.Width, Height: im.Height, SHA256: im.SHA256})
		}
	}
	out["images"] = imgs
	b, _ := json.MarshalIndent(out, "", "  ")
	return os.WriteFile(filepath.Join(run.Dir, "run.json"), b, 0o644)
}

// NewID returns a sortable random id with a prefix.
func NewID(prefix string) string {
	var b [6]byte
	_, _ = randRead(b[:])
	return fmt.Sprintf("%s_%s_%s", prefix, time.Now().UTC().Format("20060102T150405"), hex.EncodeToString(b[:]))
}

// RunDir returns <works>/<yyyy-mm-dd>/<runId>.
func RunDir(runID string) string {
	return filepath.Join(settings.Get().WorksDir, time.Now().Format("2006-01-02"), runID)
}

// ResolveRef maps a reference to a local file: pack image paths become files.
func ResolveRef(ref string) string {
	if strings.HasPrefix(ref, "images/") {
		if p := resources.Current(); p != nil {
			if f, ok := p.ImagePath(ref); ok {
				return f
			}
		}
	}
	return ref
}
