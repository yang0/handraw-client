package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

func TestInspirationsCRUDClipOrganizeAndPublish(t *testing.T) {
	var mu sync.Mutex
	var capturedPublish map[string]any
	var capturedGenerate map[string]any

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/me/inspirations":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "items": []any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/ai/chat":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"content": `{
					"title": "手绘雨夜暖灯小书店",
					"prompt": "Warm editorial ink and watercolor bookstore on a rainy evening, glowing window, orange cat sleeping",
					"promptZh": "暖纸手绘水彩风格，雨夜亮着暖灯的小书店，一只橘猫在橱窗里打盹",
					"slots": [
						{"key": "subject", "label": "主角", "defaultValue": "橘猫"},
						{"key": "scene", "label": "地点", "defaultValue": "雨夜小书店"}
					],
					"tags": ["手绘", "书店", "治愈"],
					"suggestedStyle": "FA-001"
				}`,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/inspirations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			capturedPublish = body
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      true,
				"id":      "insp_pub_001",
				"url":     "/inspirations/insp_pub_001",
				"price":   body["price"],
				"reward":  map[string]any{"awarded": 5, "kind": "inspiration_share"},
				"message": "已发布到社区灵感广场",
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/inspirations/feed":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"items": []map[string]any{
					{
						"id":           "insp_pub_001",
						"title":        "手绘雨夜暖灯小书店",
						"price":        5,
						"promptLocked": true,
						"promptPreview": "Warm editorial ink...",
					},
				},
				"total": 1,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/inspirations/insp_pub_001/unlock":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":              true,
				"unlocked":        true,
				"pointsSpent":     5,
				"unlockedContent": "Warm editorial ink and watercolor bookstore",
				"inspiration": map[string]any{
					"id":           "insp_pub_001",
					"prompt":       "Warm editorial ink and watercolor bookstore",
					"promptLocked": false,
					"unlocked":     true,
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/me/creator-earnings":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":             true,
				"publishedCount": 2,
				"totalForks":     4,
				"totalUnlocks":   3,
				"totalEarned":    22,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/studio/quote":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "quoteId": "q_test", "quoteToken": "qt_test", "totalCents": 0, "freeCount": 1, "perImageCents": 0,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/studio/generate":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			capturedGenerate = body
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":        true,
				"imageData": "data:image/png;base64," + base64.StdEncoding.EncodeToString(tinyPNG(t)),
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "not found: " + r.URL.Path})
		}
	}))
	defer mockSite.Close()

	srv, cancel := setupTestServer(t, mockSite.URL)
	defer cancel()

	h := srv.Handler()

	// Unauthenticated public feed proxy should still work via GetPublic.
	recPub := doReq(t, h, srv.Token, http.MethodGet, "/api/site/inspirations", nil)
	if recPub.Code != http.StatusOK {
		t.Fatalf("unauthenticated public feed failed: status=%d body=%s", recPub.Code, recPub.Body.String())
	}

	// Authenticate client with mock site token.
	_ = secrets.Set(secrets.SiteToken, "hwt_test_token")

	// 1. Chrome clip bridge CORS + auth checks.
	clipTok := settings.EnsureClipToken()
	if clipTok == "" {
		t.Fatal("expected non-empty clip token")
	}

	// Preflight OPTIONS from chrome-extension:// should succeed with CORS headers.
	optReq := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:8787/api/inspirations/clip", nil)
	optReq.Host = "127.0.0.1:8787"
	optReq.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	optRec := httptest.NewRecorder()
	h.ServeHTTP(optRec, optReq)
	if optRec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for clip OPTIONS, got %d", optRec.Code)
	}
	if optRec.Header().Get("Access-Control-Allow-Origin") != "chrome-extension://abcdefghijklmnop" {
		t.Fatalf("missing CORS allow-origin header: %q", optRec.Header().Get("Access-Control-Allow-Origin"))
	}

	// Missing clip token should be rejected with 403.
	badClip := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/inspirations/clip", strings.NewReader(`{"rawText":"test"}`))
	badClip.Host = "127.0.0.1:8787"
	badClip.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	badClipRec := httptest.NewRecorder()
	h.ServeHTTP(badClipRec, badClip)
	if badClipRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for missing clip token, got %d", badClipRec.Code)
	}

	// Valid clip from Chrome extension succeeds!
	imgDataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(tinyPNG(t))
	clipBody, _ := json.Marshal(map[string]any{
		"title":        "X 推文灵感",
		"imageDataUrl": imgDataURL,
		"rawText":      "🔥 Amazing prompt!! Warm bookstore on rainy night #AIart #prompt",
		"sourceUrl":    "https://x.com/artist/status/123456",
		"sourceAuthor": "@artist",
		"autoOrganize": false,
	})
	clipReq := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/inspirations/clip", bytes.NewReader(clipBody))
	clipReq.Host = "127.0.0.1:8787"
	clipReq.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	clipReq.Header.Set("X-Handraw-Clip-Token", clipTok)
	clipRec := httptest.NewRecorder()
	h.ServeHTTP(clipRec, clipReq)
	if clipRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for valid clip, got %d: %s", clipRec.Code, clipRec.Body.String())
	}
	var clipResp struct {
		OK   bool            `json:"ok"`
		Item inspirationItem `json:"item"`
	}
	if err := json.Unmarshal(clipRec.Body.Bytes(), &clipResp); err != nil || clipResp.Item.ID == "" {
		t.Fatalf("invalid clip response: %s", clipRec.Body.String())
	}
	if clipResp.Item.Source != "x" {
		t.Fatalf("expected source 'x' inferred from x.com URL, got %q", clipResp.Item.Source)
	}
	inspID := clipResp.Item.ID

	// 2. AI 1-click organize
	orgRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+inspID+"/organize", map[string]any{})
	if orgRec.Code != http.StatusOK {
		t.Fatalf("organize failed: %d %s", orgRec.Code, orgRec.Body.String())
	}
	var orgResp struct {
		OK   bool            `json:"ok"`
		Item inspirationItem `json:"item"`
	}
	_ = json.Unmarshal(orgRec.Body.Bytes(), &orgResp)
	if !orgResp.Item.AIOrganized || orgResp.Item.Title != "手绘雨夜暖灯小书店" || len(orgResp.Item.Slots) != 2 {
		t.Fatalf("unexpected organized item: %+v", orgResp.Item)
	}

	// 3. Publish to community with price=5 (paid unlock)
	pubRec := doReq(t, h, srv.Token, http.MethodPost, "/api/inspirations/"+inspID+"/publish", map[string]any{
		"price": 5,
		"notes": "适合做小红书封面",
	})
	if pubRec.Code != http.StatusOK {
		t.Fatalf("publish failed: %d %s", pubRec.Code, pubRec.Body.String())
	}
	mu.Lock()
	gotPrice := capturedPublish["price"]
	mu.Unlock()
	if gotPrice != float64(5) {
		t.Fatalf("expected published price 5, got %v", gotPrice)
	}

	// 4. Unlock proxy & creator earnings proxy
	unRec := doReq(t, h, srv.Token, http.MethodPost, "/api/site/inspirations/insp_pub_001/unlock", map[string]any{})
	if unRec.Code != http.StatusOK || !strings.Contains(unRec.Body.String(), `"unlocked":true`) {
		t.Fatalf("unlock proxy failed: %d %s", unRec.Code, unRec.Body.String())
	}

	earnRec := doReq(t, h, srv.Token, http.MethodGet, "/api/site/creator-earnings", nil)
	if earnRec.Code != http.StatusOK || !strings.Contains(earnRec.Body.String(), `"totalEarned":22`) {
		t.Fatalf("earnings proxy failed: %d %s", earnRec.Code, earnRec.Body.String())
	}

	// 5. Generate with forkOf passes forkOf to site /api/studio/generate
	genRec := doReq(t, h, srv.Token, http.MethodPost, "/api/generate", map[string]any{
		"mode":      "single",
		"title":     "做同款测试",
		"modelRef":  "site:seedream-4.5",
		"forkOf":    "work_999",
		"confirmed": true,
		"items": []map[string]any{
			{"theme": "雨夜书店", "style": "FA-001", "ratio": "3:4", "mode": "pure-image"},
		},
	})
	if genRec.Code != http.StatusOK {
		t.Fatalf("generate failed: %d %s", genRec.Code, genRec.Body.String())
	}

	// Wait briefly for worker to invoke mockSite /api/studio/generate
	for i := 0; i < 40; i++ {
		mu.Lock()
		got := capturedGenerate
		mu.Unlock()
		if got != nil {
			if got["forkOf"] != "work_999" {
				t.Fatalf("expected forkOf='work_999' in site generate payload, got %v", got["forkOf"])
			}
			break
		}
		if i == 39 {
			t.Fatalf("timed out waiting for mock site /api/studio/generate")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
