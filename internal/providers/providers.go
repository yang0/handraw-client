// Package providers calls user-configured OpenAI-compatible image and text
// APIs. Keys come from the OS keyring and are never logged.
package providers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

type Provider = settings.Provider

func key(p Provider) string {
	k, _ := secrets.Get(secrets.ProviderKey(p.ID))
	return k
}

func endpoint(p Provider, path string) string {
	base := strings.TrimRight(p.BaseURL, "/")
	if !strings.HasSuffix(base, "/v1") && !strings.Contains(base, "/v1/") && !strings.HasSuffix(base, "/openai") {
		// Most relays expose /v1; accept a bare host too.
		if !strings.Contains(strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://"), "/") {
			base += "/v1"
		}
	}
	return base + path
}

type ModelInfo struct {
	ID               string `json:"id"`
	OwnedBy          string `json:"owned_by,omitempty"`
	IsImage          bool   `json:"isImage"`
	IsVision         bool   `json:"isVision"`
	CapabilitySource string `json:"capabilitySource,omitempty"` // "metadata" | "heuristic"
}

var imageHints = []string{
	"image", "dall-e", "dalle", "flux", "stable-diffusion",
	"sdxl", "sd3", "sd-xl", "sd_xl", "sd-1.", "sd-2.",
	"seedream", "jimeng", "kolors", "imagen",
	"midjourney", "mj-", "mj_",
	"ideogram", "recraft", "qwen-image", "hunyuan-image",
	"cogview", "wanx", "nano-banana", "gpt-image",
	"playground-v", "kandinsky", "z-image",
}

var visionHints = []string{
	// OpenAI
	"gpt-4o", "gpt-4.1", "gpt-4.5", "gpt-4-turbo", "gpt-4-vision", "gpt-5",
	// Anthropic
	"claude-3", "claude-4", "claude-sonnet-4", "claude-opus-4", "claude-haiku-4",
	// Google
	"gemini-1.5", "gemini-2", "gemini-2.5", "gemini-3", "gemini-pro-vision", "gemma-3",
	// DeepSeek (v4 / flash-4.x / vl)
	"deepseek-vl", "deepseek-v4", "deepseek-flash-4", "deepseek-4",
	// Qwen
	"qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl", "qwen3.5", "qwen-omni", "qvq",
	// GLM
	"glm-4v", "glm-4.1v", "glm-4.5", "glm-4.6", "glm-5",
	// Doubao / Seed / Kimi / Moonshot / Step / MiniMax
	"doubao-vision", "doubao-1.5-vision", "doubao-seed",
	"kimi-vl", "kimi-k2.5", "moonshot-v1-vision",
	"step-1v", "step-1o", "minimax-01", "minimax-vl",
	// Open multimodal families & generic markers
	"internvl", "minicpm-v", "pixtral", "mistral-small-3.1",
	"llama-3.2-11b-vision", "llama-3.2-90b-vision", "llama-4",
	"grok-2-vision", "grok-3", "grok-4",
	"vision", "-vl", "_vl", "multimodal", "omni",
}

func hasModelToken(lowerID, tok string) bool {
	if lowerID == tok {
		return true
	}
	for _, sep := range []string{"/", ":", "-", "_", "."} {
		if strings.HasPrefix(lowerID, tok+sep) || strings.HasSuffix(lowerID, sep+tok) {
			return true
		}
		for _, sep2 := range []string{"-", "_", ".", ":"} {
			if strings.Contains(lowerID, sep+tok+sep2) {
				return true
			}
		}
	}
	return false
}

// LooksImage reports whether a model ID looks like an image generation model.
func LooksImage(id string) bool {
	l := strings.ToLower(strings.TrimSpace(id))
	if l == "" {
		return false
	}
	if strings.Contains(l, "image-to-text") || strings.Contains(l, "image-caption") {
		return false
	}
	for _, h := range imageHints {
		if strings.Contains(l, h) {
			return true
		}
	}
	return false
}

