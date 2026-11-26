// Package telemetry sends lightweight, privacy-preserving anonymous usage
// events from the desktop client to the website's first-party analytics
// endpoint (/api/analytics/events) (#174).
//
// Privacy guarantees:
//   - Only a randomly generated local anonymous ID (dc_...) is used; no
//     hardware identifiers, MAC addresses, hostnames, emails, prompts, file
//     paths, images, or API keys are ever collected or transmitted.
//   - Users can opt out at any time in Settings (TelemetryDisabled); when
//     disabled, zero network requests are made.
//   - All network calls are asynchronous, bounded, and fail silently so UI
//     and image generation are never slowed down.
package telemetry

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	maxQueueSize  = 64
	maxBatchSize  = 20
	flushInterval = 30 * time.Second
	heartbeatGap  = 6 * time.Hour
)

var allowedEvents = map[string]bool{
	"client_launch":         true,
	"client_heartbeat":      true,
	"client_tab_view":       true,
	"client_generate_done":  true,
	"client_feature_used":   true,
	"client_update_checked": true,
	"client_update_applied": true,
}

var blockedPropKeys = map[string]bool{
	"password":      true,
	"token":         true,
	"secret":        true,
	"cookie":        true,
	"authorization": true,
	"prompt":        true,
	"rawprompt":     true,
	"blackbox":      true,
	"email":         true,
	"phone":         true,
	"apikey":        true,
	"api_key":       true,
	"path":          true,
	"filepath":      true,
	"file_path":     true,
	"worksdir":      true,
	"works_dir":     true,
}

type eventPayload struct {
	Event      string         `json:"event"`
	Channel    string         `json:"channel"`
	DeviceType string         `json:"deviceType"`
	Props      map[string]any `json:"props,omitempty"`
}

type batchPayload struct {
	AnonymousID string         `json:"anonymousId"`
	SessionID   string         `json:"sessionId"`
	LinkAnon    bool           `json:"linkAnon,omitempty"`
	Events      []eventPayload `json:"events"`
}

// Client buffers and flushes anonymous desktop usage events.
type Client struct {
	Version   string
	SessionID string
	HTTP      *http.Client
	Enabled   func() bool
	SiteBase  func() string
	AnonID    func() string
	Token     func() string

	mu     sync.Mutex
	queue  []eventPayload
	notify chan struct{}
}

// New constructs a telemetry Client with a fresh random session ID.
func New(version string) *Client {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return &Client{
		Version:   strings.TrimPrefix(strings.TrimSpace(version), "v"),
		SessionID: "ds_" + hex.EncodeToString(b),
		HTTP:      &http.Client{Timeout: 10 * time.Second},
		notify:    make(chan struct{}, 1),
	}
}

func (c *Client) isEnabled() bool {
	if c == nil {
		return false
	}
	if c.Enabled != nil {
		return c.Enabled()
	}
	return true
}

func (c *Client) sanitizeProps(raw map[string]any) map[string]any {
	out := map[string]any{
		"appVersion": c.Version,
		"os":         runtime.GOOS,
		"arch":       runtime.GOARCH,
	}
	for k, v := range raw {
		ck := strings.TrimSpace(k)
		if ck == "" || len(ck) > 40 || blockedPropKeys[strings.ToLower(ck)] {
			continue
		}
		switch val := v.(type) {
		case bool, int, int64, float64:
			out[ck] = val
		case string:
			s := strings.TrimSpace(val)
			if len(s) > 80 {
				s = s[:80]
			}
			out[ck] = s
		}
	}
	return out
}

// Track enqueues one allowlisted anonymous event. It never blocks.
func (c *Client) Track(event string, props map[string]any) {
	if !c.isEnabled() {
		return
	}
	ev := strings.TrimSpace(event)
	if !allowedEvents[ev] {
		return
	}
	item := eventPayload{
		Event:      ev,
		Channel:    "desktop_client",
		DeviceType: "desktop",
		Props:      c.sanitizeProps(props),
	}
	c.mu.Lock()
	if len(c.queue) >= maxQueueSize {
		c.queue = c.queue[1:]
	}
	c.queue = append(c.queue, item)
	shouldFlush := len(c.queue) >= 8
	c.mu.Unlock()
	if shouldFlush {
		select {
		case c.notify <- struct{}{}:
		default:
		}
	}
}

// Start runs the background launch, heartbeat, and periodic flush loop until ctx ends.
func (c *Client) Start(ctx context.Context) {
	if c == nil {
		return
	}
	launchTimer := time.NewTimer(6 * time.Second)
	flushTicker := time.NewTicker(flushInterval)
	hbTicker := time.NewTicker(heartbeatGap)
	defer launchTimer.Stop()
	defer flushTicker.Stop()
	defer hbTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			fctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			c.Flush(fctx)
			cancel()
			return
		case <-launchTimer.C:
			if c.isEnabled() {
				loggedIn := c.Token != nil && strings.TrimSpace(c.Token()) != ""
				c.Track("client_launch", map[string]any{"loggedIn": loggedIn})
				c.Flush(ctx)
			}
		case <-hbTicker.C:
			if c.isEnabled() {
				loggedIn := c.Token != nil && strings.TrimSpace(c.Token()) != ""
				c.Track("client_heartbeat", map[string]any{"loggedIn": loggedIn})
			}
		case <-flushTicker.C:
			c.Flush(ctx)
		case <-c.notify:
			c.Flush(ctx)
		}
	}
}

// Flush delivers queued events in batches. Network errors are silently ignored.
func (c *Client) Flush(ctx context.Context) {
	if c == nil {
		return
	}
	if !c.isEnabled() {
		c.mu.Lock()
		c.queue = nil
		c.mu.Unlock()
		return
	}
	base := ""
	if c.SiteBase != nil {
		base = strings.TrimRight(strings.TrimSpace(c.SiteBase()), "/")
	}
	if base == "" {
		return
	}
	anonID := ""
	if c.AnonID != nil {
		anonID = strings.TrimSpace(c.AnonID())
	}
	tok := ""
	if c.Token != nil {
		tok = strings.TrimSpace(c.Token())
	}

	for {
		c.mu.Lock()
		if len(c.queue) == 0 {
			c.mu.Unlock()
			return
		}
		n := len(c.queue)
		if n > maxBatchSize {
			n = maxBatchSize
		}
		batch := append([]eventPayload(nil), c.queue[:n]...)
		c.queue = c.queue[n:]
		c.mu.Unlock()

		payload := batchPayload{
			AnonymousID: anonID,
			SessionID:   c.SessionID,
			LinkAnon:    tok != "" && anonID != "",
			Events:      batch,
		}
		body, err := json.Marshal(payload)
		if err != nil {
			continue
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/analytics/events", bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "handraw-client/"+c.Version)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		httpClient := c.HTTP
		if httpClient == nil {
			httpClient = &http.Client{Timeout: 10 * time.Second}
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			return
		}
		_ = resp.Body.Close()
	}
}
