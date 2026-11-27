package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// #193: Clipping an X image with imageDataUrl saves directly to disk; if only
// imageUrl is supplied and download fails, clip returns imageWarning instead of
// failing silently, and POST /api/inspirations/{id}/refetch-image recovers it.
func TestInspirationClipImageDataURLWarningAndRefetch(t *testing.T) {
	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0}
	var failDownload bool
	imgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failDownload {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes)
	}))
	defer imgSrv.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// 1. DataURL clip saves directly to disk without hitting remote host.
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)
	rr1 := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/clip", map[string]any{
		"title":         "X DataURL 灵感",
		"imageDataUrl":  dataURL,
		"imageUrl":      "https://pbs.twimg.com/media/example?format=jpg&name=large",
		"prompt":        "watercolor cat",
		"sourceUrl":     "https://x.com/demo/status/123456",
		"sourceChannel": "x",
		"autoOrganize":  false,
	})
	if rr1.Code != 200 {
		t.Fatalf("clip with imageDataUrl failed: %d %s", rr1.Code, rr1.Body.String())
	}
	var res1 struct {
		OK           bool            `json:"ok"`
		ImageWarning string          `json:"imageWarning"`
		Item         inspirationItem `json:"item"`
	}
	if err := json.Unmarshal(rr1.Body.Bytes(), &res1); err != nil {
		t.Fatal(err)
	}
	if !res1.OK || res1.Item.ImagePath == "" || res1.ImageWarning != "" {
		t.Fatalf("expected clean local save with empty warning, got %+v", res1)
	}
	if _, err := os.Stat(res1.Item.ImagePath); err != nil {
		t.Fatalf("saved inspiration image missing on disk: %v", err)
	}

	// 2. When remote image download fails during clip, return imageWarning and
	// allow recovering via POST /api/inspirations/{id}/refetch-image.
	failDownload = true
	rr2 := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/clip", map[string]any{
		"title":         "X 断网降级灵感",
		"imageUrl":      imgSrv.URL + "/media/test.png",
		"prompt":        "ink landscape",
		"sourceUrl":     "https://x.com/demo/status/654321",
		"sourceChannel": "x",
		"autoOrganize":  false,
	})
	if rr2.Code != 200 {
		t.Fatalf("clip with failing remote image should still save text: %d %s", rr2.Code, rr2.Body.String())
	}
	var res2 struct {
		OK           bool            `json:"ok"`
		ImageWarning string          `json:"imageWarning"`
		Item         inspirationItem `json:"item"`
	}
	if err := json.Unmarshal(rr2.Body.Bytes(), &res2); err != nil {
		t.Fatal(err)
	}
	if res2.Item.ImagePath != "" || res2.ImageWarning == "" {
		t.Fatalf("expected empty imagePath + non-empty imageWarning on download failure, got %+v", res2)
	}

	// 3. Refetch recovers the image locally once upstream is reachable.
	failDownload = false
	rr3 := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+res2.Item.ID+"/refetch-image", map[string]any{})
	if rr3.Code != 200 {
		t.Fatalf("refetch-image failed: %d %s", rr3.Code, rr3.Body.String())
	}
	var res3 struct {
		OK   bool            `json:"ok"`
		Item inspirationItem `json:"item"`
	}
	if err := json.Unmarshal(rr3.Body.Bytes(), &res3); err != nil {
		t.Fatal(err)
	}
	if res3.Item.ImagePath == "" {
		t.Fatalf("expected refetch-image to populate local ImagePath, got %+v", res3.Item)
	}
	if _, err := os.Stat(res3.Item.ImagePath); err != nil {
		t.Fatalf("refetched image missing on disk: %v", err)
	}

	// 4. sniffImageExt recognizes AVIF magic header.
	avif := []byte{0, 0, 0, 0x1c, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f', 0, 0, 0, 0}
	if got := sniffImageExt(avif); got != ".avif" {
		t.Fatalf("sniffImageExt(avif) = %q, want .avif", got)
	}

	// 5. Verify remoteThumb in web/js/api.js does not proxy third-party URLs.
	apiJS, err := os.ReadFile("../../web/js/api.js")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(apiJS), "isProxiedSiteImageURL") {
		t.Fatalf("expected remoteThumb in web/js/api.js to guard third-party hosts")
	}
}
