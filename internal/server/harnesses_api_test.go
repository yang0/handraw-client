package server

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

// TestHelperServerHarness acts as a cross-platform mock CLI binary for server
// harness integration tests when HANDRAW_SRV_HARNESS_ROLE is set.
func TestHelperServerHarness(t *testing.T) {
	role := os.Getenv("HANDRAW_SRV_HARNESS_ROLE")
	if role == "" {
		return
	}
	inBytes, _ := io.ReadAll(os.Stdin)
	inTxt := strings.TrimSpace(string(inBytes))

	switch role {
	case "writer":
		if strings.Contains(inTxt, "请仅回复两个字母") {
			fmt.Println(`{"response":"OK"}`)
		} else if strings.Contains(inTxt, `"content"`) {
			fmt.Println(`{"result":"{\"title\":\"雨夜书店手记\",\"content\":\"# 雨夜书店手记\\n\\n由本地写稿 Harness 生成的正文。\",\"summary\":\"已使用本地写稿 Harness 完成润色\"}"}`)
		} else {
			fmt.Printf(`{"response":"WRITER-REPLY: %s"}`, strings.ReplaceAll(inTxt, `"`, `'`))
		}
	case "chatter":
		fmt.Println(`{"type":"result","is_error":false,"result":"CHATTER-REPLY: 已由聊天专用 Harness 回复"}`)
	default:
		fmt.Fprintln(os.Stderr, "unknown role")
		os.Exit(2)
	}
	os.Exit(0)
}

