package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yang0/handraw-client/internal/settings"
)

func TestArticleVaultCanvasCRUDAndTree(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HANDRAW_DATA_DIR", filepath.Join(tmp, "data"))
	vault := filepath.Join(tmp, "vault")
	if err := os.MkdirAll(vault, 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := settings.Update(func(st *settings.Settings) error {
		st.ArticleVaultDir = vault
		st.ArticleVaultDirs = []string{vault}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	srv := &Server{}

	// 1. Write standalone JSON Canvas 1.0 file
	putBody, _ := json.Marshal(map[string]any{
		"path": "灵感白板.canvas",
		"data": map[string]any{
			"nodes": []any{
				map[string]any{"id": "n1", "type": "text", "text": "核心观点", "x": 100, "y": 100, "width": 260, "height": 140},
			},
			"edges": []any{},
		},
	})
	wRec := httptest.NewRecorder()
	if _, err := srv.articleVaultWriteCanvas(wRec, httptest.NewRequest(http.MethodPut, "/api/article/vault/canvas", bytes.NewReader(putBody))); err != nil {
		t.Fatalf("write standalone canvas failed: %v", err)
	}

	// 2. Verify scanVaultTree discovers .canvas with Kind="canvas"
	tree, count := scanVaultTree(vault)
	if count != 1 || len(tree) != 1 || tree[0].Kind != "canvas" || tree[0].Name != "灵感白板.canvas" {
		t.Fatalf("expected canvas node in vault tree, got count=%d tree=%+v", count, tree)
	}

	// 3. Companion board for a note lives cleanly inside hidden .handraw/boards/
	compBody, _ := json.Marshal(map[string]any{
		"note": "专题/测试文章.md",
		"data": map[string]any{
			"nodes": []any{
				map[string]any{"id": "g1", "type": "group", "label": "第一幕", "x": 40, "y": 40, "width": 500, "height": 360},
			},
			"edges": []any{},
		},
	})
	cRec := httptest.NewRecorder()
	if _, err := srv.articleVaultWriteCanvas(cRec, httptest.NewRequest(http.MethodPut, "/api/article/vault/canvas", bytes.NewReader(compBody))); err != nil {
		t.Fatalf("write companion canvas failed: %v", err)
	}
	rRec := httptest.NewRecorder()
	readAny, err := srv.articleVaultReadCanvas(rRec, httptest.NewRequest(http.MethodGet, "/api/article/vault/canvas?note=专题/测试文章.md", nil))
	if err != nil {
		t.Fatalf("read companion canvas failed: %v", err)
	}
	readMap := readAny.(map[string]any)
	if readMap["exists"] != true {
		t.Fatalf("expected companion canvas to exist")
	}

	// 4. Hidden companion board must NOT pollute scanVaultTree
	_, countAfter := scanVaultTree(vault)
	if countAfter != 1 {
		t.Fatalf("companion board should stay hidden from tree, got count=%d", countAfter)
	}

	// 5. Reject path traversal
	badReq := httptest.NewRequest(http.MethodGet, "/api/article/vault/canvas?path=../escape.canvas", nil)
	if _, err := srv.articleVaultReadCanvas(httptest.NewRecorder(), badReq); err == nil {
		t.Fatalf("expected path traversal rejection")
	}
}
