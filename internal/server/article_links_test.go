package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArticleVaultLinksBacklinksRenameAndAssets(t *testing.T) {
	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	vault := t.TempDir()
	_ = os.MkdirAll(filepath.Join(vault, "assets"), 0o755)
	_ = os.WriteFile(filepath.Join(vault, "assets", "cover.png"), []byte("\x89PNG\r\n\x1a\nimg"), 0o644)
	_ = os.WriteFile(filepath.Join(vault, "咖啡指南.md"), []byte("---\naliases: [手冲指南, PourOver]\n---\n# 咖啡指南\n\n## 冲煮参数\n\n水温 92 度，参考 [[待写的新笔记]] 与 ![[cover.png]]。\n"), 0o644)
	_ = os.WriteFile(filepath.Join(vault, "晨间日记.md"), []byte("# 晨间日记\n\n今天照着 [[咖啡指南#冲煮参数|我的手冲笔记]] 泡了一杯。\n\n```md\n[[咖啡指南]] 代码块里不应被误改\n```\n\n另附相对链接：[参考](咖啡指南.md)\n"), 0o644)
	_ = os.WriteFile(filepath.Join(vault, "器材清单.md"), []byte("# 器材清单\n\n这篇里提到了手冲指南，但还没加双链。\n"), 0o644)

	rrRoot := doReq(t, h, srv.Token, "POST", "/api/article/vault/root", map[string]any{"dir": vault})
	if rrRoot.Code != 200 {
		t.Fatalf("set root failed: %d %s", rrRoot.Code, rrRoot.Body.String())
	}

	// 1. Fetch links index for 咖啡指南.md
	rrLinks := doReq(t, h, srv.Token, "GET", "/api/article/vault/links?path=%E5%92%96%E5%95%A1%E6%8C%87%E5%8D%97.md", nil)
	if rrLinks.Code != 200 {
		t.Fatalf("links api failed: %d %s", rrLinks.Code, rrLinks.Body.String())
	}
	var payload struct {
		Outgoing         []parsedVaultLink      `json:"outgoing"`
		Backlinks        []vaultBacklink        `json:"backlinks"`
		UnlinkedMentions []vaultUnlinkedMention `json:"unlinkedMentions"`
		Graph            struct {
			Nodes []vaultGraphNode `json:"nodes"`
			Edges []vaultGraphEdge `json:"edges"`
		} `json:"graph"`
	}
	if err := json.Unmarshal(rrLinks.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Outgoing) != 2 {
		t.Fatalf("expected 2 outgoing links (1 unresolved note + 1 cover image), got %+v", payload.Outgoing)
	}
	if len(payload.Backlinks) != 2 || payload.Backlinks[0].SourcePath != "晨间日记.md" || payload.Backlinks[1].SourcePath != "晨间日记.md" {
		t.Fatalf("expected 2 backlinks (wikilink + relative md link) from 晨间日记.md, got %+v", payload.Backlinks)
	}
	if len(payload.UnlinkedMentions) != 1 || payload.UnlinkedMentions[0].SourcePath != "器材清单.md" || payload.UnlinkedMentions[0].MatchText != "手冲指南" {
		t.Fatalf("expected 1 unlinked alias mention in 器材清单.md, got %+v", payload.UnlinkedMentions)
	}
	// Graph should have 4 nodes (3 real notes + 1 unresolved '待写的新笔记')
	if len(payload.Graph.Nodes) != 4 || len(payload.Graph.Edges) != 2 {
		t.Fatalf("unexpected graph nodes=%d edges=%d", len(payload.Graph.Nodes), len(payload.Graph.Edges))
	}

	// 2. One-click linkify unlinked mention
	rrLinkify := doReq(t, h, srv.Token, "POST", "/api/article/vault/links/linkify", map[string]any{
		"sourcePath": "器材清单.md",
		"line":       3,
		"matchText":  "手冲指南",
		"targetName": "咖啡指南",
	})
	if rrLinkify.Code != 200 {
		t.Fatalf("linkify failed: %d %s", rrLinkify.Code, rrLinkify.Body.String())
	}
	eqRaw, _ := os.ReadFile(filepath.Join(vault, "器材清单.md"))
	if !strings.Contains(string(eqRaw), "[[咖啡指南|手冲指南]]") {
		t.Fatalf("expected linkified wikilink, got: %s", string(eqRaw))
	}

	// 3. Rename 咖啡指南.md -> 手冲咖啡指南.md and verify automatic link rewrite!
	rrRen := doReq(t, h, srv.Token, "POST", "/api/article/vault/rename", map[string]any{
		"from": "咖啡指南.md",
		"to":   "手冲咖啡指南.md",
	})
	if rrRen.Code != 200 {
		t.Fatalf("rename failed: %d %s", rrRen.Code, rrRen.Body.String())
	}
	var renResp struct {
		UpdatedLinkFiles int `json:"updatedLinkFiles"`
	}
	_ = json.Unmarshal(rrRen.Body.Bytes(), &renResp)
	if renResp.UpdatedLinkFiles != 2 {
		t.Fatalf("expected 2 referencing files updated (晨间日记 + 器材清单), got %d", renResp.UpdatedLinkFiles)
	}
	diaryRaw, _ := os.ReadFile(filepath.Join(vault, "晨间日记.md"))
	diaryStr := string(diaryRaw)
	if !strings.Contains(diaryStr, "[[手冲咖啡指南#冲煮参数|我的手冲笔记]]") {
		t.Fatalf("expected wikilink updated in 晨间日记.md, got: %s", diaryStr)
	}
	if !strings.Contains(diaryStr, "[参考](手冲咖啡指南.md)") {
		t.Fatalf("expected relative md link updated in 晨间日记.md, got: %s", diaryStr)
	}
	if !strings.Contains(diaryStr, "[[咖啡指南]] 代码块里不应被误改") {
		t.Fatalf("code fence wikilink should NOT be rewritten, got: %s", diaryStr)
	}

	// 4. Vault asset serving (shortest-path lookup + escape guard)
	reqAsset := httptest.NewRequest("GET", "http://127.0.0.1/files/vault-asset?path=cover.png&t="+srv.Token, nil)
	rrAsset := httptest.NewRecorder()
	h.ServeHTTP(rrAsset, reqAsset)
	if rrAsset.Code != http.StatusOK || rrAsset.Body.String() != "\x89PNG\r\n\x1a\nimg" {
		t.Fatalf("expected shortest-path vault asset served, got %d %q", rrAsset.Code, rrAsset.Body.String())
	}

	reqEsc := httptest.NewRequest("GET", "http://127.0.0.1/files/vault-asset?path=../secret.png&t="+srv.Token, nil)
	rrEsc := httptest.NewRecorder()
	h.ServeHTTP(rrEsc, reqEsc)
	if rrEsc.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for escaped asset path, got %d", rrEsc.Code)
	}
}
