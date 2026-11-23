// Package site talks to handraw-style.com with a device token. The token is
// read from the OS keyring on every call and never leaves this package.
package site

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

// ClientName is shown on the website's device approval page.
func ClientName(version string) string {
	osName := map[string]string{"windows": "Windows", "darwin": "macOS", "linux": "Linux"}[runtime.GOOS]
	if osName == "" {
		osName = runtime.GOOS
	}
	return "手绘风工作台 " + version + " · " + osName
}

// Scopes the client asks for. "studio" is the desktop scope (handraw-web W1).
// Scopes requested at device login. /api/economy and /api/me/level are
// readable by any device token, so no extra scope is needed for balances.
var Scopes = []string{"publish", "library", "studio"}

type Client struct {
	HTTP    *http.Client
	Version string
	base    func() string
}

func New(version string) *Client {
	return &Client{
		HTTP:    &http.Client{Timeout: 60 * time.Second},
		Version: version,
		base:    func() string { return strings.TrimRight(settings.Get().SiteBase, "/") },
	}
}

// NewWithBase is for tests.
func NewWithBase(base, version string) *Client {
	c := New(version)
	c.base = func() string { return strings.TrimRight(base, "/") }
	return c
}

func (c *Client) Base() string { return c.base() }

// APIError carries the site's error code and message.
type APIError struct {
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("网站返回 %d %s", e.Status, e.Code)
}

var ErrNotLoggedIn = &APIError{Status: 401, Code: "login_required", Message: "请先登录手绘风账号"}

func IsAuthError(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == 401
}

func (c *Client) token() string {
	t, _ := secrets.Get(secrets.SiteToken)
	return t
}

func (c *Client) LoggedIn() bool { return c.token() != "" }

// Do performs a JSON request. body may be nil. out may be nil.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	return c.do(ctx, method, path, body, out, true)
}

// Public performs a request without the token.
func (c *Client) Public(ctx context.Context, method, path string, body, out any) error {
	return c.do(ctx, method, path, body, out, false)
}

func (c *Client) do(ctx context.Context, method, path string, body, out any, auth bool) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base()+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "handraw-client/"+c.Version)
	req.Header.Set("X-Handraw-Client", "desktop/"+c.Version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		tok := c.token()
		if tok == "" {
			return ErrNotLoggedIn
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("无法连接网站：%w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		ae := &APIError{Status: resp.StatusCode}
		var e struct {
			Error   any    `json:"error"`
			Code    string `json:"code"`
			Message string `json:"message"`
			Detail  string `json:"detail"`
		}
		if json.Unmarshal(data, &e) == nil {
			ae.Code = e.Code
			switch v := e.Error.(type) {
			case string:
				ae.Message = v
			case map[string]any:
				if m, ok := v["message"].(string); ok {
					ae.Message = m
				}
				if cd, ok := v["code"].(string); ok && ae.Code == "" {
					ae.Code = cd
				}
			}
			if ae.Message == "" {
				ae.Message = firstNonEmpty(e.Message, e.Detail)
			}
		}
		if ae.Message == "" {
			ae.Message = fmt.Sprintf("网站返回 %d", resp.StatusCode)
		}
		return ae
	}
	if out != nil && len(data) > 0 {
		if raw, ok := out.(*json.RawMessage); ok {
			*raw = append((*raw)[:0], data...)
			return nil
		}
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("网站返回无法解析：%w", err)
		}
	}
	return nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// Fetch downloads a site resource (an image URL or /generated path) with the token.
// needsToken reports whether a site path is private media or an API call.
func needsToken(p string) bool {
	for _, prefix := range []string{"/images/", "/assets/", "/data/"} {
		if strings.HasPrefix(p, prefix) {
			return false
		}
	}
	return true
}

func (c *Client) Fetch(ctx context.Context, ref string) ([]byte, string, error) {
	u := ref
	if strings.HasPrefix(ref, "/") {
		u = c.base() + ref
	}
	pu, err := url.Parse(u)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "handraw-client/"+c.Version)
	// Only send the token to the site itself, and only where it is needed:
	// public images must not depend on the token's scopes.
	if bu, _ := url.Parse(c.base()); bu != nil && strings.EqualFold(pu.Host, bu.Host) && needsToken(pu.Path) {
		if tok := c.token(); tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	}
	hc := &http.Client{Timeout: 5 * time.Minute}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, "", &APIError{Status: resp.StatusCode, Message: fmt.Sprintf("下载图片失败：%d", resp.StatusCode)}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 80<<20))
	return b, resp.Header.Get("Content-Type"), err
}

