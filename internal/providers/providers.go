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
	ID      string `json:"id"`
	OwnedBy string `json:"owned_by,omitempty"`
	IsImage bool   `json:"isImage"`
}

var imageHints = []string{"image", "dall-e", "dalle", "flux", "sd", "stable-diffusion", "seedream", "jimeng", "kolors", "imagen", "midjourney", "mj", "ideogram", "recraft", "qwen-image", "hunyuan-image", "cogview", "wanx", "gemini-2.5-flash-image", "nano-banana"}

func looksImage(id string) bool {
	l := strings.ToLower(id)
	for _, h := range imageHints {
		if strings.Contains(l, h) {
			return true
		}
	}
	return false
}

var httpClient = &http.Client{Timeout: 6 * time.Minute}

// ListModels fetches GET /models.
func ListModels(ctx context.Context, p Provider) ([]ModelInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint(p, "/models"), nil)
	if err != nil {
		return nil, err
	}
	if k := key(p); k != "" {
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
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("模型列表格式无法识别：%w", err)
	}
	var models []ModelInfo
	for _, m := range out.Data {
		models = append(models, ModelInfo{ID: m.ID, OwnedBy: m.OwnedBy, IsImage: looksImage(m.ID)})
	}
	sort.SliceStable(models, func(i, j int) bool {
		if models[i].IsImage != models[j].IsImage {
			return models[i].IsImage
		}
		return models[i].ID < models[j].ID
	})
	return models, nil
}

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
	switch status {
	case 401, 403:
		return fmt.Errorf("鉴权失败（%d）：%s", status, msg)
	case 404:
		return fmt.Errorf("接口或模型不存在（404）：%s", msg)
	case 429:
		return fmt.Errorf("请求过多或额度不足（429）：%s", msg)
	}
	return fmt.Errorf("接口返回 %d：%s", status, msg)
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
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 200<<20))
	if resp.StatusCode >= 400 {
		return nil, apiErr(resp.StatusCode, body)
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

// Download fetches an image URL returned by a provider.
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
	return io.ReadAll(io.LimitReader(resp.Body, 80<<20))
}

// ChatMessage is an OpenAI chat message; content may include image parts.
type ChatMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
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
		if jsonMode && resp.StatusCode == 400 {
			return Chat(ctx, p, model, msgs, false)
		}
		return "", apiErr(resp.StatusCode, data)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &out); err != nil || len(out.Choices) == 0 {
		return "", errors.New("文字模型返回无法解析")
	}
	return out.Choices[0].Message.Content, nil
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
