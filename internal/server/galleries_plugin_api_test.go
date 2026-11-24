package server

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

func installTestPlugin(t *testing.T, srv *Server, id string, perms []string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	manifest, _ := json.Marshal(map[string]any{
		"name":    id,
		"version": "1.0.0",
		"handraw": map[string]any{
			"name":        id,
			"permissions": perms,
			"page":        map[string]any{"file": "index.html", "title": id},
		},
	})
	f1, _ := zw.Create("package.json")
	_, _ = f1.Write(manifest)
	f2, _ := zw.Create("index.html")
	_, _ = f2.Write([]byte(`<h1>ok</h1>`))
	_ = zw.Close()

	if _, err := srv.Plugins.InstallZip(buf.Bytes(), "test"); err != nil {
		t.Fatal(err)
	}
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.Plugins["community:"+id] = true
		return nil
	})
}

func TestGalleriesHTTPAndPromptRefs(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// Seed a declarative hairstyle gallery in appdir.Galleries().
	galDir := appdir.Galleries()
	imgDir := filepath.Join(galDir, "images")
	_ = os.MkdirAll(imgDir, 0o755)
	_ = os.WriteFile(filepath.Join(imgDir, "hs-001.png"), tinyPNG(t), 0o644)
	hairstyles := `{
		"id": "hairstyles",
		"name": "发型",
		"nameEn": "Hairstyles",
		"description": "角色手绘发型参考",
		"promptRole": "hairstyle",
		"supportsRefImage": true,
		"items": [
			{"id":"HS-001","name":"蓬松丸子头","category":"updo","categoryZh":"盘发","traits":"蓬松高盘丸子头，几缕碎发垂落耳侧","image":"images/hs-001.png"}
		]
	}`
	if err := os.WriteFile(filepath.Join(galDir, "hairstyles.json"), []byte(hairstyles), 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. GET /api/galleries lists built-in + declarative gallery.
	rr := doReq(t, h, srv.Token, "GET", "/api/galleries", nil)
	if rr.Code != 200 {
		t.Fatalf("GET /api/galleries failed: %d %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"id":"hairstyles"`) || !strings.Contains(rr.Body.String(), `"id":"styles"`) {
		t.Fatalf("expected styles and hairstyles in /api/galleries: %s", rr.Body.String())
	}

	// 2. GET /api/galleries/hairstyles/items + item + image.
	rrItems := doReq(t, h, srv.Token, "GET", "/api/galleries/hairstyles/items?q=丸子头", nil)
	if rrItems.Code != 200 || !strings.Contains(rrItems.Body.String(), `"HS-001"`) {
		t.Fatalf("GET hairstyles items failed: %d %s", rrItems.Code, rrItems.Body.String())
	}
	rrItem := doReq(t, h, srv.Token, "GET", "/api/galleries/hairstyles/items/HS-001", nil)
	if rrItem.Code != 200 || !strings.Contains(rrItem.Body.String(), `/api/galleries/hairstyles/items/HS-001/image`) {
		t.Fatalf("GET hairstyle item failed: %d %s", rrItem.Code, rrItem.Body.String())
	}
	rrImg := doReq(t, h, srv.Token, "GET", "/api/galleries/hairstyles/items/HS-001/image", nil)
	if rrImg.Code != 200 || rrImg.Body.Len() < 20 {
		t.Fatalf("GET hairstyle image failed: %d len=%d", rrImg.Code, rrImg.Body.Len())
	}

	// 3. POST /api/prompt injects galleryRefs into compiled prompt.
	rrPrompt := doReq(t, h, srv.Token, "POST", "/api/prompt", map[string]any{
		"style":       "FA-001",
		"theme":       "窗边喝咖啡的女孩",
		"galleryRefs": []map[string]any{{"kind": "hairstyles", "id": "HS-001"}},
	})
	if rrPrompt.Code != 200 {
		t.Fatalf("POST /api/prompt with galleryRefs failed: %d %s", rrPrompt.Code, rrPrompt.Body.String())
	}
	if !strings.Contains(rrPrompt.Body.String(), "蓬松丸子头") {
		t.Fatalf("expected hairstyle cue in compiled prompt: %s", rrPrompt.Body.String())
	}
}

func TestPluginGalleryAndModelGateway(t *testing.T) {
	// Mock OpenAI-compatible chat + image provider.
	imgB64 := base64.StdEncoding.EncodeToString(tinyPNG(t))
	var gotPrompt string
	mockAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/chat/completions":
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"姿势建议：侧身回眸"}}]}`))
		case "/v1/images/generations", "/v1/images/edits":
			if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
				_ = r.ParseMultipartForm(4 << 20)
				gotPrompt = r.FormValue("prompt")
			} else {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				gotPrompt, _ = body["prompt"].(string)
			}
			_, _ = w.Write([]byte(`{"data":[{"b64_json":"` + imgB64 + `"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockAI.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// Configure custom OpenAI providers for text/vision and image.
	if err := secrets.Set("provider:p_img", "sk-test-secret-never-leak"); err != nil {
		t.Fatal(err)
	}
	if err := secrets.Set("provider:p_txt", "sk-test-secret-never-leak"); err != nil {
		t.Fatal(err)
	}
	_, err := settings.Update(func(st *settings.Settings) error {
		st.Providers = []settings.Provider{
			{
				ID:      "p_img",
				Name:    "Local Mock Image",
				Kind:    "openai",
				Purpose: "image",
				BaseURL: mockAI.URL + "/v1",
				Enabled: true,
				Models:  []settings.Model{{ID: "mock-img", Label: "Mock Image", CanEdit: true, CanRefImage: true}},
			},
			{
				ID:      "p_txt",
				Name:    "Local Mock LLM",
				Kind:    "openai",
				Purpose: "text",
				BaseURL: mockAI.URL + "/v1",
				Enabled: true,
				Models:  []settings.Model{{ID: "mock-llm", Label: "Mock LLM", CanVision: true}},
			},
		}
		st.DefaultTextModel = "p_txt:mock-llm"
		st.DefaultVisionModel = "p_txt:mock-llm"
		st.DefaultModel = "p_img:mock-img"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Install one restricted plugin and one full-featured plugin.
	installTestPlugin(t, srv, "tiny-plug", []string{"galleries:read"})
	installTestPlugin(t, srv, "pose-plug", []string{
		"galleries:read", "galleries:register", "models:text", "models:image",
	})

	// Restricted plugin can list galleries, cannot register or call models.
	if rr := doReq(t, h, srv.Token, "POST", "/api/plugins/tiny-plug/call", map[string]any{"action": "galleries.list"}); rr.Code != 200 {
		t.Fatalf("tiny-plug galleries.list failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "POST", "/api/plugins/tiny-plug/call", map[string]any{"action": "galleries.register", "args": map[string]any{"id": "poses"}}); rr.Code != 403 {
		t.Fatalf("expected 403 for galleries.register without permission, got %d", rr.Code)
	}
	if rr := doReq(t, h, srv.Token, "POST", "/api/plugins/tiny-plug/call", map[string]any{"action": "models.chat", "args": map[string]any{"messages": []map[string]any{{"role": "user", "content": "hi"}}}}); rr.Code != 403 {
		t.Fatalf("expected 403 for models.chat without permission, got %d", rr.Code)
	}

	// Pose plugin registers a runtime gallery "poses" with an image in its own plugin directory.
	poseDir := filepath.Join(appdir.Plugins(), "pose-plug")
	_ = os.WriteFile(filepath.Join(poseDir, "pose-1.png"), tinyPNG(t), 0o644)
	rrReg := doReq(t, h, srv.Token, "POST", "/api/plugins/pose-plug/call", map[string]any{
		"action": "galleries.register",
		"args": map[string]any{
			"id":               "poses",
			"name":             "姿势",
			"promptRole":       "pose",
			"supportsRefImage": true,
			"items": []map[string]any{
				{"id": "POSE-01", "name": "侧身回眸", "category": "portrait", "traits": "人物侧身站立，微微回头看向镜头", "image": "pose-1.png"},
			},
		},
	})
	if rrReg.Code != 200 {
		t.Fatalf("pose-plug galleries.register failed: %d %s", rrReg.Code, rrReg.Body.String())
	}

	// Now tiny-plug (and the host UI) can read pose-plug's gallery!
	rrList := doReq(t, h, srv.Token, "POST", "/api/plugins/tiny-plug/call", map[string]any{
		"action": "galleries.items",
		"args":   map[string]any{"kind": "poses"},
	})
	if rrList.Code != 200 || !strings.Contains(rrList.Body.String(), "POSE-01") {
		t.Fatalf("cross-plugin gallery read failed: %d %s", rrList.Code, rrList.Body.String())
	}

	// models.list must never leak secrets.
	rrMod := doReq(t, h, srv.Token, "POST", "/api/plugins/pose-plug/call", map[string]any{"action": "models.list"})
	if rrMod.Code != 200 {
		t.Fatalf("models.list failed: %d %s", rrMod.Code, rrMod.Body.String())
	}
	if strings.Contains(rrMod.Body.String(), "sk-test-secret-never-leak") {
		t.Fatal("models.list leaked provider API key!")
	}
	if !strings.Contains(rrMod.Body.String(), "p_txt:mock-llm") || !strings.Contains(rrMod.Body.String(), "p_img:mock-img") {
		t.Fatalf("models.list missing configured models: %s", rrMod.Body.String())
	}

	// models.chat calls mock LLM cleanly.
	rrChat := doReq(t, h, srv.Token, "POST", "/api/plugins/pose-plug/call", map[string]any{
		"action": "models.chat",
		"args": map[string]any{
			"modelRef": "p_txt:mock-llm",
			"messages": []map[string]any{{"role": "user", "content": "推荐一个姿势"}},
		},
	})
	if rrChat.Code != 200 || !strings.Contains(rrChat.Body.String(), "侧身回眸") {
		t.Fatalf("models.chat failed: %d %s", rrChat.Code, rrChat.Body.String())
	}

	// models.generate resolves galleryRefs (poses/POSE-01) and runs the job.
	rrGen := doReq(t, h, srv.Token, "POST", "/api/plugins/pose-plug/call", map[string]any{
		"action": "models.generate",
		"args": map[string]any{
			"modelRef":    "p_img:mock-img",
			"galleryRefs": []map[string]any{{"kind": "styles", "id": "FA-001"}, {"kind": "poses", "id": "POSE-01"}},
			"input":       map[string]any{"theme": "公园里的手绘女孩"},
		},
	})
	if rrGen.Code != 200 {
		t.Fatalf("models.generate failed: %d %s", rrGen.Code, rrGen.Body.String())
	}
	var genOut struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}
	_ = json.Unmarshal(rrGen.Body.Bytes(), &genOut)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r2, err := srv.DB.GetRun(genOut.Run.ID)
		if err == nil && (r2.Status == "done" || r2.Status == "failed") {
			if r2.Status != "done" {
				t.Fatalf("plugin generate job failed: %s", r2.Error)
			}
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if !strings.Contains(gotPrompt, "侧身回眸") {
		t.Fatalf("expected resolved pose gallery cue in image prompt, got: %q", gotPrompt)
	}

	// Disabling pose-plug automatically unregisters its "poses" gallery.
	rrOff := doReq(t, h, srv.Token, "PATCH", "/api/plugins/community:pose-plug", map[string]any{"enabled": false})
	if rrOff.Code != 200 {
		t.Fatalf("toggle off pose-plug failed: %d %s", rrOff.Code, rrOff.Body.String())
	}
	rrAfter := doReq(t, h, srv.Token, "GET", "/api/galleries/poses/items", nil)
	if rrAfter.Code != 404 {
		t.Fatalf("expected poses gallery to be unregistered on disable, got %d %s", rrAfter.Code, rrAfter.Body.String())
	}
}

func TestExternalPacksAndFiveAnglePoseMaterialize(t *testing.T) {
	pngBytes := tinyPNG(t)
	var hits int
	mockCDN := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes)
	}))
	defer mockCDN.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// 1. GET /api/galleries/packs lists the 3 RuiC-PoseAtlas packs with Gitee default & localOnly.
	rrPacks := doReq(t, h, srv.Token, "GET", "/api/galleries/packs", nil)
	if rrPacks.Code != 200 {
		t.Fatalf("GET /api/galleries/packs failed: %d %s", rrPacks.Code, rrPacks.Body.String())
	}
	body := rrPacks.Body.String()
	for _, want := range []string{`"ruic-poses"`, `"ruic-costumes"`, `"ruic-faces"`, `"defaultMirror":"gitee"`, `"localOnly":true`} {
		if !strings.Contains(body, want) {
			t.Fatalf("GET /api/galleries/packs missing %s: %s", want, body)
		}
	}

	// 2. Write a 5-angle pose gallery file pointing at our mock CDN to test image caching, materialize, and prompt cues.
	galDir := appdir.Galleries()
	poseJSON := `{
		"id": "ruic-poses",
		"name": "姿态图鉴",
		"nameEn": "RuiC PoseAtlas",
		"promptRole": "pose",
		"supportsRefImage": true,
		"localOnly": true,
		"multiVariant": true,
		"mirror": "gitee",
		"items": [
			{
				"id": "POSE-001",
				"name": "优雅叉腰站姿",
				"category": "站姿",
				"categoryZh": "站姿",
				"traits": "标准全身 · 站姿",
				"meta": {"series": "full_std", "seriesZh": "标准全身"},
				"image": "ruic-poseatlas/img/p1_front.png",
				"thumb": "ruic-poseatlas/thumbs/p1_front.jpg",
				"remoteImage": "` + mockCDN.URL + `/img/p1_front.png",
				"remoteThumb": "` + mockCDN.URL + `/thumbs/p1_front.jpg",
				"variants": [
					{"key":"front","label":"正面","image":"ruic-poseatlas/img/p1_front.png","thumb":"ruic-poseatlas/thumbs/p1_front.jpg","remoteImage":"` + mockCDN.URL + `/img/p1_front.png","remoteThumb":"` + mockCDN.URL + `/thumbs/p1_front.jpg"},
					{"key":"high","label":"俯视","image":"ruic-poseatlas/img/p1_high.png","thumb":"ruic-poseatlas/thumbs/p1_high.jpg","remoteImage":"` + mockCDN.URL + `/img/p1_high.png","remoteThumb":"` + mockCDN.URL + `/thumbs/p1_high.jpg"}
				]
			}
		]
	}`
	if err := os.WriteFile(filepath.Join(galDir, "ruic-poses.json"), []byte(poseJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	// 3. Query with series filter returns the 5-angle pose and its variant URLs.
	rrItems := doReq(t, h, srv.Token, "GET", "/api/galleries/ruic-poses/items?series=full_std", nil)
	if rrItems.Code != 200 || !strings.Contains(rrItems.Body.String(), `"key":"high"`) {
		t.Fatalf("GET ruic-poses items failed: %d %s", rrItems.Code, rrItems.Body.String())
	}

	// 4. Image endpoint downloads on demand & caches locally (second request hits disk).
	rrImg1 := doReq(t, h, srv.Token, "GET", "/api/galleries/ruic-poses/items/POSE-001/image?variant=high&size=thumb", nil)
	if rrImg1.Code != 200 || rrImg1.Body.Len() != len(pngBytes) {
		t.Fatalf("GET pose variant thumb failed: %d len=%d", rrImg1.Code, rrImg1.Body.Len())
	}
	rrImg2 := doReq(t, h, srv.Token, "GET", "/api/galleries/ruic-poses/items/POSE-001/image?variant=high&size=thumb", nil)
	if rrImg2.Code != 200 || hits != 1 {
		t.Fatalf("expected second thumb fetch to serve from local cache (hits=%d)", hits)
	}

	// 5. Materialize endpoint caches full-res variant locally and returns a path readable via /api/local-image.
	rrMat := doReq(t, h, srv.Token, "POST", "/api/galleries/ruic-poses/items/POSE-001/materialize", map[string]any{
		"variant": "high",
	})
	if rrMat.Code != 200 {
		t.Fatalf("POST materialize failed: %d %s", rrMat.Code, rrMat.Body.String())
	}
	var matOut struct {
		OK           bool   `json:"ok"`
		Path         string `json:"path"`
		Variant      string `json:"variant"`
		VariantLabel string `json:"variantLabel"`
		LocalOnly    bool   `json:"localOnly"`
	}
	if err := json.Unmarshal(rrMat.Body.Bytes(), &matOut); err != nil {
		t.Fatal(err)
	}
	if !matOut.OK || matOut.Path == "" || matOut.Variant != "high" || !matOut.LocalOnly {
		t.Fatalf("unexpected materialize output: %+v", matOut)
	}
	if _, err := os.Stat(matOut.Path); err != nil {
		t.Fatalf("materialized file missing on disk: %v", err)
	}

	// 6. Prompt compilation includes the chosen angle ("俯视视角").
	rrPrompt := doReq(t, h, srv.Token, "POST", "/api/prompt", map[string]any{
		"style":       "FA-001",
		"theme":       "街头时尚女孩",
		"galleryRefs": []map[string]any{{"kind": "ruic-poses", "id": "POSE-001", "variant": "high"}},
	})
	if rrPrompt.Code != 200 {
		t.Fatalf("POST /api/prompt with pose variant failed: %d %s", rrPrompt.Code, rrPrompt.Body.String())
	}
	if !strings.Contains(rrPrompt.Body.String(), "俯视") {
		t.Fatalf("expected 俯视 angle cue in compiled prompt: %s", rrPrompt.Body.String())
	}

	// 7. Uninstall removes gallery JSON and local image cache.
	rrUn := doReq(t, h, srv.Token, "POST", "/api/galleries/packs/ruic-poses/uninstall", nil)
	if rrUn.Code != 200 {
		t.Fatalf("POST uninstall failed: %d %s", rrUn.Code, rrUn.Body.String())
	}
	if _, err := os.Stat(matOut.Path); !os.IsNotExist(err) {
		t.Fatalf("expected materialized cache file to be purged on uninstall")
	}
}
