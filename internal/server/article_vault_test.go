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

func TestArticleVaultMultiDirAddSwitchRemove(t *testing.T) {
	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	v1 := filepath.Join(t.TempDir(), "handraw-chat")
	v2 := filepath.Join(t.TempDir(), "obsidian-notes")
	v3 := filepath.Join(t.TempDir(), "weibo-data")
	_ = os.MkdirAll(v1, 0o755)
	_ = os.MkdirAll(v2, 0o755)
	_ = os.MkdirAll(v3, 0o755)
	_ = os.WriteFile(filepath.Join(v1, "chat.md"), []byte("# Chat Note"), 0o644)
	_ = os.WriteFile(filepath.Join(v2, "note.md"), []byte("# Obsidian Note"), 0o644)
	_ = os.WriteFile(filepath.Join(v3, "post.md"), []byte("# Weibo Post"), 0o644)

	type vaultResp struct {
		Dir       string         `json:"dir"`
		Name      string         `json:"name"`
		FileCount int            `json:"fileCount"`
		Vaults    []vaultSummary `json:"vaults"`
	}

	// 1. Add first vault -> active & listed.
	rr1 := doReq(t, h, srv.Token, "POST", "/api/article/vault/vaults", map[string]any{"dir": v1})
	if rr1.Code != 200 {
		t.Fatalf("add v1 failed: %d %s", rr1.Code, rr1.Body.String())
	}
	var res1 vaultResp
	_ = json.Unmarshal(rr1.Body.Bytes(), &res1)
	if res1.Name != "handraw-chat" || len(res1.Vaults) != 1 || !res1.Vaults[0].Active {
		t.Fatalf("unexpected v1 resp: %+v", res1)
	}

	// 2. Add second & third vaults (third without activating).
	rr2 := doReq(t, h, srv.Token, "POST", "/api/article/vault/vaults", map[string]any{"dir": v2})
	if rr2.Code != 200 {
		t.Fatalf("add v2 failed: %d %s", rr2.Code, rr2.Body.String())
	}
	rr3 := doReq(t, h, srv.Token, "POST", "/api/article/vault/vaults", map[string]any{"dir": v3, "activate": false})
	if rr3.Code != 200 {
		t.Fatalf("add v3 failed: %d %s", rr3.Code, rr3.Body.String())
	}
	var res3 vaultResp
	_ = json.Unmarshal(rr3.Body.Bytes(), &res3)
	if res3.Name != "obsidian-notes" || len(res3.Vaults) != 3 {
		t.Fatalf("expected active=obsidian-notes and 3 vaults, got %+v", res3)
	}

	// 3. Switch back to v1 via /api/article/vault/root (no duplication).
	rrSwitch := doReq(t, h, srv.Token, "POST", "/api/article/vault/root", map[string]any{"dir": v1})
	if rrSwitch.Code != 200 {
		t.Fatalf("switch v1 failed: %d %s", rrSwitch.Code, rrSwitch.Body.String())
	}
	var resSw vaultResp
	_ = json.Unmarshal(rrSwitch.Body.Bytes(), &resSw)
	if resSw.Name != "handraw-chat" || len(resSw.Vaults) != 3 {
		t.Fatalf("expected active=handraw-chat and still 3 vaults, got %+v", resSw)
	}

	// 4. Remove active vault v1 -> auto-switches to remaining v2, and disk files in v1 stay untouched!
	rrRem1 := doReq(t, h, srv.Token, "DELETE", "/api/article/vault/vaults", map[string]any{"dir": v1})
	if rrRem1.Code != 200 {
		t.Fatalf("remove v1 failed: %d %s", rrRem1.Code, rrRem1.Body.String())
	}
	var resRem1 vaultResp
	_ = json.Unmarshal(rrRem1.Body.Bytes(), &resRem1)
	if resRem1.Name != "obsidian-notes" || len(resRem1.Vaults) != 2 {
		t.Fatalf("expected fallback to obsidian-notes with 2 vaults, got %+v", resRem1)
	}
	if _, err := os.Stat(filepath.Join(v1, "chat.md")); err != nil {
		t.Fatalf("removing vault must NEVER delete disk files: %v", err)
	}

	// 5. Remove remaining vaults -> falls back gracefully to default <WorksDir>/articles.
	_ = doReq(t, h, srv.Token, "DELETE", "/api/article/vault/vaults", map[string]any{"dir": v2})
	rrRemLast := doReq(t, h, srv.Token, "DELETE", "/api/article/vault/vaults", map[string]any{"dir": v3})
	if rrRemLast.Code != 200 {
		t.Fatalf("remove last failed: %d %s", rrRemLast.Code, rrRemLast.Body.String())
	}
	var resLast vaultResp
	_ = json.Unmarshal(rrRemLast.Body.Bytes(), &resLast)
	if resLast.Name != "articles" || len(resLast.Vaults) != 1 || !resLast.Vaults[0].IsDefault {
		t.Fatalf("expected fallback to default articles vault, got %+v", resLast)
	}
}

