package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/galleries"
)

func buildTestGalleryZip(t *testing.T, id, itemID string, imgBytes []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	manifest, _ := json.Marshal(map[string]any{
		"id":          id,
		"name":        "离线贴纸包",
		"description": "ZIP 本地离线图库测试",
		"items": []map[string]any{
			{"id": itemID, "name": "手绘小茶杯", "category": "props", "image": "images/cup.png"},
		},
	})
	f1, _ := zw.Create("pkg/gallery.json")
	_, _ = f1.Write(manifest)
	f2, _ := zw.Create("pkg/images/cup.png")
	_, _ = f2.Write(imgBytes)
	_ = zw.Close()
	return buf.Bytes()
}

func TestGalleryMarketSourcesJSONZipAndDirectInstall(t *testing.T) {
	galleries.ClearMarketCache()
	t.Cleanup(galleries.ClearMarketCache)

	pngBytes := tinyPNG(t)
	zipBytes := buildTestGalleryZip(t, "zip-stickers", "ST-01", pngBytes)

	var srvURL string
	mockMarket := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"format": 1,
				"title": {"zh": "社区示例图库市场"},
				"galleries": [
					{
						"id": "demo-hairs",
						"version": "1.2.0",
						"name": "社区发型图鉴",
						"badge": "1 款示例",
						"description": "声明式 JSON 图库插件测试",
						"author": "tester",
						"license": "MIT",
						"categories": ["portrait"],
						"source": {"type": "json", "url": "` + srvURL + `/packs/hairs.json"}
					},
					{
						"id": "zip-stickers",
						"version": "0.9.0",
						"name": "离线贴纸包",
						"categories": ["scene"],
						"source": {"type": "zip", "url": "` + srvURL + `/packs/stickers.zip"}
					}
				]
			}`))
		case "/packs/hairs.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"id": "demo-hairs",
				"name": "社区发型图鉴",
				"items": [
					{"id": "H-01", "name": "蓬松丸子头", "category": "updo", "remoteImage": "img/h01.png"}
				]
			}`))
		case "/packs/img/h01.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case "/packs/stickers.zip":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(zipBytes)
		case "/packs/evil-builtin.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id": "styles", "name": "覆盖内置", "items": []}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockMarket.Close()
	srvURL = mockMarket.URL

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// 1. Official market source cannot be deleted.
	if rr := doReq(t, h, srv.Token, "DELETE", "/api/galleries/market/sources/handraw-galleries-official", nil); rr.Code != 400 {
		t.Fatalf("expected 400 deleting official gallery market source, got %d %s", rr.Code, rr.Body.String())
	}

	// 2. Add custom Format 1 gallery market source.
	rrAdd := doReq(t, h, srv.Token, "POST", "/api/galleries/market/sources", map[string]any{
		"url": mockMarket.URL + "/index.json",
	})
	if rrAdd.Code != 200 {
		t.Fatalf("POST /api/galleries/market/sources failed: %d %s", rrAdd.Code, rrAdd.Body.String())
	}
	var addOut struct {
		OK bool   `json:"ok"`
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rrAdd.Body.Bytes(), &addOut)
	if !addOut.OK || addOut.ID == "" {
		t.Fatalf("unexpected add source response: %s", rrAdd.Body.String())
	}
	if !strings.Contains(rrAdd.Body.String(), `"demo-hairs"`) || !strings.Contains(rrAdd.Body.String(), `"zip-stickers"`) {
		t.Fatalf("expected custom market packs in response: %s", rrAdd.Body.String())
	}

	// 3. Install declarative JSON gallery plugin from market and fetch on-demand cached image.
	rrInstJSON := doReq(t, h, srv.Token, "POST", "/api/galleries/market/install", map[string]any{
		"id": "demo-hairs",
	})
	if rrInstJSON.Code != 200 {
		t.Fatalf("install demo-hairs failed: %d %s", rrInstJSON.Code, rrInstJSON.Body.String())
	}
	rrImgJSON := doReq(t, h, srv.Token, "GET", "/api/galleries/demo-hairs/items/H-01/image", nil)
	if rrImgJSON.Code != 200 || rrImgJSON.Body.Len() != len(pngBytes) {
		t.Fatalf("GET demo-hairs image failed: %d len=%d", rrImgJSON.Code, rrImgJSON.Body.Len())
	}

	// 4. Install ZIP offline gallery plugin from market and verify local unpacked image works.
	rrInstZip := doReq(t, h, srv.Token, "POST", "/api/galleries/market/install", map[string]any{
		"id": "zip-stickers",
	})
	if rrInstZip.Code != 200 {
		t.Fatalf("install zip-stickers failed: %d %s", rrInstZip.Code, rrInstZip.Body.String())
	}
	rrImgZip := doReq(t, h, srv.Token, "GET", "/api/galleries/zip-stickers/items/ST-01/image", nil)
	if rrImgZip.Code != 200 || rrImgZip.Body.Len() != len(pngBytes) {
		t.Fatalf("GET zip-stickers offline image failed: %d len=%d", rrImgZip.Code, rrImgZip.Body.Len())
	}

	// 5. Direct URL install rejects overwriting core built-in gallery ("styles").
	if rrEvil := doReq(t, h, srv.Token, "POST", "/api/galleries/market/install", map[string]any{
		"url": mockMarket.URL + "/packs/evil-builtin.json",
	}); rrEvil.Code != 400 {
		t.Fatalf("expected 400 attempting to overwrite built-in gallery via direct URL, got %d", rrEvil.Code)
	}

	// 6. Direct URL install succeeds for a standalone custom gallery.
	rrDirect := doReq(t, h, srv.Token, "POST", "/api/galleries/market/install", map[string]any{
		"url": mockMarket.URL + "/packs/hairs.json",
		"id":  "direct-hairs",
	})
	if rrDirect.Code != 200 || !strings.Contains(rrDirect.Body.String(), `"direct-hairs"`) {
		t.Fatalf("direct URL install failed: %d %s", rrDirect.Code, rrDirect.Body.String())
	}

	// 7. Uninstall ZIP & JSON plugins cleans up manifests, unpacked dir, and image cache.
	if rrUn1 := doReq(t, h, srv.Token, "POST", "/api/galleries/market/zip-stickers/uninstall", map[string]any{"purgeCache": true}); rrUn1.Code != 200 {
		t.Fatalf("uninstall zip-stickers failed: %d %s", rrUn1.Code, rrUn1.Body.String())
	}
	if _, err := os.Stat(filepath.Join(appdir.Galleries(), "zip-stickers")); !os.IsNotExist(err) {
		t.Fatalf("expected unpacked zip-stickers folder to be removed")
	}
	if rrUn2 := doReq(t, h, srv.Token, "POST", "/api/galleries/market/demo-hairs/uninstall", map[string]any{"purgeCache": true}); rrUn2.Code != 200 {
		t.Fatalf("uninstall demo-hairs failed: %d %s", rrUn2.Code, rrUn2.Body.String())
	}
	if _, err := os.Stat(filepath.Join(appdir.Galleries(), "cache", "demo-hairs")); !os.IsNotExist(err) {
		t.Fatalf("expected demo-hairs image cache dir to be purged")
	}

	// 8. Remove custom market source cleanly.
	if rrDelSrc := doReq(t, h, srv.Token, "DELETE", "/api/galleries/market/sources/"+addOut.ID, nil); rrDelSrc.Code != 200 {
		t.Fatalf("DELETE custom gallery market source failed: %d %s", rrDelSrc.Code, rrDelSrc.Body.String())
	}
}