// LooksVision reports whether a non-image-generation model ID looks like a vision-capable model.
func LooksVision(id string) bool {
	if LooksImage(id) {
		return false
	}
	l := strings.ToLower(strings.TrimSpace(id))
	if l == "" {
		return false
	}
	for _, h := range visionHints {
		if strings.Contains(l, h) {
			return true
		}
	}
	for _, tok := range []string{"o1", "o3", "o4"} {
		if hasModelToken(l, tok) {
			return true
		}
	}
	return false
}

func strSliceLower(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, it := range arr {
		if s, ok := it.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, strings.ToLower(strings.TrimSpace(s)))
		}
	}
	return out
}

func sliceHasAny(list []string, targets ...string) bool {
	for _, s := range list {
		for _, t := range targets {
			if s == t || strings.Contains(s, t) {
				return true
			}
		}
	}
	return false
}

// detectModelCapabilities prefers authoritative metadata returned by /v1/models
// (OpenRouter architecture.input_modalities/output_modalities, NewAPI/OneAPI
// capabilities/supported_endpoint_types/type, etc.) and falls back to heuristics.
func detectModelCapabilities(raw map[string]any, id string) (isImage bool, isVision bool, source string) {
	var hasImgMeta, metaImg bool
	var hasVisMeta, metaVis bool

	// 1. OpenRouter / standard multimodal architecture object
	if arch, ok := raw["architecture"].(map[string]any); ok {
		if outs := strSliceLower(arch["output_modalities"]); len(outs) > 0 {
			hasImgMeta = true
			metaImg = sliceHasAny(outs, "image")
		}
		if ins := strSliceLower(arch["input_modalities"]); len(ins) > 0 {
			hasVisMeta = true
			metaVis = sliceHasAny(ins, "image", "vision")
		}
		if modStr, ok := arch["modality"].(string); ok && strings.Contains(modStr, "->") {
			parts := strings.SplitN(strings.ToLower(modStr), "->", 2)
			if !hasVisMeta {
				hasVisMeta = true
				metaVis = strings.Contains(parts[0], "image") || strings.Contains(parts[0], "vision")
			}
			if !hasImgMeta {
				hasImgMeta = true
				metaImg = strings.Contains(parts[1], "image")
			}
		}
	}

	// 2. Top-level input_modalities / output_modalities / modalities
	if !hasImgMeta {
		if outs := strSliceLower(raw["output_modalities"]); len(outs) > 0 {
			hasImgMeta = true
			metaImg = sliceHasAny(outs, "image")
		}
	}
	if !hasVisMeta {
		if ins := strSliceLower(raw["input_modalities"]); len(ins) > 0 {
			hasVisMeta = true
			metaVis = sliceHasAny(ins, "image", "vision")
		} else if mods := strSliceLower(raw["modalities"]); len(mods) > 0 {
			hasVisMeta = true
			metaVis = sliceHasAny(mods, "image", "vision")
		}
	}

	// 3. capabilities map or array (OneAPI / NewAPI / Ollama / Azure / Ark)
	if capsMap, ok := raw["capabilities"].(map[string]any); ok {
		for _, k := range []string{"vision", "image_input", "multimodal"} {
			if b, ok := capsMap[k].(bool); ok {
				hasVisMeta = true
				if b {
					metaVis = true
				}
			}
		}
		for _, k := range []string{"image", "image_generation", "images"} {
			if b, ok := capsMap[k].(bool); ok {
				hasImgMeta = true
				if b {
					metaImg = true
				}
			}
		}
	} else if capsArr := strSliceLower(raw["capabilities"]); len(capsArr) > 0 {
		hasVisMeta = true
		metaVis = sliceHasAny(capsArr, "vision", "image_input", "multimodal")
		if sliceHasAny(capsArr, "image_generation", "text2img", "t2i") {
			hasImgMeta = true
			metaImg = true
		}
	}

	// 4. Top-level explicit vision / supports_vision boolean
	for _, k := range []string{"supports_vision", "vision"} {
		if b, ok := raw[k].(bool); ok {
			hasVisMeta = true
			metaVis = b
		}
	}

	// 5. supported_endpoint_types / endpoint_types (NewAPI / OneAPI)
	eps := strSliceLower(raw["supported_endpoint_types"])
	if len(eps) == 0 {
		eps = strSliceLower(raw["endpoint_types"])
	}
	if len(eps) > 0 && !hasImgMeta {
		hasImgEp := sliceHasAny(eps, "image-generation", "image_generation", "images", "midjourney", "dall-e")
		hasChatEp := sliceHasAny(eps, "openai", "chat", "anthropic", "gemini")
		if hasImgEp && !hasChatEp {
			hasImgMeta = true
			metaImg = true
		}
	}

	// 6. type / model_type / category strings
	for _, k := range []string{"type", "model_type", "category"} {
		if s, ok := raw[k].(string); ok {
			ls := strings.ToLower(strings.TrimSpace(s))
			switch ls {
			case "image", "image_generation", "text2img", "t2i", "img2img":
				hasImgMeta = true
				metaImg = true
			case "vision", "vlm", "multimodal":
				hasVisMeta = true
				metaVis = true
			}
		}
	}

	if hasImgMeta {
		isImage = metaImg
	} else {
		isImage = LooksImage(id)
	}
	if isImage {
		isVision = false
	} else if hasVisMeta {
		isVision = metaVis
	} else {
		isVision = LooksVision(id)
	}

	if hasImgMeta || hasVisMeta {
		source = "metadata"
	} else {
		source = "heuristic"
	}
	return isImage, isVision, source
}

