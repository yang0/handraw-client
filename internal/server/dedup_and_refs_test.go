package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/store"
)

func writeTestPNGFile(t *testing.T, path string, w, h int, fill color.RGBA) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, fill)
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

func TestSingleChannelDedupAndRefSpecsResolvePipeline(t *testing.T) {
	// Track remote requests to handraw-web
	var resolveCalls int
	var capturedInspPayloads []map[string]any
	var capturedWorkPayloads []map[string]any
	serverKnownHashes := map[string]string{}

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/media/resolve-refs":
			resolveCalls++
			var req struct {
				Hashes []struct {
					SHA256    string `json:"sha256"`
					RawSHA256 string `json:"rawSha256"`
				} `json:"hashes"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			results := make([]map[string]any, 0, len(req.Hashes))
			for _, h := range req.Hashes {
				if url, ok := serverKnownHashes[h.SHA256]; ok {
					results = append(results, map[string]any{
						"sha256":        h.SHA256,
						"matchedSha256": h.SHA256,
						"matched":       true,
						"mediaId":       "med_cached_1",
						"url":           url,
					})
				} else {
					results = append(results, map[string]any{
						"sha256":  h.SHA256,
						"matched": false,
					})
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "results": results})

		case r.Method == http.MethodPost && r.URL.Path == "/api/inspirations":
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			capturedInspPayloads = append(capturedInspPayloads, payload)
			// Record any uploaded ref sha256 into serverKnownHashes for 2nd publish!
			if specs, ok := payload["refSpecs"].([]any); ok {
				for _, raw := range specs {
					if m, ok := raw.(map[string]any); ok && m["source"] == "upload" {
						if sha, _ := m["sha256"].(string); sha != "" {
							serverKnownHashes[sha] = "/uploads/ref_shared.webp"
						}
					}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":  true,
				"id":  "insp_remote_1",
				"url": "/?view=inspirations&id=insp_remote_1",
			})

		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/me/generations":
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			capturedWorkPayloads = append(capturedWorkPayloads, payload)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"workId": "W-501",
				"url":    "/t/work-W-501",
			})

		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "not found"})
		}
	}))
	defer mockSite.Close()

	srv, cancel := setupTestServer(t, mockSite.URL)
	defer cancel()
	h := srv.Handler()
	tmp := t.TempDir()
	_ = secrets.Set(secrets.SiteToken, "hwt_test_dedup_token")
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	// Prepare local images: 1 output image + 1 normal ref image + 1 fake RuiC pose path
	outImg := filepath.Join(tmp, "out1.png")
	refImg := filepath.Join(tmp, "ref_char.png")
	ruicPath := filepath.Join(tmp, "galleries", "ruic-poseatlas", "poses", "pose_042", "3_4_front.jpg")
	writeTestPNGFile(t, outImg, 256, 256, color.RGBA{220, 120, 80, 255})
	writeTestPNGFile(t, refImg, 320, 240, color.RGBA{50, 120, 180, 255})
	writeTestPNGFile(t, ruicPath, 128, 128, color.RGBA{200, 200, 200, 255})

	// 1) Verify parseRuiCPathRef infers coordinates from legacy cached RuiC paths
	gid, iid, variant, ok := parseRuiCPathRef(ruicPath)
	if !ok || gid != "ruic-poses" || iid != "pose_042" || variant != "3_4_front" {
		t.Fatalf("parseRuiCPathRef unexpected: ok=%v gid=%q iid=%q variant=%q", ok, gid, iid, variant)
	}

	// 2) Insert a Skill run already published as a Work -> publishing an inspiration linked to it MUST be blocked
	skillRun := &store.Run{
		ID:              "run_skill_1",
		Mode:            "single",
		Title:           "手绘咖啡馆",
		OriginalRequest: "暖纸咖啡馆",
		Recipe:          json.RawMessage(`{"styleIds":["FA-001"]}`),
		Status:          "done",
		PublishedWorkID: "W-existing",
		PublishedURL:    mockSite.URL + "/t/work-W-existing",
		Meta:            json.RawMessage(`{}`),
	}
	if err := srv.DB.InsertRun(skillRun, []store.Image{{ID: "im_s1", Idx: 0, Status: "done", Path: outImg}}); err != nil {
		t.Fatal(err)
	}
	rrCreateSkillInsp := doReq(t, h, srv.Token, "POST", "/api/inspirations", map[string]any{
		"title":     "绕路灵感",
		"imagePath": outImg,
		"prompt":    "A test prompt",
		"runId":     skillRun.ID,
	})
	if rrCreateSkillInsp.Code != 200 {
		t.Fatalf("create insp failed: %d %s", rrCreateSkillInsp.Code, rrCreateSkillInsp.Body.String())
	}
	var skillInspRes struct {
		Item struct{ ID string `json:"id"` } `json:"item"`
	}
	_ = json.Unmarshal(rrCreateSkillInsp.Body.Bytes(), &skillInspRes)

	rrPubSkillInsp := doReq(t, h, srv.Token, "POST", "/api/inspirations/"+skillInspRes.Item.ID+"/publish", map[string]any{
		"price": 5,
	})
	if rrPubSkillInsp.Code != 400 || !strings.Contains(rrPubSkillInsp.Body.String(), "社区作品") {
		t.Fatalf("expected 400 blocking Skill work from publishing as inspiration, got %d %s", rrPubSkillInsp.Code, rrPubSkillInsp.Body.String())
	}

	// 3) Insert a DirectPrompt run with 1 RuiC pose gallery ref + 1 normal ref image
	refsMeta := []RunRefMeta{
		{Index: 1, Source: "gallery", GalleryID: "ruic-poses", ItemID: "pose_042", Variant: "3_4_front", Label: "侧身回眸", LocalPath: ruicPath},
		{Index: 2, Source: "upload", Label: "主角三视图", LocalPath: refImg},
	}
	directMetaBytes, _ := json.Marshal(map[string]any{"directPrompt": true, "refs": refsMeta})
	directRun := &store.Run{
		ID:              "run_direct_1",
		Mode:            "single",
		Title:           "直出带图参角色",
		OriginalRequest: "参考图1姿态和图2主角绘制插画",
		PromptZh:        "参考图1姿态和图2主角绘制插画",
		Recipe:          json.RawMessage(`{}`),
		Status:          "done",
		Meta:            directMetaBytes,
	}
	if err := srv.DB.InsertRun(directRun, []store.Image{{ID: "im_d1", Idx: 0, Status: "done", Path: outImg}}); err != nil {
		t.Fatal(err)
	}

	rrCreate1 := doReq(t, h, srv.Token, "POST", "/api/inspirations", map[string]any{
		"title":     "直出带图参角色",
		"imagePath": outImg,
		"prompt":    "参考图1姿态和图2主角绘制插画",
		"runId":     directRun.ID,
	})
	if rrCreate1.Code != 200 {
		t.Fatalf("create direct insp failed: %d %s", rrCreate1.Code, rrCreate1.Body.String())
	}
	var insp1Res struct {
		Item struct{ ID string `json:"id"` } `json:"item"`
	}
	_ = json.Unmarshal(rrCreate1.Body.Bytes(), &insp1Res)

	// First publish: RuiC gallery sends 0 bytes (source=gallery); normal ref misses resolve-refs and uploads once (source=upload).
	rrPub1 := doReq(t, h, srv.Token, "POST", "/api/inspirations/"+insp1Res.Item.ID+"/publish", map[string]any{
		"price": 5,
	})
	if rrPub1.Code != 200 {
		t.Fatalf("first direct insp publish failed: %d %s", rrPub1.Code, rrPub1.Body.String())
	}
	if resolveCalls != 1 {
		t.Fatalf("expected 1 resolve-refs preflight call, got %d", resolveCalls)
	}
	if len(capturedInspPayloads) != 1 {
		t.Fatalf("expected 1 inspiration publish call, got %d", len(capturedInspPayloads))
	}
	specs1, _ := capturedInspPayloads[0]["refSpecs"].([]any)
	if len(specs1) != 2 {
		t.Fatalf("expected 2 refSpecs on first publish, got %#v", capturedInspPayloads[0]["refSpecs"])
	}
	s10 := specs1[0].(map[string]any)
	s11 := specs1[1].(map[string]any)
	if s10["source"] != "gallery" || s10["galleryId"] != "ruic-poses" || s10["dataUrl"] != nil {
		t.Fatalf("RuiC gallery ref must be pure coordinate with 0 upload: %#v", s10)
	}
	if s11["source"] != "upload" || !strings.HasPrefix(s11["dataUrl"].(string), "data:image/") {
		t.Fatalf("first normal ref should upload compressed image: %#v", s11)
	}

	// Verify runs table was updated with published_inspiration_id!
	gotRun, err := srv.DB.GetRun(directRun.ID)
	if err != nil || gotRun.PublishedInspirationID != "insp_remote_1" {
		t.Fatalf("expected run.PublishedInspirationID='insp_remote_1', got %+v err=%v", gotRun, err)
	}

	// Attempting to publish this same run as a Work MUST be blocked locally!
	rrWorkBlocked := doReq(t, h, srv.Token, "POST", "/api/works/"+directRun.ID+"/publish", map[string]any{
		"price": 2,
	})
	if rrWorkBlocked.Code != 400 || !strings.Contains(rrWorkBlocked.Body.String(), "灵感广场") {
		t.Fatalf("expected 400 blocking already-published inspiration from publishing as work, got %d %s", rrWorkBlocked.Code, rrWorkBlocked.Body.String())
	}

	// 4) Second publish reusing the SAME normal ref image -> resolve-refs hits and sends 0-byte media_ref!
	rrCreate2 := doReq(t, h, srv.Token, "POST", "/api/inspirations", map[string]any{
		"title":     "第二次复用同一垫图",
		"imagePath": outImg,
		"prompt":    "另一个使用相同主角垫图的提示词",
		"refSpecs":  refsMeta,
	})
	var insp2Res struct {
		Item struct{ ID string `json:"id"` } `json:"item"`
	}
	_ = json.Unmarshal(rrCreate2.Body.Bytes(), &insp2Res)
	rrPub2 := doReq(t, h, srv.Token, "POST", "/api/inspirations/"+insp2Res.Item.ID+"/publish", map[string]any{
		"price": 5,
	})
	if rrPub2.Code != 200 {
		t.Fatalf("second insp publish failed: %d %s", rrPub2.Code, rrPub2.Body.String())
	}
	specs2 := capturedInspPayloads[1]["refSpecs"].([]any)
	s21 := specs2[1].(map[string]any)
	if s21["source"] != "media_ref" || s21["mediaId"] != "med_cached_1" || s21["dataUrl"] != nil {
		t.Fatalf("second publish reusing same ref MUST use 0-byte media_ref, got %#v", s21)
	}
}
