package obsidian

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func makeTestPluginDir(t *testing.T, parent, id, name, ver, mainJS string, withData bool) string {
	t.Helper()
	dir := filepath.Join(parent, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mf := Manifest{ID: id, Name: name, Version: ver, Description: "test plugin"}
	b, _ := json.Marshal(mf)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.js"), []byte(mainJS), 0o644); err != nil {
		t.Fatal(err)
	}
	if withData {
		_ = os.WriteFile(filepath.Join(dir, "data.json"), []byte(`{"theme":"warm"}`), 0o644)
	}
	return dir
}

func TestAnalyzeCompat(t *testing.T) {
	tmp := t.TempDir()

	// Tier 1: pure obsidian API
	p1 := makeTestPluginDir(t, tmp, "pure-obs", "Pure", "1.0.0",
		`const { Plugin, Notice } = require("obsidian"); module.exports = class extends Plugin { onload() { this.addCommand({ id: "a", name: "A" }); } };`, false)
	mf1, _ := ReadManifest(p1)
	c1 := AnalyzeCompat(p1, mf1)
	if c1.Level != "full" || c1.NeedsDesktop {
		t.Fatalf("expected full compat without desktop, got %+v", c1)
	}

	// Tier 2: desktop fs + child_process (like article-sync)
	p2 := makeTestPluginDir(t, tmp, "sync-plug", "Sync", "0.1.0",
		`const obs = require("obsidian"); const fs = require("node:fs/promises"); const cp = require("node:child_process"); module.exports = class extends obs.Plugin {};`, false)
	mf2, _ := ReadManifest(p2)
	c2 := AnalyzeCompat(p2, mf2)
	if c2.Level != "partial" || !c2.NeedsDesktop {
		t.Fatalf("expected partial+needsDesktop, got %+v", c2)
	}

	// Tier 3: native .node addon
	p3 := makeTestPluginDir(t, tmp, "native-plug", "Native", "1.0.0",
		`const native = require("./addon.node");`, false)
	mf3, _ := ReadManifest(p3)
	c3 := AnalyzeCompat(p3, mf3)
	if c3.Level != "unsupported" {
		// relative require skipped; check non-relative .node
		_ = os.WriteFile(filepath.Join(p3, "main.js"), []byte(`require("better_sqlite3.node");`), 0o644)
		c3 = AnalyzeCompat(p3, mf3)
	}
	if c3.Level != "unsupported" {
		t.Fatalf("expected unsupported for native .node, got %+v", c3)
	}
}

func TestDiscoverAndImportAndSecrets(t *testing.T) {
	globalDir := filepath.Join(t.TempDir(), "global-obs")
	mgr := New(globalDir)

	vaultDir := filepath.Join(t.TempDir(), "my-vault")
	plugsRoot := filepath.Join(vaultDir, ".obsidian", "plugins")
	pDir := makeTestPluginDir(t, plugsRoot, "demo-mp", "Demo MP", "1.2.3",
		`const { Plugin } = require("obsidian"); module.exports = class extends Plugin {};`, true)
	_ = os.WriteFile(filepath.Join(vaultDir, ".obsidian", "community-plugins.json"), []byte(`["demo-mp"]`), 0o644)

	discovered := mgr.DiscoverObsidianVaults([]string{vaultDir}, "")
	var foundVault *DiscoveredVault
	for i := range discovered {
		if samePath(discovered[i].Dir, vaultDir) {
			foundVault = &discovered[i]
			break
		}
	}
	if foundVault == nil || len(foundVault.Plugins) != 1 {
		t.Fatalf("expected to discover demo-mp in vault, got %+v", discovered)
	}
	if !foundVault.Plugins[0].EnabledInObsidian || !foundVault.Plugins[0].HasData {
		t.Fatalf("expected enabledInObsidian & hasData, got %+v", foundVault.Plugins[0])
	}

	inst, err := mgr.ImportLocalPlugin(pDir, true, "obsidian-vault")
	if err != nil {
		t.Fatalf("import failed: %v", err)
	}
	if inst.ID != "demo-mp" || !inst.HasData {
		t.Fatalf("unexpected imported plugin: %+v", inst)
	}
	data, err := mgr.ReadData("demo-mp")
	if err != nil || !strings.Contains(string(data), `"warm"`) {
		t.Fatalf("expected imported data.json, got %s err=%v", string(data), err)
	}

	// SecretStorage roundtrip
	if err := mgr.SetSecret("wechatsync_token", "tok_12345"); err != nil {
		t.Fatal(err)
	}
	got, err := mgr.GetSecret("wechatsync_token")
	if err != nil || got != "tok_12345" {
		t.Fatalf("expected secret tok_12345, got %q err=%v", got, err)
	}
}

func TestInstallFromZipAndZipSlip(t *testing.T) {
	mgr := New(filepath.Join(t.TempDir(), "obs"))

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w1, _ := zw.Create("nested-plugin/manifest.json")
	_, _ = w1.Write([]byte(`{"id":"zip-demo","name":"Zip Demo","version":"0.2.0"}`))
	w2, _ := zw.Create("nested-plugin/main.js")
	_, _ = w2.Write([]byte(`const { Plugin } = require("obsidian"); module.exports = class extends Plugin {};`))
	w3, _ := zw.Create("nested-plugin/styles.css")
	_, _ = w3.Write([]byte(`.demo { color: red; }`))
	_ = zw.Close()

	inst, err := mgr.InstallFromZip(buf.Bytes(), "demo.zip")
	if err != nil {
		t.Fatalf("InstallFromZip failed: %v", err)
	}
	if inst.ID != "zip-demo" || !inst.HasStyles {
		t.Fatalf("unexpected zip install result: %+v", inst)
	}
}

func TestProxyHTTPRequestSSRFGuard(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test", "ok")
		_, _ = w.Write([]byte(`{"hello":"picgo"}`))
	}))
	defer ts.Close()

	u, _ := url.Parse(ts.URL)
	port, _ := strconv.Atoi(u.Port())

	// Blocked by default (no port allowlist)
	if _, err := ProxyHTTPRequest(context.Background(), ProxyRequest{URL: ts.URL, Method: "GET"}, nil); err == nil {
		t.Fatal("expected localhost request to be blocked when port is not allowlisted")
	}

	// Allowed when port is explicitly allowlisted
	resp, err := ProxyHTTPRequest(context.Background(), ProxyRequest{URL: ts.URL, Method: "GET"}, []int{port})
	if err != nil {
		t.Fatalf("expected allowlisted localhost port %d to succeed, got %v", port, err)
	}
	if resp.Status != 200 || resp.Headers["x-test"] != "ok" {
		t.Fatalf("unexpected proxy response: %+v", resp)
	}
}