var httpClient = &http.Client{Timeout: 6 * time.Minute}

// ListModels fetches GET /models using the provider's stored API key.
func ListModels(ctx context.Context, p Provider) ([]ModelInfo, error) {
	return ListModelsWithKey(ctx, p, key(p))
}

// ListModelsWithKey fetches GET /models using an explicit API key (may be empty).
// This allows previewing models for a draft provider before saving it.
func ListModelsWithKey(ctx context.Context, p Provider, apiKey string) ([]ModelInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint(p, "/models"), nil)
	if err != nil {
		return nil, err
	}
	if k := strings.TrimSpace(apiKey); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接接口：%w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 400 {
		return nil, apiErr(resp.StatusCode, body)
	}
	var out struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("模型列表格式无法识别：%w", err)
	}
	var models []ModelInfo
	for _, m := range out.Data {
		id, _ := m["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		ownedBy, _ := m["owned_by"].(string)
		isImg, isVis, capSrc := detectModelCapabilities(m, id)
		models = append(models, ModelInfo{
			ID:               id,
			OwnedBy:          ownedBy,
			IsImage:          isImg,
			IsVision:         isVis,
			CapabilitySource: capSrc,
		})
	}
	sort.SliceStable(models, func(i, j int) bool {
		if models[i].IsImage != models[j].IsImage {
			return models[i].IsImage
		}
		return models[i].ID < models[j].ID
	})
	return models, nil
}

// APIError represents a non-2xx HTTP response from a third-party provider (#154).
type APIError struct {
	Status  int
	Code    string
	Message string
	Text    string
}

func (e *APIError) Error() string { return e.Text }

