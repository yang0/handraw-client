package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/yang0/handraw-client/internal/prompt"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/store"
)

func writePNG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y += 7 {
		for x := 0; x < w; x += 7 {
			img.Set(x, y, color.RGBA{200, 75, 49, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestShareImageDownscalesLargePNGWithoutEncodedWebP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.png")
	writePNG(t, path, 3000, 1500)
	dataURL, name, err := shareImage(store.Image{Path: path}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dataURL, "data:image/jpeg;base64,") || name != "big.jpg" {
		t.Fatalf("want JPEG fallback, got %q %q", dataURL[:30], name)
	}
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, "data:image/jpeg;base64,"))
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width != 2048 || cfg.Height != 1024 {
		t.Fatalf("want 2048x1024, got %+v %v", cfg, err)
	}
}

func TestShareImageRejectsBogusEncodedWebP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "small.png")
	writePNG(t, path, 40, 30)
	bogus := "data:image/webp;base64," + base64.StdEncoding.EncodeToString([]byte("not a webp at all"))
	dataURL, _, err := shareImage(store.Image{Path: path}, bogus)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(dataURL, "data:image/webp") {
		t.Fatal("an invalid UI encoding must not be uploaded")
	}
}

func TestPublishRecipeKeepsOfficialCodesAndHidesCustomDefinitions(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mine := "mine:2b7d4c8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e"
	if err := db.PutDoc(&store.Doc{Kind: "style", ID: mine, Name: "我的纸感", Data: []byte(`{"traits":"secret"}`),
		RemoteID: "2b7d4c8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", RemoteRev: 1}); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: db}
	rec := s.publishRecipe(store.Run{Recipe: []byte(`{"style":"FA-001","style2":"` + mine + `","layout":"MY-LAY","ratio":"3:4","color":"C-15","tone":""}`)})
	if got := rec["styles"].([]string); len(got) != 1 || got[0] != "FA-001" {
		t.Fatalf("styles = %v", got)
	}
	if _, ok := rec["layout"]; ok {
		t.Fatal("MY-* layout must not be shared")
	}
	if got := rec["personalResources"].([]string); len(got) != 1 || got[0] != "2b7d4c8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e" {
		t.Fatalf("personalResources = %v", got)
	}
	if rec["ratio"] != "3:4" || len(rec["colors"].([]string)) != 1 {
		t.Fatalf("recipe = %v", rec)
	}
	if _, ok := rec["tones"]; ok {
		t.Fatal("empty tones must be omitted")
	}
}

