package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/plugins"
	"github.com/yang0/handraw-client/internal/profile"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
	"github.com/yang0/handraw-client/internal/updater"
)

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{200, 75, 49, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func writeTestPack(t *testing.T, dir string) {
	t.Helper()
	ref := filepath.Join(dir, "references")
	imgDir := filepath.Join(dir, "images", "individual", "FA")
	_ = os.MkdirAll(ref, 0o755)
	_ = os.MkdirAll(imgDir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"version":"2026.11.17.test"}`), 0o644)
	styles := `[
		{"number":"FA-001","group":"FA 国际社论幽默 / Editorial & Humor Doodle","reference":"Gemma Correll","generation_name":"Playful Deadpan Doodle","traits":"松散黑线、白底、暖纸感","image":"images/individual/FA/FA-001.png"},
		{"number":"FA-002","group":"FA 国际社论幽默 / Editorial & Humor Doodle","reference":"Test Author","generation_name":"Minimal Ink Sketch","traits":"松散黑线、极简留白","image":"images/individual/FA/FA-001.png"}
	]`
	layouts := `[{"id":"SC-001","category":"social","name":"上文下图社媒卡","name_en":"Top Text Card","image":"","prompt_zh":"上方留白写标题，下方画主图。","prompt_en":"Top text area, bottom illustration."}]`
	colors := `[{"id":"C-15","category":"red","category_zh":"红","category_en":"Red","name_zh":"朱砂红","name_en":"Vermilion","quote_zh":"朱砂红","quote_en":"Vermilion","image":"","prompt_zh":"主题色：朱砂红。","prompt_en":"Theme color: Vermilion."}]`
	tones := `[{"id":"T-01","name_zh":"高调","name_en":"High-key","category":"key","category_zh":"明暗","category_en":"Key","desc_zh":"明亮通透","desc_en":"Bright airy","image":""}]`
	_ = os.WriteFile(filepath.Join(ref, "styles.json"), []byte(styles), 0o644)
	_ = os.WriteFile(filepath.Join(ref, "layouts.json"), []byte(layouts), 0o644)
	_ = os.WriteFile(filepath.Join(ref, "colors.json"), []byte(colors), 0o644)
	_ = os.WriteFile(filepath.Join(ref, "tones.json"), []byte(tones), 0o644)
	_ = os.WriteFile(filepath.Join(imgDir, "FA-001.png"), tinyPNG(t), 0o644)
}

func setupTestServer(t *testing.T, mockSiteURL string) (*Server, context.CancelFunc) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HANDRAW_HOME", root)
	t.Setenv("HANDRAW_SECRETS", "memory")
	appdir.SetRoot(root)
	settings.Reset()
	profile.SetHome(filepath.Join(root, "profile"))
	t.Cleanup(func() {
		profile.SetHome("")
		settings.Reset()
	})

	worksDir := filepath.Join(root, "works")
	_, err := settings.Update(func(st *settings.Settings) error {
		st.WorksDir = worksDir
		if mockSiteURL != "" {
			st.SiteBase = mockSiteURL
		}
		st.AutoSyncResources = false
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	packDir := filepath.Join(root, "pack")
	writeTestPack(t, packDir)
	p, err := resources.Load(packDir)
	if err != nil {
		t.Fatal(err)
	}
	resources.SetCurrent(p)

	db, err := store.Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	srv := New("0.1.0-test")
	srv.DB = db
	srv.PackDir = packDir
	srv.Site = site.NewWithBase(mockSiteURL, "0.1.0-test")
	srv.Plugins = plugins.NewRuntime(appdir.Plugins())
	srv.Updater = updater.New("0.1.0-test", appdir.Updates())
	srv.Jobs = jobs.New(db, srv.Site, func(ev jobs.Event) { srv.Emit("job", ev) })
	srv.RegisterBuiltins()

	ctx, cancel := context.WithCancel(context.Background())
	srv.Jobs.Start(ctx, 1)
	t.Cleanup(cancel)
	return srv, cancel
}

func doReq(t *testing.T, h http.Handler, token, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, "http://127.0.0.1:8787"+target, &buf)
	req.Host = "127.0.0.1:8787"
	if token != "" {
		req.Header.Set("X-Handraw-Token", token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestAuthAndSecurity(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// Missing token must be rejected.
	if rr := doReq(t, h, "", "GET", "/api/boot", nil); rr.Code != 403 {
		t.Fatalf("expected 403 without token, got %d", rr.Code)
	}
	// Evil Origin must be rejected.
	req := httptest.NewRequest("GET", "http://127.0.0.1:8787/api/boot", nil)
	req.Host = "127.0.0.1:8787"
	req.Header.Set("X-Handraw-Token", srv.Token)
	req.Header.Set("Origin", "https://evil.example")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 403 {
		t.Fatalf("expected 403 on evil origin, got %d", rr.Code)
	}
	// Valid token passes.
	if rr := doReq(t, h, srv.Token, "GET", "/api/boot", nil); rr.Code != 200 {
		t.Fatalf("expected 200 on boot, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestCustomStyleSyncAndPurity(t *testing.T) {
	var putCount atomic.Int32
	var gotVis string
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/auth/me":
			_, _ = w.Write([]byte(`{"ok":true,"username":"tester","displayName":"Tester"}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/me/resources/") && r.Method == "PUT":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotVis, _ = body["visibility"].(string)
			putCount.Add(1)
			_, _ = w.Write([]byte(`{"ok":true,"resource":{"id":"1111","revision":1}}`))
		case r.URL.Path == "/api/v1/me/resources" && r.Method == "GET":
			_, _ = w.Write([]byte(`{"ok":true,"items":[],"nextCursor":"1"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	h := srv.Handler()

	// Creating custom style with concrete subject words returns trait violation warnings.
	rr := doReq(t, h, srv.Token, "POST", "/api/mine/styles", map[string]any{
		"name":   "测试手绘风",
		"traits": "水彩晕染笔触，女孩穿着长裙站在花田里",
	})
	if rr.Code != 200 {
		t.Fatalf("minePut failed: %d %s", rr.Code, rr.Body.String())
	}
	var putResp struct {
		Style      resources.Style `json:"style"`
		Violations []string        `json:"violations"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &putResp)
	if putResp.Style.Number != "MY-S-001" {
		t.Fatalf("expected MY-S-001, got %q", putResp.Style.Number)
	}
	if len(putResp.Violations) == 0 {
		t.Fatal("expected subject violations to be flagged")
	}

	// Sync pushes custom style as private only.
	rrSync := doReq(t, h, srv.Token, "POST", "/api/mine/sync", nil)
	if rrSync.Code != 200 || putCount.Load() != 1 || gotVis != "private" {
		t.Fatalf("sync failed: code=%d puts=%d vis=%q body=%s", rrSync.Code, putCount.Load(), gotVis, rrSync.Body.String())
	}
}

func TestProviderGenerateAndIdempotentPublish(t *testing.T) {
	pngB64 := base64.StdEncoding.EncodeToString(tinyPNG(t))
	var editCalls atomic.Int32
	mockOpenAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"data":[{"id":"gpt-image-2","owned_by":"test"}]}`))
		case "/v1/images/generations":
			_, _ = w.Write([]byte(`{"data":[{"b64_json":"` + pngB64 + `"}]}`))
		case "/v1/images/edits":
			editCalls.Add(1)
			_, _ = w.Write([]byte(`{"data":[{"b64_json":"` + pngB64 + `"}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockOpenAI.Close()

	var pubCalls atomic.Int32
	var gotReqID, gotOrigin, gotOrigPrompt string
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/me/generations" && r.Method == "POST":
			pubCalls.Add(1)
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			gotReqID, _ = b["requestId"].(string)
			gotOrigin, _ = b["originClient"].(string)
			gotOrigPrompt, _ = b["originalRequest"].(string)
			_, _ = w.Write([]byte(`{"ok":true,"workId":"w_999","workIds":["w_999"],"imageCount":1}`))
		case r.URL.Path == "/api/economy/public-models":
			_, _ = w.Write([]byte(`{"ok":true,"specifications":[{"model":"gpt-image-2","resolution":"1k","priceCents":30}]}`))
		case r.URL.Path == "/api/studio/quote":
			_, _ = w.Write([]byte(`{"quoteId":"q_1","totalCents":500,"freeCount":0}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	h := srv.Handler()

	// 1. Add user provider and fetch models.
	rrP := doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "p1",
		"name":    "测试接口",
		"kind":    "openai",
		"purpose": "image",
		"baseUrl": mockOpenAI.URL + "/v1",
		"apiKey":  "sk-secret-test",
		"enabled": true,
		"models":  []map[string]any{{"id": "gpt-image-2", "label": "GPT Image 2", "canRefImage": true, "canEdit": true}},
	})
	if rrP.Code != 200 {
		t.Fatalf("providerPut failed: %d %s", rrP.Code, rrP.Body.String())
	}
	if strings.Contains(rrP.Body.String(), "sk-secret-test") {
		t.Fatal("secret leaked in settings response")
	}

	rrMod := doReq(t, h, srv.Token, "POST", "/api/providers/p1/models", nil)
	if rrMod.Code != 200 || !strings.Contains(rrMod.Body.String(), "gpt-image-2") {
		t.Fatalf("providerModels failed: %d %s", rrMod.Code, rrMod.Body.String())
	}

	// 2. Site quote above CostLimitCents triggers needConfirm.
	rrOver := doReq(t, h, srv.Token, "POST", "/api/generate", map[string]any{
		"mode":     "single",
		"modelRef": "site:gpt-image-2",
		"input":    map[string]any{"style": "FA-001", "theme": "雨天书店"},
	})
	if rrOver.Code != 200 || !strings.Contains(rrOver.Body.String(), `"needConfirm":true`) {
		t.Fatalf("expected needConfirm when over cost limit, got %d %s", rrOver.Code, rrOver.Body.String())
	}

	// 3. Generate with custom provider and wait until saved on disk.
	rrGen := doReq(t, h, srv.Token, "POST", "/api/generate", map[string]any{
		"mode":     "single",
		"modelRef": "p1:gpt-image-2",
		"recipe":   map[string]any{"styleIds": []string{"FA-001", "MY-S-001"}},
		"input":    map[string]any{"style": "FA-001", "theme": "窗台打盹的小猫"},
	})
	if rrGen.Code != 200 {
		t.Fatalf("generate failed: %d %s", rrGen.Code, rrGen.Body.String())
	}
	var genResp struct {
		Run store.Run `json:"run"`
	}
	_ = json.Unmarshal(rrGen.Body.Bytes(), &genResp)
	deadline := time.Now().Add(5 * time.Second)
	var finished store.Run
	for time.Now().Before(deadline) {
		r2, err := srv.DB.GetRun(genResp.Run.ID)
		if err == nil {
			finished = r2
			if r2.Status == "done" || r2.Status == "failed" {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if finished.Status != "done" || len(finished.Images) != 1 || editCalls.Load() != 1 {
		t.Fatalf("job did not finish properly: status=%s edits=%d imgs=%d err=%s", finished.Status, editCalls.Load(), len(finished.Images), finished.Error)
	}
	if _, err := os.Stat(finished.Images[0].Path); err != nil {
		t.Fatalf("generated image missing on disk: %v", err)
	}
	if _, err := os.Stat(filepath.Join(finished.Dir, "run.json")); err != nil {
		t.Fatalf("run.json missing: %v", err)
	}
	// Generation must NOT auto-publish to the site.
	if pubCalls.Load() != 0 {
		t.Fatal("generation auto-published to website")
	}

	// 4. Explicit publish creates one work idempotently and strips private MY-* tags.
	rrPub := doReq(t, h, srv.Token, "POST", "/api/works/"+finished.ID+"/publish", map[string]any{"title": "小猫测试"})
	if rrPub.Code != 200 {
		t.Fatalf("publish failed: %d %s", rrPub.Code, rrPub.Body.String())
	}
	if !regexp.MustCompile(`^skill-history-[a-f0-9-]{36}$`).MatchString(gotReqID) {
		t.Fatalf("invalid skill requestId: %q", gotReqID)
	}
	if gotOrigin != "skill" {
		t.Fatalf("expected originClient=skill, got %q", gotOrigin)
	}
	if !strings.Contains(gotOrigPrompt, "【画风：FA-001 】") || strings.Contains(gotOrigPrompt, "MY-S-001") {
		t.Fatalf("unexpected publish tags in prompt: %q", gotOrigPrompt)
	}
	// Repeat publish must be deduplicated locally without hitting remote again.
	rrPub2 := doReq(t, h, srv.Token, "POST", "/api/works/"+finished.ID+"/publish", nil)
	if rrPub2.Code != 200 || pubCalls.Load() != 1 || !strings.Contains(rrPub2.Body.String(), `"deduped":true`) {
		t.Fatalf("expected idempotent publish, calls=%d body=%s", pubCalls.Load(), rrPub2.Body.String())
	}
}

func TestCommunityPluginSandbox(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f1, _ := zw.Create("package.json")
	_, _ = f1.Write([]byte(`{"name":"reader-only","version":"1.0.0","handraw":{"name":"只读插件","permissions":["resources:read"],"page":{"file":"index.html","title":"插件"}}}`))
	f2, _ := zw.Create("index.html")
	_, _ = f2.Write([]byte(`<h1>ok</h1>`))
	zw.Close()

	if _, err := srv.Plugins.InstallZip(buf.Bytes(), "test"); err != nil {
		t.Fatal(err)
	}
	_, _ = settings.Update(func(st *settings.Settings) error {
		st.Plugins["community:reader-only"] = true
		return nil
	})
	// Allowed permission succeeds.
	if rr := doReq(t, h, srv.Token, "POST", "/api/plugins/reader-only/call", map[string]any{"action": "resources.summary"}); rr.Code != 200 {
		t.Fatalf("expected 200 for allowed plugin action, got %d %s", rr.Code, rr.Body.String())
	}
	// Undeclared permission is rejected.
	if rr := doReq(t, h, srv.Token, "POST", "/api/plugins/reader-only/call", map[string]any{"action": "works.list"}); rr.Code != 403 {
		t.Fatalf("expected 403 for undeclared plugin action, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestSiteModelsNormalization(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/economy/public-models" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"ok": true,
				"specifications": [
					{"id":"spec-1k","name":"gpt-image-2.5","model":"gpt-image-2.5","resolution":"1k","priceCents":3,"enabled":true},
					{"id":"spec-2k","name":"gpt-image-2.5 2K","model":"gpt-image-2.5","resolution":"2k","priceCents":4,"enabled":true},
					{"id":"spec-off","name":"disabled","model":"disabled-model","priceCents":9,"enabled":false},
					{"id":"spec-26","name":"gpt-image-2.6","model":"gpt-image-2.6","resolution":"1k","priceCents":5,"enabled":true}
				],
				"policies": [{"resolution":"1k","freeUnits":10}]
			}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer mock.Close()

	srv, _ := setupTestServer(t, mock.URL)
	h := srv.Handler()
	rr := doReq(t, h, srv.Token, "GET", "/api/models", nil)
	if rr.Code != 200 {
		t.Fatalf("/api/models failed: %d %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Site []struct {
			Model             string `json:"model"`
			PriceCents        int    `json:"priceCents"`
			SupportsFreeQuota bool   `json:"supportsFreeQuota"`
		} `json:"site"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode /api/models: %v (%s)", err, rr.Body.String())
	}
	if len(out.Site) != 2 || out.Site[0].Model != "gpt-image-2.5" || out.Site[0].PriceCents != 3 || !out.Site[0].SupportsFreeQuota {
		t.Fatalf("unexpected normalized site models: %+v", out.Site)
	}
}