func TestHarnessesAPIPerSceneRoutingAndCleanup(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	h := srv.Handler()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	// 1. GET /api/harnesses returns built-in catalog & scenes.
	rrList := doReq(t, h, srv.Token, "GET", "/api/harnesses", nil)
	if rrList.Code != 200 {
		t.Fatalf("GET /api/harnesses failed: %d %s", rrList.Code, rrList.Body.String())
	}
	if !strings.Contains(rrList.Body.String(), `"id":"agy"`) || !strings.Contains(rrList.Body.String(), `"id":"kimi"`) || !strings.Contains(rrList.Body.String(), `"articleEdit"`) {
		t.Fatalf("unexpected /api/harnesses payload: %s", rrList.Body.String())
	}

	// 1b. POST /api/harnesses/rescan refreshes discovery cache and returns detectedCount.
	rrRescan := doReq(t, h, srv.Token, "POST", "/api/harnesses/rescan", map[string]any{})
	if rrRescan.Code != 200 || !strings.Contains(rrRescan.Body.String(), `"ok":true`) || !strings.Contains(rrRescan.Body.String(), `"detectedCount"`) {
		t.Fatalf("POST /api/harnesses/rescan failed: %d %s", rrRescan.Code, rrRescan.Body.String())
	}

	// 2. Register two custom harnesses for two different scenes.
	rrPut1 := doReq(t, h, srv.Token, "PUT", "/api/harnesses/mock-writer", map[string]any{
		"name":       "模拟写稿 Harness",
		"driver":     "custom",
		"enabled":    true,
		"command":    exe,
		"extraArgs":  []string{"-test.run=TestHelperServerHarness"},
		"timeoutSec": 30,
	})
	if rrPut1.Code != 200 {
		t.Fatalf("PUT mock-writer failed: %d %s", rrPut1.Code, rrPut1.Body.String())
	}
	rrPut2 := doReq(t, h, srv.Token, "PUT", "/api/harnesses/mock-chatter", map[string]any{
		"name":       "模拟聊天 Harness",
		"driver":     "custom",
		"enabled":    true,
		"command":    exe,
		"extraArgs":  []string{"-test.run=TestHelperServerHarness"},
		"timeoutSec": 30,
	})
	if rrPut2.Code != 200 {
		t.Fatalf("PUT mock-chatter failed: %d %s", rrPut2.Code, rrPut2.Body.String())
	}

	// 3. Test connectivity via POST /api/harnesses/{id}/test.
	t.Setenv("HANDRAW_SRV_HARNESS_ROLE", "writer")
	rrTest := doReq(t, h, srv.Token, "POST", "/api/harnesses/mock-writer/test", map[string]any{})
	if rrTest.Code != 200 || !strings.Contains(rrTest.Body.String(), `"ok":true`) || !strings.Contains(rrTest.Body.String(), `"OK"`) {
		t.Fatalf("POST harness test failed: %d %s", rrTest.Code, rrTest.Body.String())
	}

	// 4. Assign different harnesses to different scenes via PATCH /api/settings.
	rrPatch := doReq(t, h, srv.Token, "PATCH", "/api/settings", map[string]any{
		"sceneModels": map[string]string{
			"articleEdit": "harness:mock-writer",
			"chat":        "harness:mock-chatter",
		},
	})
	if rrPatch.Code != 200 {
		t.Fatalf("PATCH sceneModels failed: %d %s", rrPatch.Code, rrPatch.Body.String())
	}

	// 5. GET /api/models includes harnesses and sceneModels.
	rrMod := doReq(t, h, srv.Token, "GET", "/api/models", nil)
	if rrMod.Code != 200 || !strings.Contains(rrMod.Body.String(), `"mock-writer"`) || !strings.Contains(rrMod.Body.String(), `"articleEdit":"harness:mock-writer"`) {
		t.Fatalf("GET /api/models missing harnesses or sceneModels: %d %s", rrMod.Code, rrMod.Body.String())
	}

	// 6. Article edit automatically routes to sceneModels.articleEdit ("harness:mock-writer") even without explicit textModelRef.
	t.Setenv("HANDRAW_SRV_HARNESS_ROLE", "writer")
	rrArt := doReq(t, h, srv.Token, "POST", "/api/article/edit", map[string]any{
		"title":       "原标题",
		"content":     "旧正文内容",
		"instruction": "帮我改写得更有画面感",
		"mode":        "edit",
	})
	if rrArt.Code != 200 {
		t.Fatalf("POST /api/article/edit via harness failed: %d %s", rrArt.Code, rrArt.Body.String())
	}
	var artOut struct {
		OK      bool   `json:"ok"`
		Source  string `json:"source"`
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(rrArt.Body.Bytes(), &artOut); err != nil {
		t.Fatal(err)
	}
	if !artOut.OK || artOut.Source != "harness" || artOut.Title != "雨夜书店手记" || !strings.Contains(artOut.Content, "本地写稿 Harness") {
		t.Fatalf("unexpected articleEdit harness output: %+v", artOut)
	}

	// 7. Chat turn automatically routes to sceneModels.chat ("harness:mock-chatter").
	t.Setenv("HANDRAW_SRV_HARNESS_ROLE", "chatter")
	rrChat := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages": []map[string]any{{"role": "user", "content": "帮我想三个手绘海报选题"}},
	})
	if rrChat.Code != 200 {
		t.Fatalf("POST /api/chat/turn via harness failed: %d %s", rrChat.Code, rrChat.Body.String())
	}
	if !strings.Contains(rrChat.Body.String(), `"source":"harness"`) || !strings.Contains(rrChat.Body.String(), "CHATTER-REPLY") {
		t.Fatalf("unexpected chatTurn harness output: %s", rrChat.Body.String())
	}

	// 8. Explicit override on /api/prompt/expand routes directly to requested harness.
	t.Setenv("HANDRAW_SRV_HARNESS_ROLE", "writer")
	rrExp := doReq(t, h, srv.Token, "POST", "/api/prompt/expand", map[string]any{
		"theme":    "雨夜小书店",
		"modelRef": "harness:mock-writer",
	})
	if rrExp.Code != 200 || !strings.Contains(rrExp.Body.String(), `"source":"harness"`) || !strings.Contains(rrExp.Body.String(), "WRITER-REPLY") {
		t.Fatalf("POST /api/prompt/expand via harness failed: %d %s", rrExp.Code, rrExp.Body.String())
	}

	// 9. DELETE custom harness removes it and clears stale sceneModels reference.
	rrDel := doReq(t, h, srv.Token, "DELETE", "/api/harnesses/mock-writer", nil)
	if rrDel.Code != 200 {
		t.Fatalf("DELETE mock-writer failed: %d %s", rrDel.Code, rrDel.Body.String())
	}
	if strings.Contains(rrDel.Body.String(), `"articleEdit":"harness:mock-writer"`) {
		t.Fatalf("expected stale sceneModels.articleEdit to be cleared on delete: %s", rrDel.Body.String())
	}
}
