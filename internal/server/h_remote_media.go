package server

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
)

const (
	remoteImgTTL      = 24 * time.Hour
	maxRemoteImgBytes = 15 << 20
)

var allowedRemoteThumbWidths = []int{48, 96, 160, 240, 320, 480, 640, 960, 1280}

func normalizeRemoteThumbWidth(raw string) int {
	if strings.TrimSpace(raw) == "" {
		return 480
	}
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || v <= 0 {
		return 480
	}
	for _, w := range allowedRemoteThumbWidths {
		if v <= w {
			return w
		}
	}
	return allowedRemoteThumbWidths[len(allowedRemoteThumbWidths)-1]
}

func (s *Server) allowedRemoteImageHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return false
	}
	if h == "handraw-style.com" || strings.HasSuffix(h, ".handraw-style.com") {
		return true
	}
	if bu, err := url.Parse(s.Site.Base()); err == nil {
		if bh := strings.ToLower(strings.TrimSpace(bu.Hostname())); bh != "" && h == bh {
			return true
		}
	}
	return false
}

func resolveRemoteMediaURL(s *Server, rawURL string, width int) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", bad("缺少图片地址")
	}
	if strings.HasPrefix(rawURL, "/") {
		if strings.HasPrefix(rawURL, "//") || strings.HasPrefix(rawURL, "/\\") {
			return "", bad("非法的相对图片地址")
		}
		rawURL = s.Site.Base() + rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", bad("仅支持 http/https 图片地址")
	}
	if !s.allowedRemoteImageHost(u.Hostname()) {
		return "", &apiError{Status: 403, Msg: "不允许代理访问非站点图片域名"}
	}
	if width > 0 && isSiteMediaPath(u.Path) {
		q := u.Query()
		if q.Get("w") == "" {
			q.Set("w", strconv.Itoa(width))
			u.RawQuery = q.Encode()
		}
	}
	return u.String(), nil
}

func isSiteMediaPath(p string) bool {
	for _, prefix := range []string{"/uploads/", "/generated/", "/images/", "/avatars/"} {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

// fileRemote fetches site thumbnails (defaulting to ?w=480) and caches them on
// disk so browsing community feeds avoids repeated origin image bandwidth.
func (s *Server) fileRemote(w http.ResponseWriter, r *http.Request) {
	width := normalizeRemoteThumbWidth(r.URL.Query().Get("w"))
	targetURL, err := resolveRemoteMediaURL(s, r.URL.Query().Get("url"), width)
	if err != nil {
		status := http.StatusBadRequest
		if ae, ok := err.(*apiError); ok && ae.Status > 0 {
			status = ae.Status
		}
		http.Error(w, err.Error(), status)
		return
	}

	sum := sha256.Sum256([]byte(targetURL))
	key := hex.EncodeToString(sum[:])
	cachePath := filepath.Join(appdir.Cache(), "remote-img", key[:2], key+".img")

	if st, err := os.Stat(cachePath); err == nil && !st.IsDir() && time.Since(st.ModTime()) < remoteImgTTL {
		if b, rErr := os.ReadFile(cachePath); rErr == nil && len(b) > 0 {
			w.Header().Set("Content-Type", detectRemoteImageMIME(b))
			w.Header().Set("Cache-Control", "private, max-age=86400")
			w.Header().Set("X-Handraw-Cache", "hit")
			_, _ = w.Write(b)
			return
		}
	}

	data, ct, err := s.Site.Fetch(r.Context(), targetURL)
	if err != nil {
		http.Error(w, "拉取远端缩略图失败", http.StatusBadGateway)
		return
	}
	if len(data) == 0 || len(data) > maxRemoteImgBytes {
		http.Error(w, "远端图片尺寸异常", http.StatusBadGateway)
		return
	}
	detected := detectRemoteImageMIME(data)
	if ct == "" || !strings.HasPrefix(strings.ToLower(ct), "image/") {
		ct = detected
	}
	if !strings.HasPrefix(strings.ToLower(ct), "image/") {
		http.Error(w, "远端响应不是图片", http.StatusBadGateway)
		return
	}

	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err == nil {
		tmp := cachePath + ".tmp"
		if os.WriteFile(tmp, data, 0o644) == nil {
			_ = os.Rename(tmp, cachePath)
		}
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Handraw-Cache", "miss")
	_, _ = w.Write(data)
}

func detectRemoteImageMIME(b []byte) string {
	ct := http.DetectContentType(b)
	if strings.HasPrefix(ct, "image/") {
		return ct
	}
	if len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
		return "image/webp"
	}
	return ct
}
