package server

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArticleObsidianAPIAndSecurity(t *testing.T) {
	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	h := srv.Handler()

	// Configure active article vault with a markdown file and an image asset
	vaultDir := filepath.Join(t.TempDir(), "art-vault")
	if err := os.MkdirAll(filepath.Join(vaultDir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vaultDir, "demo.md"), []byte("# Hello\n\n![cover](assets/c.png)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vaultDir, "assets", "c.png"), []byte("\x89PNG\r\n\x1a\nfake"), 0o644); err != nil {
		t.Fatal(err)
	}

	rrRoot := doReq(t, h, srv.Token, "POST", "/api/article/vault/root", map[string]any{"dir": vaultDir})
	if rrRoot.Code != 200 {
		t.Fatalf("set root failed: %d %s", rrRoot.Code, rrRoot.Body.String())
	}

	// Create a fake Obsidian plugin inside vault/.obsidian/plugins/demo-sync
	obsPlugDir := filepath.Join(vaultDir, ".obsidian", "plugins", "demo-sync")
	if err := os.MkdirAll(obsPlugDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(obsPlugDir, "manifest.json"), []byte(`{"id":"demo-sync","name":"Demo Sync","version":"1.0.0"}`), 0o644)
	_ = os.WriteFile(filepath.Join(obsPlugDir, "main.js"), []byte(`const { Plugin } = require("obsidian"); const fs = require("node:fs/promises"); module.exports = class extends Plugin {};`), 0o644)

	// 1. Discover
	rrDisc := doReq(t, h, srv.Token, "GET", "/api/article/obsidian/discover?dir="+vaultDir, nil)
	if rrDisc.Code != 200 {
		t.Fatalf("discover failed: %d %s", rrDisc.Code, rrDisc.Body.String())
	}

	// 2. Batch import
	rrImp := doReq(t, h, srv.Token, "POST", "/api/article/obsidian/import-batch", map[string]any{
		"items":  []map[string]any{{"dir": obsPlugDir, "copyData": true}},
		"enable": true,
	})
	if rrImp.Code != 200 {
		t.Fatalf("import-batch failed: %d %s", rrImp.Code, rrImp.Body.String())
	}

	// 3. Vault list & raw binary read
	rrList := doReq(t, h, srv.Token, "GET", "/api/article/obsidian/vault/list", nil)
	if rrList.Code != 200 {
		t.Fatalf("vault list failed: %d %s", rrList.Code, rrList.Body.String())
	}
	rrBin := doReq(t, h, srv.Token, "GET", "/api/article/obsidian/vault/raw?path=assets/c.png&binary=1", nil)
	if rrBin.Code != 200 {
		t.Fatalf("vault raw binary read failed: %d %s", rrBin.Code, rrBin.Body.String())
	}
	var binResp struct {
		Base64 string `json:"base64"`
	}
	_ = json.Unmarshal(rrBin.Body.Bytes(), &binResp)
	decoded, _ := base64.StdEncoding.DecodeString(binResp.Base64)
	if string(decoded) != "\x89PNG\r\n\x1a\nfake" {
		t.Fatalf("unexpected binary payload: %q", string(decoded))
	}

	// 4. Path escape must be rejected
	if rrEsc := doReq(t, h, srv.Token, "GET", "/api/article/obsidian/vault/raw?path=../outside.txt", nil); rrEsc.Code != 400 {
		t.Fatalf("expected 400 for path escape, got %d", rrEsc.Code)
	}

	// 5. Importing with enable:true must NOT make the plugin runnable: enabling an
	//    Obsidian plugin grants full local access and needs explicit consent (#171).
	fsReq := map[string]any{"pluginId": "demo-sync", "req": map[string]any{"op": "exists", "path": vaultDir}}
	if rr := doReq(t, h, srv.Token, "POST", "/api/article/obsidian/desktop/fs", fsReq); rr.Code != 403 {
		t.Fatalf("expected 403 for plugin without consent, got %d %s", rr.Code, rr.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "GET", "/api/article/obsidian/plugins/demo-sync/bundle", nil); rr.Code != 403 {
		t.Fatalf("bundle must not be served without consent, got %d", rr.Code)
	}

	// 6. Enabling without granting full access is refused with a clear code.
	rrNoConsent := doReq(t, h, srv.Token, "PATCH", "/api/article/obsidian/plugins/demo-sync", map[string]any{"enabled": true})
	if rrNoConsent.Code != 409 || !strings.Contains(rrNoConsent.Body.String(), "needs_full_access") {
		t.Fatalf("expected 409 needs_full_access, got %d %s", rrNoConsent.Code, rrNoConsent.Body.String())
	}

	// 7. Enabling together with explicit consent works.
	rrGrant := doReq(t, h, srv.Token, "PATCH", "/api/article/obsidian/plugins/demo-sync", map[string]any{"enabled": true, "trustedDesktop": true})
	if rrGrant.Code != 200 {
		t.Fatalf("enable with consent failed: %d %s", rrGrant.Code, rrGrant.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "POST", "/api/article/obsidian/desktop/fs", fsReq); rr.Code != 200 {
		t.Fatalf("expected 200 after consent, got %d %s", rr.Code, rr.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "GET", "/api/article/obsidian/plugins/demo-sync/bundle", nil); rr.Code != 200 {
		t.Fatalf("bundle should be served after consent, got %d %s", rr.Code, rr.Body.String())
	}

	// 8. Revoking access also disables the plugin.
	if rr := doReq(t, h, srv.Token, "PATCH", "/api/article/obsidian/plugins/demo-sync", map[string]any{"trustedDesktop": false}); rr.Code != 200 {
		t.Fatalf("revoke failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doReq(t, h, srv.Token, "POST", "/api/article/obsidian/desktop/fs", fsReq); rr.Code != 403 {
		t.Fatalf("expected 403 after revoke, got %d", rr.Code)
	}
	if rr := doReq(t, h, srv.Token, "GET", "/api/article/obsidian/plugins/demo-sync/bundle", nil); rr.Code != 403 {
		t.Fatalf("bundle must not be served after revoke, got %d", rr.Code)
	}
}
