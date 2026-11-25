package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/settings"
)

func TestPatchFrontmatterLossless(t *testing.T) {
	// 1. Existing frontmatter preserves untouched keys, comments, and exact body bytes
	src := "---\ntitle: 测试文章\n# keep comment\ntags:\n  - AI\n  - 漫画\nstatus: 写作中\n---\n\n# 正文标题\n\n第一段包含 [[双链]] 与 **加粗**。\n"
	out := patchFrontmatterLossless(src, map[string]any{
		"status": "已发布",
		"tags":   []string{"AI", "漫画", "爆款"},
		"date":   "2026-11-24",
	}, nil)

	if !strings.Contains(out, "# keep comment") {
		t.Fatalf("expected comment preserved, got:\n%s", out)
	}
	if !strings.Contains(out, "status: 已发布") {
		t.Fatalf("expected updated status, got:\n%s", out)
	}
	if !strings.Contains(out, "tags: [AI, 漫画, 爆款]") {
		t.Fatalf("expected updated tags, got:\n%s", out)
	}
	if !strings.HasSuffix(out, "\n# 正文标题\n\n第一段包含 [[双链]] 与 **加粗**。\n") {
		t.Fatalf("expected body byte-for-byte intact, got:\n%s", out)
	}

	// 2. Document without frontmatter gets clean YAML prepended without altering body
	plain := "# 空白头笔记\n\n正文内容。"
	out2 := patchFrontmatterLossless(plain, map[string]any{"status": "选题池"}, nil)
	if !strings.HasPrefix(out2, "---\nstatus: 选题池\n---\n\n# 空白头笔记\n\n正文内容。") {
		t.Fatalf("unexpected frontmatter prepend:\n%s", out2)
	}
}

func TestArticleVaultTableAndPatchAPI(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HANDRAW_DATA_DIR", filepath.Join(tmp, "data"))
	vault := filepath.Join(tmp, "vault")
	if err := os.MkdirAll(filepath.Join(vault, "选题库"), 0o755); err != nil {
		t.Fatal(err)
	}
	notePath := filepath.Join(vault, "选题库", "01-漫剧实测.md")
	orig := "---\ntitle: 漫剧实测\nstatus: 写作中\ntags: [漫剧, 变现]\n---\n\n# 漫剧实测\n\n参考 [[02-配图方法]]。\n"
	if err := os.WriteFile(notePath, []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vault, "选题库", "02-配图方法.md"), []byte("# 配图方法\n\n正文。"), 0o644); err != nil {
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

	// GET /api/article/vault/table
	req := httptest.NewRequest(http.MethodGet, "/api/article/vault/table?dir=选题库", nil)
	rec := httptest.NewRecorder()
	resAny, err := srv.articleVaultTable(rec, req)
	if err != nil {
		t.Fatalf("articleVaultTable failed: %v", err)
	}
	resMap := resAny.(map[string]any)
	rows := resMap["rows"].([]vaultTableRow)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}

	// PATCH /api/article/vault/frontmatter
	payload, _ := json.Marshal(map[string]any{
		"path": "选题库/01-漫剧实测.md",
		"set":  map[string]any{"status": "已发布"},
	})
	pReq := httptest.NewRequest(http.MethodPatch, "/api/article/vault/frontmatter", bytes.NewReader(payload))
	pRec := httptest.NewRecorder()
	if _, err := srv.articleVaultPatchFrontmatter(pRec, pReq); err != nil {
		t.Fatalf("articleVaultPatchFrontmatter failed: %v", err)
	}
	disk, err := os.ReadFile(notePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(disk), "status: 已发布") || !strings.Contains(string(disk), "参考 [[02-配图方法]]。") {
		t.Fatalf("unexpected patched disk content:\n%s", string(disk))
	}
}
