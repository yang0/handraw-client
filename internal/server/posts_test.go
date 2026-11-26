package server

import (
	"encoding/json"
	"image/color"
	"os"
	"path/filepath"
	"testing"

	"github.com/yang0/handraw-client/internal/store"
)

type postResp struct {
	Post         postView `json:"post"`
	TextConflict bool     `json:"textConflict"`
	Dir          string   `json:"dir"`
	Count        int      `json:"count"`
	Text         string   `json:"text"`
}

func decodePostResp(t *testing.T, code int, body []byte) postResp {
	t.Helper()
	if code != 200 {
		t.Fatalf("unexpected status %d: %s", code, body)
	}
	var out postResp
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPostsAssembleEditAndExport(t *testing.T) {
	srv, cancel := setupTestServer(t, "")
	defer cancel()
	h := srv.Handler()
	tmp := t.TempDir()

	var imgs []store.Image
	for i, c := range []color.RGBA{{200, 80, 60, 255}, {60, 160, 90, 255}, {40, 80, 200, 255}} {
		p := filepath.Join(tmp, "img", string(rune('a'+i))+".png")
		writeTestPNGFile(t, p, 300, 400, c)
		imgs = append(imgs, store.Image{ID: "im_" + string(rune('a'+i)), Idx: i, Status: "done", Path: p})
	}
	run := &store.Run{ID: "run_post_1", Mode: "canvas", Title: "咖啡", Status: "done", Recipe: json.RawMessage(`{}`), Meta: json.RawMessage(`{}`)}
	if err := srv.DB.InsertRun(run, imgs); err != nil {
		t.Fatal(err)
	}
	refs := []map[string]string{{"runId": run.ID, "imageId": "im_a"}, {"runId": run.ID, "imageId": "im_b"}, {"runId": run.ID, "imageId": "im_c"}}
	copyV1 := map[string]any{"titles": []string{"标题一", "标题二"}, "activeTitle": "标题一", "content": "正文 v1", "tags": []string{"#咖啡", "手冲"}}

	// 1) First assemble creates a draft.
	rr := doReq(t, h, srv.Token, "POST", "/api/posts/assemble", map[string]any{"canvasId": "cv1", "nodeId": "post1", "platform": "xiaohongshu", "images": refs, "copy": copyV1})
	r1 := decodePostResp(t, rr.Code, rr.Body.Bytes())
	id := r1.Post.ID
	if id == "" || r1.Post.Title != "标题一" || len(r1.Post.Resolved) != 3 || r1.Post.Tags[0] != "咖啡" || r1.Post.Status != "draft" {
		t.Fatalf("bad first assemble: %+v", r1.Post)
	}

	// 2) Re-assemble updates the same post.
	copyV2 := map[string]any{"titles": []string{"新标题"}, "activeTitle": "新标题", "content": "正文 v2", "tags": []string{"咖啡"}}
	rr = doReq(t, h, srv.Token, "POST", "/api/posts/assemble", map[string]any{"postId": id, "nodeId": "post1", "images": refs, "copy": copyV2})
	r2 := decodePostResp(t, rr.Code, rr.Body.Bytes())
	if r2.Post.ID != id || r2.Post.Body != "正文 v2" || r2.TextConflict {
		t.Fatalf("re-assemble should update same post: %+v conflict=%v", r2.Post, r2.TextConflict)
	}

	// 3) User edits text + order + cover in the editor.
	rr = doReq(t, h, srv.Token, "PUT", "/api/posts/"+id, map[string]any{
		"body":       "我手动改的正文",
		"images":     []map[string]string{refs[2], refs[0]},
		"coverIndex": 0,
	})
	r3 := decodePostResp(t, rr.Code, rr.Body.Bytes())
	if !r3.Post.TextEdited || !r3.Post.ImageEdited || len(r3.Post.Images) != 2 || r3.Post.Images[0].ImageID != "im_c" {
		t.Fatalf("edit not applied: %+v", r3.Post)
	}

	// 4) Canvas re-assemble must not clobber user edits; reports conflict.
	rr = doReq(t, h, srv.Token, "POST", "/api/posts/assemble", map[string]any{"postId": id, "nodeId": "post1", "images": refs, "copy": copyV1})
	r4 := decodePostResp(t, rr.Code, rr.Body.Bytes())
	if r4.Post.Body != "我手动改的正文" || !r4.TextConflict {
		t.Fatalf("user text should be kept with conflict flag: %+v conflict=%v", r4.Post, r4.TextConflict)
	}
	if len(r4.Post.Images) != 2 || r4.Post.Images[0].ImageID != "im_c" {
		t.Fatalf("user image order should be kept: %+v", r4.Post.Images)
	}

	// 5) Explicit overwrite takes the canvas copy.
	rr = doReq(t, h, srv.Token, "POST", "/api/posts/assemble", map[string]any{"postId": id, "nodeId": "post1", "images": refs, "copy": copyV1, "overwriteText": true})
	r5 := decodePostResp(t, rr.Code, rr.Body.Bytes())
	if r5.Post.Body != "正文 v1" || r5.Post.TextEdited {
		t.Fatalf("overwrite failed: %+v", r5.Post)
	}

	// 6) Export: cover first, 3:4 jpgs + copy text.
	rr = doReq(t, h, srv.Token, "POST", "/api/posts/"+id+"/export", map[string]any{})
	r6 := decodePostResp(t, rr.Code, rr.Body.Bytes())
	if r6.Count != 2 {
		t.Fatalf("expected 2 exported images, got %d", r6.Count)
	}
	for _, f := range []string{"01.jpg", "02.jpg", "笔记文案.txt"} {
		if _, err := os.Stat(filepath.Join(r6.Dir, f)); err != nil {
			t.Fatalf("missing export file %s: %v", f, err)
		}
	}
	txt, _ := os.ReadFile(filepath.Join(r6.Dir, "笔记文案.txt"))
	if string(txt) != "标题一\n\n正文 v1\n\n#咖啡 #手冲" {
		t.Fatalf("unexpected copy text: %q", txt)
	}

	// 7) List + delete.
	rr = doReq(t, h, srv.Token, "GET", "/api/posts?platform=xiaohongshu", nil)
	var list struct{ Items []postView }
	_ = json.Unmarshal(rr.Body.Bytes(), &list)
	if len(list.Items) != 1 || list.Items[0].Status != "exported" {
		t.Fatalf("list unexpected: %s", rr.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "DELETE", "/api/posts/"+id, nil); rr.Code != 200 {
		t.Fatalf("delete failed: %d", rr.Code)
	}
	if rr := doReq(t, h, srv.Token, "GET", "/api/posts/"+id, nil); rr.Code != 404 {
		t.Fatalf("expected 404 after delete, got %d", rr.Code)
	}
}