func TestArticleVaultFolderMkdirRenameDuplicateDeleteAndSecurity(t *testing.T) {
	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	vault := t.TempDir()
	_ = doReq(t, h, srv.Token, "POST", "/api/article/vault/root", map[string]any{"dir": vault})

	// 1. Create empty nested folder -> visible in tree!
	rrMk := doReq(t, h, srv.Token, "POST", "/api/article/vault/mkdir", map[string]any{"path": "2026/灵感草稿"})
	if rrMk.Code != 200 {
		t.Fatalf("mkdir failed: %d %s", rrMk.Code, rrMk.Body.String())
	}
	rrTree := doReq(t, h, srv.Token, "GET", "/api/article/vault/tree", nil)
	if !strings.Contains(rrTree.Body.String(), "灵感草稿") {
		t.Fatalf("expected empty created folder visible in tree, got %s", rrTree.Body.String())
	}

	// 2. Reject path traversal & hidden dir creation.
	if rrBad := doReq(t, h, srv.Token, "POST", "/api/article/vault/mkdir", map[string]any{"path": "../escape"}); rrBad.Code != 400 {
		t.Fatalf("expected 400 on mkdir traversal, got %d", rrBad.Code)
	}
	if rrHid := doReq(t, h, srv.Token, "POST", "/api/article/vault/mkdir", map[string]any{"path": ".hidden"}); rrHid.Code != 400 {
		t.Fatalf("expected 400 on hidden mkdir, got %d", rrHid.Code)
	}

	// 3. Create note with meta inside 2026/灵感草稿, then rename file -> meta migrates!
	_ = doReq(t, h, srv.Token, "PUT", "/api/article/vault/file", map[string]any{
		"path":    "2026/灵感草稿/草稿一.md",
		"content": "# 草稿一\n\n测试正文",
		"meta":    map[string]any{"style": "FA-099"},
	})
	rrRenFile := doReq(t, h, srv.Token, "POST", "/api/article/vault/rename", map[string]any{
		"from": "2026/灵感草稿/草稿一.md",
		"to":   "2026/灵感草稿/正式稿",
	})
	if rrRenFile.Code != 200 || !strings.Contains(rrRenFile.Body.String(), "2026/灵感草稿/正式稿.md") {
		t.Fatalf("rename file failed: %d %s", rrRenFile.Code, rrRenFile.Body.String())
	}

	// 4. Rename parent folder -> meta still migrates!
	rrRenDir := doReq(t, h, srv.Token, "POST", "/api/article/vault/rename", map[string]any{
		"from": "2026/灵感草稿",
		"to":   "2026/已归档",
	})
	if rrRenDir.Code != 200 {
		t.Fatalf("rename dir failed: %d %s", rrRenDir.Code, rrRenDir.Body.String())
	}
	rrRead := doReq(t, h, srv.Token, "GET", "/api/article/vault/file?path=2026/%E5%B7%B2%E5%BD%92%E6%A1%A3/%E6%AD%A3%E5%BC%8F%E7%A8%BF.md", nil)
	if rrRead.Code != 200 || !strings.Contains(rrRead.Body.String(), "FA-099") {
		t.Fatalf("expected migrated meta FA-099 after folder rename, got %d %s", rrRead.Code, rrRead.Body.String())
	}

	// 5. Duplicate file -> creates 正式稿 副本.md.
	rrDup := doReq(t, h, srv.Token, "POST", "/api/article/vault/duplicate", map[string]any{"path": "2026/已归档/正式稿.md"})
	if rrDup.Code != 200 || !strings.Contains(rrDup.Body.String(), "正式稿 副本.md") {
		t.Fatalf("duplicate failed: %d %s", rrDup.Code, rrDup.Body.String())
	}

	// 6. Delete folder cleanly (and refuse deleting root).
	if rrDelRoot := doReq(t, h, srv.Token, "DELETE", "/api/article/vault/dir?path=", nil); rrDelRoot.Code != 400 {
		t.Fatalf("expected 400 deleting root dir, got %d", rrDelRoot.Code)
	}
	rrDelDir := doReq(t, h, srv.Token, "DELETE", "/api/article/vault/dir?path=2026/%E5%B7%B2%E5%BD%92%E6%A1%A3", nil)
	if rrDelDir.Code != 200 {
		t.Fatalf("delete dir failed: %d %s", rrDelDir.Code, rrDelDir.Body.String())
	}
	if _, err := os.Stat(filepath.Join(vault, "2026", "已归档")); !os.IsNotExist(err) {
		t.Fatalf("expected folder removed from disk")
	}
}