func apiErr(status int, body []byte) error {
	var e struct {
		Error struct {
			Message string `json:"message"`
			Code    any    `json:"code"`
		} `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &e)
	msg := e.Error.Message
	if msg == "" {
		msg = e.Message
	}
	if msg == "" {
		msg = strings.TrimSpace(string(body))
		if len(msg) > 300 {
			msg = msg[:300]
		}
	}
	codeStr := ""
	if e.Error.Code != nil {
		codeStr = strings.TrimSpace(fmt.Sprint(e.Error.Code))
	}
	var text string
	switch status {
	case 401, 403:
		text = fmt.Errorf("鉴权失败（%d）：%s", status, msg).Error()
	case 404:
		text = fmt.Errorf("接口或模型不存在（404）：%s", msg).Error()
	case 429:
		text = fmt.Errorf("请求过多或额度不足（429）：%s", msg).Error()
	default:
		text = fmt.Errorf("接口返回 %d：%s", status, msg).Error()
	}
	return &APIError{Status: status, Code: codeStr, Message: msg, Text: text}
}

// RefImage is an image attached to an edit request.
type RefImage struct {
	Name string
	Data []byte
	Mime string
}

type ImageRequest struct {
	Model   string
	Prompt  string
	Size    string // "1024x1024" or "" for auto
	Quality string
	N       int
	Refs    []RefImage
	Mask    *RefImage
}

// Image is one returned image: bytes or a URL to download.
type Image struct {
	Data []byte
	URL  string
}

// GenerateImage calls /images/generations, or /images/edits when refs are attached.
func GenerateImage(ctx context.Context, p Provider, r ImageRequest) ([]Image, error) {
	if r.N <= 0 {
		r.N = 1
	}
	var req *http.Request
	var err error
	if len(r.Refs) > 0 || r.Mask != nil {
		req, err = editRequest(ctx, p, r)
	} else {
		body := map[string]any{"model": r.Model, "prompt": r.Prompt, "n": r.N}
		if r.Size != "" && r.Size != "auto" {
			body["size"] = r.Size
		}
		if r.Quality != "" && r.Quality != "auto" {
			body["quality"] = r.Quality
		}
		b, _ := json.Marshal(body)
		req, err = http.NewRequestWithContext(ctx, "POST", endpoint(p, "/images/generations"), bytes.NewReader(b))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	if err != nil {
		return nil, err
	}
	if k := key(p); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, err
		}
		return nil, fmt.Errorf("请求接口失败：%w", err)
	}
	defer resp.Body.Close()
	const (
		maxGenErrorBytes = 2 << 20
		maxGenRespBytes  = 64 << 20
	)
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxGenErrorBytes))
		return nil, apiErr(resp.StatusCode, body)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGenRespBytes+1))
	if err != nil {
		return nil, fmt.Errorf("读取生图响应失败：%w", err)
	}
	if int64(len(body)) > maxGenRespBytes {
		return nil, errors.New("接口返回体积超过 64MB 上限")
	}
	var out struct {
		Data []struct {
			B64 string `json:"b64_json"`
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("接口返回无法解析：%w", err)
	}
	var imgs []Image
	for _, d := range out.Data {
		if d.B64 != "" {
			b, err := base64.StdEncoding.DecodeString(d.B64)
			if err != nil {
				return nil, fmt.Errorf("图片数据损坏：%w", err)
			}
			imgs = append(imgs, Image{Data: b})
		} else if d.URL != "" {
			imgs = append(imgs, Image{URL: d.URL})
		}
	}
	if len(imgs) == 0 {
		return nil, errors.New("接口没有返回图片")
	}
	return imgs, nil
}

func editRequest(ctx context.Context, p Provider, r ImageRequest) (*http.Request, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("model", r.Model)
	_ = w.WriteField("prompt", r.Prompt)
	_ = w.WriteField("n", fmt.Sprint(r.N))
	if r.Size != "" && r.Size != "auto" {
		_ = w.WriteField("size", r.Size)
	}
	if r.Quality != "" && r.Quality != "auto" {
		_ = w.WriteField("quality", r.Quality)
	}
	field := "image"
	if len(r.Refs) > 1 {
		field = "image[]"
	}
	for i, ref := range r.Refs {
		if err := writeFile(w, field, ref, i); err != nil {
			return nil, err
		}
	}
	if r.Mask != nil {
		if err := writeFile(w, "mask", *r.Mask, 0); err != nil {
			return nil, err
		}
	}
	w.Close()
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint(p, "/images/edits"), &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	return req, nil
}

func writeFile(w *multipart.Writer, field string, f RefImage, i int) error {
	name := f.Name
	if name == "" {
		name = fmt.Sprintf("image-%d.png", i)
	}
	mime := f.Mime
	if mime == "" {
		mime = mimeOf(name)
	}
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, filepath.Base(name)))
	h.Set("Content-Type", mime)
	part, err := w.CreatePart(h)
	if err != nil {
		return err
	}
	_, err = part.Write(f.Data)
	return err
}

func mimeOf(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	}
	return "image/png"
}

const maxDownloadedImageBytes int64 = 64 << 20

// Download fetches an image URL returned by a provider with a strict 64MB cap.
func Download(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("下载图片失败：%d", resp.StatusCode)
	}
	if resp.ContentLength > maxDownloadedImageBytes {
		return nil, errors.New("下载图片体积超过 64MB 上限")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadedImageBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxDownloadedImageBytes {
		return nil, errors.New("下载图片体积超过 64MB 上限")
	}
	return b, nil
}

// DownloadToFile streams a provider image URL directly to dstPath without
// buffering the full image in memory (#180).
func DownloadToFile(ctx context.Context, url, dstPath string) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return 0, fmt.Errorf("下载图片失败：%d", resp.StatusCode)
	}
	if resp.ContentLength > maxDownloadedImageBytes {
		return 0, errors.New("下载图片体积超过 64MB 上限")
	}
	out, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, err
	}
	n, cpErr := io.Copy(out, io.LimitReader(resp.Body, maxDownloadedImageBytes+1))
	closeErr := out.Close()
	if cpErr != nil {
		_ = os.Remove(dstPath)
		return 0, cpErr
	}
	if closeErr != nil {
		_ = os.Remove(dstPath)
		return 0, closeErr
	}
	if n > maxDownloadedImageBytes {
		_ = os.Remove(dstPath)
		return 0, errors.New("下载图片体积超过 64MB 上限")
	}
	return n, nil
}

// ChatMessage is an OpenAI chat message; content may include image parts.
type ChatMessage struct {
	Role       string     `json:"role"`
	Content    any        `json:"content,omitempty"`
	Name       string     `json:"name,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

// ToolDef declares a function tool in OpenAI chat/completions format.
type ToolDef struct {
	Type     string          `json:"type"`
	Function ToolFunctionDef `json:"function"`
}

type ToolFunctionDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type ToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function ToolCallFunction `json:"function"`
}

type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type TokenUsage struct {
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
	CacheReadTokens  int `json:"cache_read_tokens"`
	CacheWriteTokens int `json:"cache_write_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type ChatTurnResult struct {
	Content      string
	ToolCalls    []ToolCall
	FinishReason string
	Usage        *TokenUsage
}

// ChatWithTools calls /chat/completions with optional OpenAI function tools.
func ChatWithTools(ctx context.Context, p Provider, model string, msgs []ChatMessage, tools []ToolDef) (ChatTurnResult, error) {
	return ChatWithToolsCached(ctx, p, model, msgs, tools, "")
}

// ChatWithToolsCached calls /chat/completions with optional tools and an optional
// prompt_cache_key to maximize upstream relay prompt-cache hits (#61).
// If the relay rejects prompt_cache_key or tools with HTTP 400/422, it gracefully degrades.
func ChatWithToolsCached(ctx context.Context, p Provider, model string, msgs []ChatMessage, tools []ToolDef, cacheKey string) (ChatTurnResult, error) {
	body := map[string]any{"model": model, "messages": msgs, "temperature": 0.7}
	if len(tools) > 0 {
		body["tools"] = tools
		body["tool_choice"] = "auto"
	}
	if strings.TrimSpace(cacheKey) != "" {
		body["prompt_cache_key"] = strings.TrimSpace(cacheKey)
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint(p, "/chat/completions"), bytes.NewReader(b))
	if err != nil {
		return ChatTurnResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if k := key(p); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	c := &http.Client{Timeout: 3 * time.Minute}
	resp, err := c.Do(req)
	if err != nil {
		return ChatTurnResult{}, fmt.Errorf("请求文字模型失败：%w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode >= 400 {
		if resp.StatusCode == 400 || resp.StatusCode == 422 {
			if strings.TrimSpace(cacheKey) != "" {
				return ChatWithToolsCached(ctx, p, model, msgs, tools, "")
			}
			if len(tools) > 0 {
				return ChatWithToolsCached(ctx, p, model, msgs, nil, "")
			}
		}
		return ChatTurnResult{}, apiErr(resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content   any        `json:"content"`
				ToolCalls []ToolCall `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return ChatTurnResult{}, errors.New("文字模型返回无法解析")
	}
	if len(out.Choices) == 0 {
		if out.Error.Message != "" {
			return ChatTurnResult{}, fmt.Errorf("接口返回错误：%s", out.Error.Message)
		}
		return ChatTurnResult{}, errors.New("文字模型返回无法解析")
	}
	ch := out.Choices[0]
	return ChatTurnResult{
		Content:      extractContentText(ch.Message.Content),
		ToolCalls:    ch.Message.ToolCalls,
		FinishReason: ch.FinishReason,
		Usage:        ExtractTokenUsage(out.Usage),
	}, nil
}

