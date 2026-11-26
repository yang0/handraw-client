package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDSHManifestInstallLocalAndCompat(t *testing.T) {
	pluginsRoot := t.TempDir()
	r := NewRuntime(pluginsRoot)

	// 1. Fully compatible DSH plugin with cordis.patch.yml config.
	srcFull := t.TempDir()
	_ = os.WriteFile(filepath.Join(srcFull, "package.json"), []byte(`{
		"name": "dsh-plugin-demo",
		"version": "1.2.0",
		"type": "module",
		"exports": { ".": "./host.js", "./client": "./client.js" },
		"dsh": {
			"bundle": { "patch": "./cordis.patch.yml" },
			"client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar"] }
		}
	}`), 0o644)
	_ = os.WriteFile(filepath.Join(srcFull, "cordis.patch.yml"), []byte("- insert:\n    - id: demo-studio\n      name: dsh-plugin-demo\n      config:\n        port: 38650\n        autoStart: true\n        label: \"demo\"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(srcFull, "host.js"), []byte(`export function apply(ctx){ ctx.connection.fetch.register({path:'/api/demo.ping', fetch:()=>new Response('ok')}) }`), 0o644)
	_ = os.WriteFile(filepath.Join(srcFull, "client.js"), []byte(`window.__ModuleLoader__.load({id:'dsh-plugin-demo', factory:()=>({})})`), 0o644)

	c, err := r.InstallLocal("link:" + srcFull)
	if err != nil {
		t.Fatalf("InstallLocal failed: %v", err)
	}
	if c.Kind != "dsh" || c.TrustLevel != "L2" || c.DSH == nil {
		t.Fatalf("unexpected plugin kind/meta: %+v", c)
	}
	if c.DSH.Compat != "full" || c.DSH.PluginID != "demo-studio" {
		t.Fatalf("unexpected dsh meta: %+v", c.DSH)
	}
	if c.DSH.Config["port"] != int64(38650) || c.DSH.Config["autoStart"] != true || c.DSH.Config["label"] != "demo" {
		t.Fatalf("unexpected cordis config: %+v", c.DSH.Config)
	}
	// FilePath resolves through .link.
	// Compare canonical paths: CI temp dirs differ in spelling from the real
	// path (Windows 8.3 short names, macOS /var -> /private/var) (#167).
	if fp, ok := r.FilePath(c.ID, "client.js"); !ok || !samePath(t, fp, filepath.Join(srcFull, "client.js")) {
		t.Fatalf("FilePath failed: %q %v", fp, ok)
	}
	// Remove deletes link slot, preserves original source directory.
	if err := r.Remove(c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(srcFull, "host.js")); err != nil {
		t.Fatal("Remove deleted original linked folder!")
	}

	// 2. Partial compatibility plugin (uses remote.session).
	srcPartial := t.TempDir()
	_ = os.WriteFile(filepath.Join(srcPartial, "package.json"), []byte(`{"name":"dsh-partial","version":"0.1.0","main":"./host.js","dsh":{"client":{"platform":"web"}}}`), 0o644)
	_ = os.WriteFile(filepath.Join(srcPartial, "host.js"), []byte(`export function apply(ctx){ ctx.get('remote'); }`), 0o644)
	cp, err := ReadCommunity(srcPartial)
	if err != nil || cp.DSH == nil || cp.DSH.Compat != "partial" {
		t.Fatalf("expected partial compat, got %+v err=%v", cp.DSH, err)
	}

	// 3. Unsupported plugin (requires ui-conversation).
	srcUnsup := t.TempDir()
	_ = os.WriteFile(filepath.Join(srcUnsup, "package.json"), []byte(`{"name":"dsh-chat-ext","version":"0.1.0","exports":{".":"./host.js","./client":"./client.js"},"dsh":{"client":{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-conversation"]}}}`), 0o644)
	_ = os.WriteFile(filepath.Join(srcUnsup, "host.js"), []byte(`export function apply(){}`), 0o644)
	_ = os.WriteFile(filepath.Join(srcUnsup, "client.js"), []byte(`useSession()`), 0o644)
	cu, err := ReadCommunity(srcUnsup)
	if err != nil || cu.DSH == nil || cu.DSH.Compat != "unsupported" {
		t.Fatalf("expected unsupported compat, got %+v err=%v", cu.DSH, err)
	}
}

func samePath(t *testing.T, a, b string) bool {
	t.Helper()
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA != nil || errB != nil {
		return a == b
	}
	return strings.EqualFold(filepath.Clean(ra), filepath.Clean(rb))
}