func TestGalleryFormat1ImageMirrorsFailoverAndVariants(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()
	galleries.ClearMarketCache()
	t.Cleanup(galleries.ClearMarketCache)

	pngBytes := tinyPNG(t)

	var giteeHits, githubHits int
	mockHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gitee/poses.json":
			// Simulate Gitee returning 451 / error on manifest so installer falls back to GitHub.
			w.WriteHeader(http.StatusUnavailableForLegalReasons)
			_, _ = w.Write([]byte("blocked"))
		case "/github/poses.json":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"format":       1,
				"id":           "std-poses",
				"version":      "1.2.0",
				"name":         "标准多视角姿势",
				"author":       "Tester",
				"license":      "MIT",
				"multiVariant": true,
				"imageMirrors": map[string]string{
					"gitee":  "http://" + r.Host + "/gitee-img/",
					"github": "http://" + r.Host + "/github-img/",
				},
				"items": []map[string]any{
					{
						"id":          "P01",
						"name":        "回眸站姿",
						"category":    "standing",
						"remoteThumb": "thumbs/p01_front.png",
						"remoteImage": "full/p01_front.png",
						"variants": []map[string]any{
							{"key": "front", "label": "正面", "remoteThumb": "thumbs/p01_front.png", "remoteImage": "full/p01_front.png"},
							{"key": "side", "label": "侧面", "remoteThumb": "thumbs/p01_side.png", "remoteImage": "full/p01_side.png"},
						},
					},
				},
			})
		case "/gitee-img/full/p01_side.png":
			giteeHits++
			// Primary Gitee image mirror fails; generic imageMirrors must fail over to GitHub!
			w.WriteHeader(http.StatusBadGateway)
		case "/github-img/full/p01_side.png":
			githubHits++
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case "/index.json":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"format": 1,
				"title":  map[string]string{"zh": "镜像容错测试市场"},
				"galleries": []map[string]any{
					{
						"id":           "std-poses",
						"version":      "1.2.0",
						"name":         "标准多视角姿势",
						"author":       "Tester",
						"license":      "MIT",
						"categories":   []string{"pose"},
						"multiVariant": true,
						"source": map[string]any{
							"type": "json",
							"url":  "http://" + r.Host + "/github/poses.json",
							"mirrors": map[string]string{
								"gitee":  "http://" + r.Host + "/gitee/poses.json",
								"github": "http://" + r.Host + "/github/poses.json",
							},
						},
					},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mockHost.Close()

	// Subscribe test market & install with preferred mirror="gitee" (which fails over to github for poses.json).
	if rr := doReq(t, h, srv.Token, "POST", "/api/galleries/market/sources", map[string]any{
		"url": mockHost.URL + "/index.json",
	}); rr.Code != 200 {
		t.Fatalf("add market source failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "POST", "/api/galleries/market/install", map[string]any{
		"id":     "std-poses",
		"mirror": "gitee",
	}); rr.Code != 200 {
		t.Fatalf("install std-poses failed: %d %s", rr.Code, rr.Body.String())
	}

	// Fetch variant="side" full image: must try gitee-img first and fail over automatically to github-img.
	rrImg := doReq(t, h, srv.Token, "GET", "/api/galleries/std-poses/items/P01/image?variant=side", nil)
	if rrImg.Code != 200 || rrImg.Body.Len() != len(pngBytes) {
		t.Fatalf("expected multi-mirror failover image 200 len=%d, got %d len=%d", len(pngBytes), rrImg.Code, rrImg.Body.Len())
	}
	if giteeHits == 0 || githubHits == 0 {
		t.Fatalf("expected failover sequence gitee->github, got giteeHits=%d githubHits=%d", giteeHits, githubHits)
	}
}
