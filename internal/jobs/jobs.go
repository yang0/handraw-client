// Package jobs runs image generations in the background, saves results to
// the works folder and indexes them. Site-model jobs keep their requestId so
// a restart resumes them by lookup instead of paying twice.
package jobs

import (
	"bytes"
	"context"
	"crypto/sha256"
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

type Manager struct {
	DB              *store.DB
	Site            *site.Client
	Emit            func(Event)
	PluginProviders func() []settings.Provider
	queue           chan string
	mu              sync.Mutex
	running         map[string]context.CancelFunc
	wg              sync.WaitGroup
}

func New(db *store.DB, sc *site.Client, emit func(Event)) *Manager {
	if emit == nil {
		emit = func(Event) {}
	}
	return &Manager{DB: db, Site: sc, Emit: emit, queue: make(chan string, 1024), running: map[string]context.CancelFunc{}}
}

// Start launches workers and resumes unfinished images.
func (m *Manager) Start(ctx context.Context, workers int) {
	if workers <= 0 {
		workers = 2
	}
	for i := 0; i < workers; i++ {
		m.wg.Add(1)
		go m.worker(ctx)
	}
	go func() {
		active, _ := m.DB.ActiveImages()
		for _, im := range active {
			m.queue <- im.ID
		}
	}()
}

func (m *Manager) Enqueue(imageID string) { m.queue <- imageID }

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
	m.mu.Lock()
	cancel := m.running[imageID]
	m.mu.Unlock()
	if im.Status == "running" && im.RemoteTaskID != "" {
		return errors.New("网站已受理该任务，无法取消；结果完成后仍会保存")
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
	ctx, cancel := context.WithCancel(parent)
	m.mu.Lock()
	m.running[imageID] = cancel
	m.mu.Unlock()
	defer func() {
		cancel()
		m.mu.Lock()
		delete(m.running, imageID)
		m.mu.Unlock()
	}()
	_ = m.DB.UpdateImage(imageID, map[string]any{"status": "running"})
	m.DB.UpdateRun(im.RunID, map[string]any{"status": "running"})
	m.Emit(Event{Type: "image", RunID: im.RunID, ImageID: imageID, Status: "running"})

	var data []byte
	var cost int
	if strings.HasPrefix(spec.ModelRef, "site:") {
		data, cost, err = m.runSite(ctx, im, spec)
	} else {
		data, err = m.runProvider(ctx, spec)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		m.fail(im, err.Error())
		return
	}
	if err := m.save(im, data, cost); err != nil {
		m.fail(im, "保存图片失败："+err.Error())
		return
	}
	m.refreshRun(im.RunID)
	m.Emit(Event{Type: "image", RunID: im.RunID, ImageID: imageID, Status: "done"})
	if strings.HasPrefix(spec.ModelRef, "site:") {
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

func (m *Manager) runSite(ctx context.Context, im store.Image, spec Spec) ([]byte, int, error) {
	body := map[string]any{}
	for k, v := range spec.SiteBody {
		body[k] = v
	}
	body["requestId"] = spec.RequestID
	body["clientRequestId"] = spec.RequestID
	body["source"] = "client"
	if settings.Get().KeepSiteGenerationsPrivate {
		body["visibility"] = "private"
	}
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
		res, err = m.Site.Generate(ctx, body)
		if err != nil {
			return nil, 0, err
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
	spec.QuoteID = "" // quotes expire; the site re-prices
	meta, _ := json.Marshal(spec)
	if err := m.DB.UpdateImage(imageID, map[string]any{"status": "queued", "error": "", "remote_task_id": "", "meta": json.RawMessage(meta)}); err != nil {
		return err
	}
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