func TestWorkPublishRequiresPaidPriceAndProxiesWorkUnlockAndInspirationComments(t *testing.T) {
	var mu sync.Mutex
	var capturedGen map[string]any
	var capturedUnlock map[string]any
	var capturedComment map[string]any

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/me/generations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			capturedGen = body
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "workId": "work_paid_01", "url": "https://handraw-style.com/t/work-work_paid_01",
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/unlocks":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			capturedUnlock = body
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "targetType": "work", "targetId": body["targetId"],
				"work": map[string]any{"id": body["targetId"], "unlocked": true, "recipeLocked": false, "styles": []string{"FA-013"}, "prompt": "原始输入提示词"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/inspirations/insp_01/comments":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "items": []map[string]any{{"id": "r1", "name": "小画", "text": "很好看！", "time": "刚刚"}}, "total": 1, "topicId": "topic_insp_01",
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/inspirations/insp_01/comments":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			capturedComment = body
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "topicId": "topic_insp_01", "forumBoard": "prompts",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mockSite.Close()

	srv, cancel := setupTestServer(t, mockSite.URL)
	defer cancel()
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")
	h := srv.Handler()

	imgPath := filepath.Join(t.TempDir(), "done.png")
	writePNG(t, imgPath, 120, 160)
	run := &store.Run{
		ID:              "run_pub_price_1",
		Mode:            "single",
		Title:           "暖纸小店测试",
		OriginalRequest: "画一家雨夜亮着暖灯的小书店",
		PromptZh:        "暖纸水彩手绘，雨夜街角亮着橘色灯光的小书店，细节丰富",
		Recipe:          []byte(`{"styleIds":["FA-013"],"layoutId":"SC-001","ratio":"3:4"}`),
		Status:          "done",
	}
	if err := srv.DB.InsertRun(run, []store.Image{{ID: "img_1", RunID: run.ID, Idx: 0, Status: "done", Path: imgPath, Width: 120, Height: 160, Prompt: "Expanded model prompt"}}); err != nil {
		t.Fatal(err)
	}

	// Free (price=0) rejected
	r0 := doReq(t, h, srv.Token, http.MethodPost, "/api/works/"+run.ID+"/publish", map[string]any{"title": "测试", "price": 0})
	if r0.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for price=0, got %d: %s", r0.Code, r0.Body.String())
	}

	// Non-tier price=7 rejected
	r7 := doReq(t, h, srv.Token, http.MethodPost, "/api/works/"+run.ID+"/publish", map[string]any{"title": "测试", "price": 7})
	if r7.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for price=7, got %d: %s", r7.Code, r7.Body.String())
	}

	// Valid tier price=5 succeeds and forwards price=5 to /api/v1/me/generations
	r5 := doReq(t, h, srv.Token, http.MethodPost, "/api/works/"+run.ID+"/publish", map[string]any{"title": "雨夜书店", "price": 5})
	if r5.Code != http.StatusOK {
		t.Fatalf("expected 200 for price=5, got %d: %s", r5.Code, r5.Body.String())
	}
	mu.Lock()
	gotPrice := capturedGen["price"]
	mu.Unlock()
	if gotPrice != float64(5) {
		t.Fatalf("expected forwarded price=5, got %v", gotPrice)
	}

	// Work unlock proxy sends targetType=work to /api/unlocks
	ru := doReq(t, h, srv.Token, http.MethodPost, "/api/site/works/work_paid_01/unlock", map[string]any{})
	if ru.Code != http.StatusOK || !strings.Contains(ru.Body.String(), `"unlocked":true`) {
		t.Fatalf("work unlock failed: %d %s", ru.Code, ru.Body.String())
	}
	mu.Lock()
	if capturedUnlock["targetType"] != "work" || capturedUnlock["targetId"] != "work_paid_01" {
		t.Fatalf("unexpected unlock payload: %+v", capturedUnlock)
	}
	mu.Unlock()

	// Inspiration comments GET & POST proxy
	rg := doReq(t, h, srv.Token, http.MethodGet, "/api/site/inspirations/insp_01/comments", nil)
	if rg.Code != http.StatusOK || !strings.Contains(rg.Body.String(), `"topicId":"topic_insp_01"`) {
		t.Fatalf("inspiration comments GET failed: %d %s", rg.Code, rg.Body.String())
	}
	rp := doReq(t, h, srv.Token, http.MethodPost, "/api/site/inspirations/insp_01/comments", map[string]any{"text": "这个配色太绝了"})
	if rp.Code != http.StatusOK || !strings.Contains(rp.Body.String(), `"forumBoard":"prompts"`) {
		t.Fatalf("inspiration comments POST failed: %d %s", rp.Code, rp.Body.String())
	}
	mu.Lock()
	if capturedComment["text"] != "这个配色太绝了" {
		t.Fatalf("unexpected comment payload: %+v", capturedComment)
	}
	mu.Unlock()
}

type recordingHost struct {
	nopHost
	openedPath string
}

func (h *recordingHost) OpenPath(p string) error {
	h.openedPath = p
	return nil
}