// ---------- device authorization ----------

type DeviceStart struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURL string `json:"verificationUrl"`
	ExpiresIn       int    `json:"expiresIn"`
	Interval        int    `json:"interval"`
}

func (c *Client) StartDevice(ctx context.Context) (DeviceStart, error) {
	var out DeviceStart
	err := c.Public(ctx, "POST", "/api/auth/device", map[string]any{
		"clientName": ClientName(c.Version),
		"scopes":     Scopes,
		"platform":   runtime.GOOS + "/" + runtime.GOARCH,
		"client":     "desktop",
	}, &out)
	if err != nil {
		var ae *APIError
		// A site that doesn't know "studio" yet: fall back to the Skill scopes.
		if errors.As(err, &ae) && ae.Code == "invalid_scope" {
			err = c.Public(ctx, "POST", "/api/auth/device", map[string]any{
				"clientName": ClientName(c.Version),
				"scopes":     []string{"publish", "library"},
			}, &out)
		}
	}
	if err == nil && strings.HasPrefix(out.VerificationURL, "/") {
		out.VerificationURL = c.base() + out.VerificationURL
	}
	return out, err
}

type User struct {
	ID          any    `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
	Role        string `json:"role"`
}

type TokenResult struct {
	Token  string   `json:"token"`
	Scopes []string `json:"scopes"`
	User   User     `json:"user"`
}

// PollDevice exchanges the device code once. Pending returns ("", nil, code).
func (c *Client) PollDevice(ctx context.Context, deviceCode string) (*TokenResult, string, error) {
	var out TokenResult
	err := c.Public(ctx, "POST", "/api/auth/device/token", map[string]any{"deviceCode": deviceCode}, &out)
	if err != nil {
		var ae *APIError
		if errors.As(err, &ae) && ae.Status == 400 {
			switch ae.Code {
			case "authorization_pending", "slow_down":
				return nil, ae.Code, nil
			case "access_denied":
				return nil, ae.Code, errors.New("已在网页上拒绝授权")
			case "expired_token":
				return nil, ae.Code, errors.New("授权码已过期，请重新登录")
			}
		}
		return nil, "", err
	}
	return &out, "ok", nil
}

func (c *Client) Me(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	err := c.Do(ctx, "GET", "/api/auth/me", nil, &out)
	return out, err
}

// ---------- economy ----------

func (c *Client) Economy(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Do(ctx, "GET", "/api/economy", nil, &out)
	return out, err
}

// Level is the signed-in user's creator level (handraw-web #376/#377).
func (c *Client) Level(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Do(ctx, "GET", "/api/me/level", nil, &out)
	return out, err
}

func (c *Client) PublicModels(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Public(ctx, "GET", "/api/economy/public-models", nil, &out)
	return out, err
}

// Quote prices a list of items: [{model, resolution, quality, count}…].
func (c *Client) Quote(ctx context.Context, items []map[string]any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Do(ctx, "POST", "/api/studio/quote", map[string]any{"items": items}, &out)
	return out, err
}

// ---------- generation ----------

// GenerateResult is the subset of /api/studio/generate the client uses.
type GenerateResult struct {
	OK                 bool     `json:"ok"`
	GenID              string   `json:"genId"`
	RequestID          string   `json:"requestId"`
	TaskID             string   `json:"taskId"`
	Status             string   `json:"status"`
	Images             []string `json:"images"`
	Error              string   `json:"error"`
	FinalPrompt        string   `json:"finalPrompt"`
	CostType           string   `json:"costType"`
	AmountCents        int      `json:"amountCents"`
	FreeQuotaRemaining int      `json:"freeQuotaRemaining"`
	Idempotent         bool     `json:"idempotent"`
}

// Generate submits one image. body follows the site's studio contract; the
// client always sends requestId (idempotency) and creationSource.
func (c *Client) Generate(ctx context.Context, body map[string]any) (GenerateResult, error) {
	var out GenerateResult
	hc := c.HTTP
	c2 := *c
	c2.HTTP = &http.Client{Timeout: 6 * time.Minute, Transport: hc.Transport}
	err := c2.Do(ctx, "POST", "/api/studio/generate", body, &out)
	return out, err
}

// Task looks a generation up by task id or request id (resume after restart).
func (c *Client) Task(ctx context.Context, taskID, requestID string) (GenerateResult, error) {
	q := url.Values{}
	if taskID != "" {
		q.Set("id", taskID)
	}
	if requestID != "" {
		q.Set("requestId", requestID)
	}
	var out GenerateResult
	err := c.Do(ctx, "GET", "/api/studio/tasks?"+q.Encode(), nil, &out)
	return out, err
}

// ---------- planning (free on the site) ----------

func (c *Client) ArticlePlan(ctx context.Context, body map[string]any) (json.RawMessage, error) {
	var out json.RawMessage
	c2 := *c
	c2.HTTP = &http.Client{Timeout: 4 * time.Minute}
	err := c2.Do(ctx, "POST", "/api/studio/article-plan", body, &out)
	return out, err
}

func (c *Client) BatchPlan(ctx context.Context, body map[string]any) (json.RawMessage, error) {
	var out json.RawMessage
	c2 := *c
	c2.HTTP = &http.Client{Timeout: 4 * time.Minute, Transport: c.HTTP.Transport}
	err := c2.Do(ctx, "POST", "/api/studio/batch-plan", body, &out)
	return out, err
}

func (c *Client) ChatPlan(ctx context.Context, body map[string]any) (json.RawMessage, error) {
	var out json.RawMessage
	c2 := *c
	c2.HTTP = &http.Client{Timeout: 4 * time.Minute, Transport: c.HTTP.Transport}
	err := c2.Do(ctx, "POST", "/api/studio/chat-plan", body, &out)
	return out, err
}

// AnalyzeStyle (W8): reference images -> visual-language traits + nearest styles.
func (c *Client) AnalyzeStyle(ctx context.Context, images []string, purpose string, model ...string) (json.RawMessage, error) {
	var out json.RawMessage
	c2 := *c
	c2.HTTP = &http.Client{Timeout: 3 * time.Minute}
	body := map[string]any{"images": images, "purpose": purpose}
	if len(model) > 0 && strings.TrimSpace(model[0]) != "" {
		body["model"] = strings.TrimSpace(model[0])
	}
	err := c2.Do(ctx, "POST", "/api/studio/analyze-style", body, &out)
	return out, err
}

// CanvasAssistant (W10): one sentence -> {nodes, edges}.
func (c *Client) CanvasAssistant(ctx context.Context, body map[string]any) (json.RawMessage, error) {
	var out json.RawMessage
	c2 := *c
	c2.HTTP = &http.Client{Timeout: 3 * time.Minute, Transport: c.HTTP.Transport}
	err := c2.Do(ctx, "POST", "/api/studio/canvas-assistant", body, &out)
	return out, err
}

// ---------- unified model-agnostic text/vision AI gateway ----------

type AIChatToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type AIChatRequest struct {
	Capability   string `json:"capability,omitempty"` // "text" | "vision" | "auto"
	System       string `json:"system,omitempty"`
	Messages     any    `json:"messages"`
	Tools        any    `json:"tools,omitempty"`
	ToolChoice   any    `json:"toolChoice,omitempty"`
	JSONMode     bool   `json:"jsonMode,omitempty"`
	Temperature  *float64 `json:"temperature,omitempty"`
	MaxTokens    int    `json:"maxTokens,omitempty"`
	FeatureScope string `json:"featureScope,omitempty"`
}

type AIChatResult struct {
	OK           bool             `json:"ok"`
	Capability   string           `json:"capability"`
	Service      string           `json:"service"`
	Content      string           `json:"content"`
	Text         string           `json:"text"`
	ToolCalls    []AIChatToolCall `json:"toolCalls"`
	FinishReason string           `json:"finishReason"`
	Usage        map[string]any   `json:"usage,omitempty"`
	Billing      map[string]any   `json:"billing,omitempty"`
}

// AIChat invokes the website's unified text/vision AI gateway (/api/ai/chat).
// The client never specifies or receives internal upstream model names.
func (c *Client) AIChat(ctx context.Context, req AIChatRequest) (AIChatResult, error) {
	var out AIChatResult
	c2 := *c
	c2.HTTP = &http.Client{Timeout: 3 * time.Minute, Transport: c.HTTP.Transport}
	err := c2.Do(ctx, "POST", "/api/ai/chat", req, &out)
	return out, err
}

// ---------- passthrough reads ----------

// Get is a generic authenticated GET returning raw JSON.
func (c *Client) Get(ctx context.Context, path string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Do(ctx, "GET", path, nil, &out)
	return out, err
}

// GetPublic is a generic unauthenticated GET returning raw JSON.
func (c *Client) GetPublic(ctx context.Context, path string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Public(ctx, "GET", path, nil, &out)
	return out, err
}

func (c *Client) Send(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Do(ctx, method, path, body, &out)
	return out, err
}