// ExtractTokenUsage normalizes OpenAI / DeepSeek / Anthropic-relay usage maps.
func ExtractTokenUsage(usage map[string]any) *TokenUsage {
	if len(usage) == 0 {
		return nil
	}
	intVal := func(m map[string]any, keys ...string) (int, bool) {
		for _, k := range keys {
			if raw, ok := m[k]; ok && raw != nil {
				switch v := raw.(type) {
				case float64:
					return int(v), true
				case int:
					return v, true
				case int64:
					return int(v), true
				}
			}
		}
		return 0, false
	}
	details, _ := usage["prompt_tokens_details"].(map[string]any)
	if len(details) == 0 {
		details, _ = usage["input_tokens_details"].(map[string]any)
	}
	cacheRead, _ := intVal(usage, "prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_read_tokens")
	if cacheRead == 0 && len(details) > 0 {
		cacheRead, _ = intVal(details, "cached_tokens", "cache_read_tokens")
	}
	cacheWrite, _ := intVal(usage, "cache_creation_input_tokens", "cache_write_tokens")
	if cacheWrite == 0 && len(details) > 0 {
		cacheWrite, _ = intVal(details, "cache_creation_tokens")
	}
	var uncached int
	if miss, ok := intVal(usage, "prompt_cache_miss_tokens"); ok {
		uncached = miss
	} else if pt, ok := intVal(usage, "prompt_tokens"); ok {
		uncached = pt - cacheRead - cacheWrite
		if uncached < 0 {
			uncached = 0
		}
	} else if it, ok := intVal(usage, "input_tokens"); ok {
		uncached = it
	}
	outTok, _ := intVal(usage, "completion_tokens", "output_tokens")
	tot, _ := intVal(usage, "total_tokens")
	if tot == 0 {
		tot = uncached + cacheRead + cacheWrite + outTok
	}
	if tot == 0 && cacheRead == 0 && outTok == 0 {
		return nil
	}
	return &TokenUsage{
		InputTokens:      uncached,
		OutputTokens:     outTok,
		CacheReadTokens:  cacheRead,
		CacheWriteTokens: cacheWrite,
		TotalTokens:      tot,
	}
}