func TestMergeAndResolveHistoricalRunRecipeAndExportReveal(t *testing.T) {
	// 1. mergePersistedRecipe combines item fields + parent recipe + resolution/quality
	parent := []byte(`{"styleIds":["FE-052"],"layoutId":"SC-001","colors":["C-01"],"mood":"温暖"}`)
	merged := mergePersistedRecipe(
		[]byte(`{"mode":"poster","ratio":"3:4"}`),
		parent,
		prompt.Input{Tone: "T-02", Extra: "留白多一些"},
		"2K",
		"high",
	)
	var m map[string]any
	if err := json.Unmarshal(merged, &m); err != nil {
		t.Fatal(err)
	}
	if m["layoutId"] != "SC-001" || m["color"] != "C-01" || m["tone"] != "T-02" || m["mood"] != "温暖" || m["resolution"] != "2K" {
		t.Fatalf("unexpected merged recipe: %+v", m)
	}

	// 2. Historical run missing layout/color in Recipe recovers them from PromptZh
	srv, cancel := setupTestServer(t, "")
	defer cancel()
	recHost := &recordingHost{}
	srv.Host = recHost
	h := srv.Handler()
	imgPath := filepath.Join(t.TempDir(), "winter.png")
	writePNG(t, imgPath, 120, 160)
	histRun := &store.Run{
		ID:              "run_hist_winter",
		Mode:            "single",
		Title:           "冬至 · 海报",
		OriginalRequest: "冬至节气海报：青花碗汤圆与饺子",
		PromptZh:        "图型：广告主视觉 / Hero / KV。主题色：中国红（Chinese Red）。影调：柔和自然光。情绪：温馨治愈。主题：冬至节气海报",
		Recipe:          []byte(`{"mode":"poster","ratio":"3:4","styleIds":["FE-052"]}`),
		Status:          "done",
	}
	if err := srv.DB.InsertRun(histRun, []store.Image{{ID: "img_w1", RunID: histRun.ID, Idx: 0, Status: "done", Path: imgPath, Width: 120, Height: 160}}); err != nil {
		t.Fatal(err)
	}

	rrGet := doReq(t, h, srv.Token, http.MethodGet, "/api/works/"+histRun.ID, nil)
	if rrGet.Code != http.StatusOK {
		t.Fatalf("GET work failed: %d %s", rrGet.Code, rrGet.Body.String())
	}
	var detail struct {
		ResolvedRecipe struct {
			StyleIDs   []string            `json:"styleIds"`
			Layout     map[string]string   `json:"layout"`
			ColorItems []map[string]string `json:"colorItems"`
			ToneItems  []map[string]string `json:"toneItems"`
			Mood       string              `json:"mood"`
		} `json:"resolvedRecipe"`
	}
	if err := json.Unmarshal(rrGet.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.ResolvedRecipe.Layout["name"] == "" || !strings.Contains(detail.ResolvedRecipe.Layout["name"], "广告主视觉") {
		t.Fatalf("expected layout recovered from promptZh, got %+v", detail.ResolvedRecipe.Layout)
	}
	if len(detail.ResolvedRecipe.ColorItems) == 0 || !strings.Contains(detail.ResolvedRecipe.ColorItems[0]["name"], "中国红") {
		t.Fatalf("expected color recovered from promptZh, got %+v", detail.ResolvedRecipe.ColorItems)
	}
	if len(detail.ResolvedRecipe.ToneItems) == 0 || detail.ResolvedRecipe.Mood != "温馨治愈" {
		t.Fatalf("expected tone & mood recovered, got tones=%+v mood=%q", detail.ResolvedRecipe.ToneItems, detail.ResolvedRecipe.Mood)
	}

	// 3. Export ZIP returns path/dir/fileName and reveal highlights the exact .zip
	rrExp := doReq(t, h, srv.Token, http.MethodPost, "/api/works/"+histRun.ID+"/export", map[string]any{"format": "zip", "reveal": true})
	if rrExp.Code != http.StatusOK {
		t.Fatalf("export failed: %d %s", rrExp.Code, rrExp.Body.String())
	}
	var expResp struct {
		OK       bool   `json:"ok"`
		Path     string `json:"path"`
		Dir      string `json:"dir"`
		FileName string `json:"fileName"`
	}
	_ = json.Unmarshal(rrExp.Body.Bytes(), &expResp)
	if !expResp.OK || expResp.Path == "" || expResp.Dir == "" || !strings.HasSuffix(expResp.FileName, ".zip") {
		t.Fatalf("unexpected export response: %+v", expResp)
	}
	if _, err := os.Stat(expResp.Path); err != nil {
		t.Fatalf("exported zip not written: %v", err)
	}
	if recHost.openedPath != expResp.Path {
		t.Fatalf("expected export(reveal=true) to open %q, got %q", expResp.Path, recHost.openedPath)
	}
	recHost.openedPath = ""
	rrRev := doReq(t, h, srv.Token, http.MethodPost, "/api/works/"+histRun.ID+"/reveal", map[string]any{"path": expResp.Path})
	if rrRev.Code != http.StatusOK || recHost.openedPath != expResp.Path {
		t.Fatalf("reveal zip failed: code=%d opened=%q want=%q body=%s", rrRev.Code, recHost.openedPath, expResp.Path, rrRev.Body.String())
	}
}
