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

// #195: POST /api/inspirations/batch-delete removes selected inspirations and
// cleans up cached files inside library/inspirations/ without touching external
// user work files.
func TestInspirationBatchDeleteCleansLocalImagesOnly(t *testing.T) {
	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0}
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// Create 1 clipped inspiration (image saved under library/inspirations/)
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)
	rr1 := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/clip", map[string]any{
		"title":        "待批量删除-1",
		"imageDataUrl": dataURL,
		"prompt":       "p1",
		"autoOrganize": false,
	})
	if rr1.Code != 200 {
		t.Fatalf("clip 1 failed: %d %s", rr1.Code, rr1.Body.String())
	}
	var res1 struct{ Item inspirationItem `json:"item"` }
	_ = json.Unmarshal(rr1.Body.Bytes(), &res1)

	// Create 1 inspiration pointing to an external works image (must NOT be removed from disk)
	extFile := t.TempDir() + "/keep-original.png"
	if err := os.WriteFile(extFile, pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	rr2 := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations", map[string]any{
		"title":        "待批量删除-2",
		"imagePath":    extFile,
		"prompt":       "p2",
		"autoOrganize": false,
	})
	if rr2.Code != 200 {
		t.Fatalf("create 2 failed: %d %s", rr2.Code, rr2.Body.String())
	}
	var res2 struct{ Item inspirationItem `json:"item"` }
	_ = json.Unmarshal(rr2.Body.Bytes(), &res2)

	// Create 1 survivor inspiration
	rrKeep := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations", map[string]any{
		"title":        "保留项",
		"prompt":       "keep me",
		"autoOrganize": false,
	})
	if rrKeep.Code != 200 {
		t.Fatalf("create keep failed: %d %s", rrKeep.Code, rrKeep.Body.String())
	}
	var resKeep struct{ Item inspirationItem `json:"item"` }
	_ = json.Unmarshal(rrKeep.Body.Bytes(), &resKeep)

	// Batch delete first two
	rrDel := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/batch-delete", map[string]any{
		"ids": []string{res1.Item.ID, res2.Item.ID},
	})
	if rrDel.Code != 200 {
		t.Fatalf("batch-delete failed: %d %s", rrDel.Code, rrDel.Body.String())
	}
	var delRes struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	_ = json.Unmarshal(rrDel.Body.Bytes(), &delRes)
	if !delRes.OK || delRes.Deleted != 2 {
		t.Fatalf("expected deleted=2, got %+v", delRes)
	}

	// Verify cached inspiration file was cleaned up, while external work file remains untouched.
	if _, err := os.Stat(res1.Item.ImagePath); !os.IsNotExist(err) {
		t.Fatalf("expected cached inspiration image %s deleted, stat err=%v", res1.Item.ImagePath, err)
	}
	if _, err := os.Stat(extFile); err != nil {
		t.Fatalf("external user work file %s must NOT be deleted: %v", extFile, err)
	}

	// Verify only the survivor remains in the vault list.
	rrList := doReq(t, h, srv.Token, http.MethodGet, "/api/inspirations", nil)
	if rrList.Code != 200 {
		t.Fatalf("list failed: %d", rrList.Code)
	}
	var listRes struct {
		Items []inspirationItem `json:"items"`
	}
	_ = json.Unmarshal(rrList.Body.Bytes(), &listRes)
	if len(listRes.Items) != 1 || listRes.Items[0].ID != resKeep.Item.ID {
		t.Fatalf("expected only survivor %s left, got %+v", resKeep.Item.ID, listRes.Items)
	}
}