// Chat calls /chat/completions and returns the text reply.
func Chat(ctx context.Context, p Provider, model string, msgs []ChatMessage, jsonMode bool) (string, error) {
	body := map[string]any{"model": model, "messages": msgs, "temperature": 0.7}
	if jsonMode {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint(p, "/chat/completions"), bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if k := key(p); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	c := &http.Client{Timeout: 3 * time.Minute}
	resp, err := c.Do(req)
	if err != nil {
		return "", fmt.Errorf("请求文字模型失败：%w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode >= 400 {
		// Some relays reject response_format; retry once without it.
		if jsonMode && (resp.StatusCode == 400 || resp.StatusCode == 422) {
			return Chat(ctx, p, model, msgs, false)
		}
		return "", apiErr(resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", errors.New("文字模型返回无法解析")
	}
	if len(out.Choices) == 0 {
		if out.Error.Message != "" {
			return "", fmt.Errorf("接口返回错误：%s", out.Error.Message)
		}
		return "", errors.New("文字模型返回无法解析")
	}
	return extractContentText(out.Choices[0].Message.Content), nil
}

func extractContentText(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case []any:
		var sb strings.Builder
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if txt, ok := m["text"].(string); ok {
				sb.WriteString(txt)
			}
		}
		return sb.String()
	}
	return ""
}

// SizeForRatio maps an aspect ratio to a common OpenAI image size.
func SizeForRatio(ratio string) string {
	switch ratio {
	case "1:1":
		return "1024x1024"
	case "3:4", "2:3", "9:16", "4:5":
		return "1024x1536"
	case "4:3", "3:2", "16:9", "2.35:1", "21:9", "5:4":
		return "1536x1024"
	}
	return "auto"
}
