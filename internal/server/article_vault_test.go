package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArticleVaultTreeReadWriteEmbedAndSecurity(t *testing.T) {
	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	vault := t.TempDir()
	_ = os.MkdirAll(filepath.Join(vault, "2026", "随笔"), 0o755)
	_ = os.MkdirAll(filepath.Join(vault, ".obsidian"), 0o755)
	_ = os.MkdirAll(filepath.Join(vault, "empty_assets"), 0o755)
	_ = os.WriteFile(filepath.Join(vault, ".obsidian", "config.md"), []byte("hidden"), 0o644)
	_ = os.WriteFile(filepath.Join(vault, "empty_assets", "pic.png"), []byte("not-md"), 0o644)
	_ = os.WriteFile(filepath.Join(vault, "README.md"), []byte("# 欢迎来到手绘文章库\n\n第一段正文。"), 0o644)
	_ = os.WriteFile(filepath.Join(vault, "2026", "随笔", "咖啡日记.md"), []byte("# 秋日咖啡日记\n\n清晨手冲一杯浅烘豆。"), 0o644)

	// 1. Set vault root & verify tree structure (prunes .obsidian and non-md empty_assets).
	rrRoot := doReq(t, h, srv.Token, "POST", "/api/article/vault/root", map[string]any{"dir": vault})
	if rrRoot.Code != 200 {
		t.Fatalf("set root failed: %d %s", rrRoot.Code, rrRoot.Body.String())
	}
	var rootRes struct {
		Dir       string      `json:"dir"`
		FileCount int         `json:"fileCount"`
		Tree      []vaultNode `json:"tree"`
	}
	_ = json.Unmarshal(rrRoot.Body.Bytes(), &rootRes)
	if rootRes.FileCount != 2 || len(rootRes.Tree) != 2 {
		t.Fatalf("expected 2 md files and 2 top nodes (2026 dir + README.md), got count=%d tree=%+v", rootRes.FileCount, rootRes.Tree)
	}
	if rootRes.Tree[0].Kind != "dir" || rootRes.Tree[0].Name != "2026" || rootRes.Tree[1].Name != "README.md" {
		t.Fatalf("expected dirs sorted before files, got %+v", rootRes.Tree)
	}

	// 2. Read nested markdown file.
	rrRead := doReq(t, h, srv.Token, "GET", "/api/article/vault/file?path=2026/%E9%9A%8F%E7%AC%94/%E5%92%96%E5%95%A1%E6%97%A5%E8%AE%B0.md", nil)
	if rrRead.Code != 200 {
		t.Fatalf("read file failed: %d %s", rrRead.Code, rrRead.Body.String())
	}
	var readRes struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	_ = json.Unmarshal(rrRead.Body.Bytes(), &readRes)
	if readRes.Title != "秋日咖啡日记" || !strings.Contains(readRes.Content, "清晨手冲") {
		t.Fatalf("unexpected file read: %+v", readRes)
	}

	// 3. Reject path traversal & non-markdown extensions.
	rrEsc := doReq(t, h, srv.Token, "GET", "/api/article/vault/file?path=../secret.md", nil)
	if rrEsc.Code != 400 {
		t.Fatalf("expected 400 for path traversal, got %d", rrEsc.Code)
	}
	rrNonMD := doReq(t, h, srv.Token, "GET", "/api/article/vault/file?path=empty_assets/pic.png", nil)
	if rrNonMD.Code != 400 {
		t.Fatalf("expected 400 for non-md file, got %d", rrNonMD.Code)
	}

	// 4. Write & embed generated image into markdown file as relative assets link + persist sidecar meta.
	imgPath := filepath.Join(t.TempDir(), "gen.png")
	_ = os.WriteFile(imgPath, []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00}, 0o644)
	rrWrite := doReq(t, h, srv.Token, "PUT", "/api/article/vault/file", map[string]any{
		"path":        "2026/随笔/咖啡日记.md",
		"title":       "秋日咖啡日记",
		"content":     "# 秋日咖啡日记\n\n清晨手冲一杯浅烘豆。",
		"meta":        map[string]any{"style": "FA-013"},
		"embedImages": true,
		"slots": []map[string]any{
			{"role": "inline", "anchor": "清晨手冲一杯浅烘豆", "title": "手冲插图", "imagePath": imgPath},
		},
	})
	if rrWrite.Code != 200 {
		t.Fatalf("write embed failed: %d %s", rrWrite.Code, rrWrite.Body.String())
	}
	var writeRes struct {
		Content       string `json:"content"`
		WrittenImages int    `json:"writtenImages"`
	}
	_ = json.Unmarshal(rrWrite.Body.Bytes(), &writeRes)
	if writeRes.WrittenImages != 1 || !strings.Contains(writeRes.Content, "![手冲插图](assets/咖啡日记/01.png)") {
		t.Fatalf("expected embedded relative image link, got %+v", writeRes)
	}
	if _, err := os.Stat(filepath.Join(vault, "2026", "随笔", "assets", "咖啡日记", "01.png")); err != nil {
		t.Fatalf("expected copied asset next to md file: %v", err)
	}

	// 5. Re-read confirms sidecar meta persisted in SQLite without polluting vault.
	rrRead2 := doReq(t, h, srv.Token, "GET", "/api/article/vault/file?path=2026/%E9%9A%8F%E7%AC%94/%E5%92%96%E5%95%A1%E6%97%A5%E8%AE%B0.md", nil)
	if !strings.Contains(rrRead2.Body.String(), `"FA-013"`) {
		t.Fatalf("expected sidecar meta FA-013 returned, got %s", rrRead2.Body.String())
	}

	// 6. Create & delete a new markdown file.
	rrCreate := doReq(t, h, srv.Token, "PUT", "/api/article/vault/file", map[string]any{
		"path":    "2026/新建笔记",
		"content": "# 新建笔记\n\n测试内容",
	})
	if rrCreate.Code != 200 || !strings.Contains(rrCreate.Body.String(), "2026/新建笔记.md") {
		t.Fatalf("create md failed: %d %s", rrCreate.Code, rrCreate.Body.String())
	}
	rrDel := doReq(t, h, srv.Token, "DELETE", "/api/article/vault/file?path=2026/%E6%96%B0%E5%BB%BA%E7%AC%94%E8%AE%B0.md", nil)
	if rrDel.Code != 200 {
		t.Fatalf("delete md failed: %d %s", rrDel.Code, rrDel.Body.String())
	}
}
