package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/dshbridge"
)

func TestDSHPluginEndToEndInstallProxyAndGalleries(t *testing.T) {
	if p, _ := dshbridge.DetectNode(); p == "" {
		t.Skip("node not available")
	}

	srv, cancelJobs := setupTestServer(t, "")
	defer cancelJobs()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr, err := srv.Listen(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if srv.DSH != nil {
			srv.DSH.Stop()
		}
	})

	// Create a real local DSH plugin on disk.
	plugDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(plugDir, "package.json"), []byte(`{
		"name": "dsh-plugin-hair-demo",
		"version": "0.1.0",
		"type": "module",
		"exports": { ".": "./host.js", "./client": "./client.js" },
		"dsh": {
			"client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar"] }
		}
	}`), 0o644)
	_ = os.WriteFile(filepath.Join(plugDir, "host.js"), []byte(`
export async function apply(ctx) {
  const hr = ctx.get('handraw');
  await hr.galleries.register({
    id: 'hairstyles',
    name: '发型',
    promptRole: 'hairstyle',
    items: [{ id: 'H-01', name: '双马尾', category: 'cute', traits: '双马尾手绘线条' }]
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/hair-demo.info',
    methods: ['GET'],
    async fetch() {
      const list = await hr.galleries.list();
      return Response.json({ ok: true, count: list.length, hasStyles: list.some(g => g.id === 'styles'), hasHair: list.some(g => g.id === 'hairstyles') });
    }
  }));
}
`), 0o644)
	_ = os.WriteFile(filepath.Join(plugDir, "client.js"), []byte(`
window.__ModuleLoader__.load({
  id: 'dsh-plugin-hair-demo',
  factory(require) {
    const React = require('react');
    return {
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'hair-demo' }, () => React.createElement('div', null, 'Hair Demo OK')));
      }
    };
  }
});
`), 0o644)

	httpReq := func(method, path string, withAuth bool, body any) (*http.Response, string) {
		var r io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, addr+path, r)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if withAuth {
			req.Header.Set("X-Handraw-Token", srv.Token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s failed: %v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}

	// 1. Install local DSH plugin via /api/plugins/install.
	resp, body := httpReq("POST", "/api/plugins/install", true, map[string]any{"source": plugDir})
	if resp.StatusCode != 200 || !strings.Contains(body, `"kind":"dsh"`) {
		t.Fatalf("install DSH plugin failed: %d %s", resp.StatusCode, body)
	}

	// Sidecar must still be off before enabling.
	if srv.DSH.Status().Running {
		t.Fatal("DSH sidecar should remain off while plugin is disabled")
	}

	// 2. Enable DSH plugin.
	resp, body = httpReq("PATCH", "/api/plugins/community:dsh-plugin-hair-demo", true, map[string]any{"enabled": true})
	if resp.StatusCode != 200 {
		t.Fatalf("enable DSH plugin failed: %d %s", resp.StatusCode, body)
	}
	if !srv.DSH.Status().Running {
		t.Fatalf("expected DSH sidecar to be running after enable: %+v", srv.DSH.Status())
	}

	// 3. Unauthenticated request to proxied DSH route MUST be rejected (403).
	resp, _ = httpReq("GET", "/api/hair-demo.info", false, nil)
	if resp.StatusCode != 403 {
		t.Fatalf("expected 403 for unauthenticated DSH route, got %d", resp.StatusCode)
	}

	// 4. Authenticated request to proxied DSH route succeeds and sees Host galleries!
	resp, body = httpReq("GET", "/api/hair-demo.info", true, nil)
	if resp.StatusCode != 200 || !strings.Contains(body, `"hasStyles":true`) || !strings.Contains(body, `"hasHair":true`) {
		t.Fatalf("proxied DSH route failed: %d %s", resp.StatusCode, body)
	}

	// 5. Client bundle is served cleanly.
	resp, body = httpReq("GET", "/files/dsh-client/dsh-plugin-hair-demo", true, nil)
	if resp.StatusCode != 200 || !strings.Contains(body, "__ModuleLoader__") {
		t.Fatalf("dsh-client bundle failed: %d %s", resp.StatusCode, body)
	}

	// 6. Disabling plugin stops sidecar and unregisters its gallery.
	resp, body = httpReq("PATCH", "/api/plugins/community:dsh-plugin-hair-demo", true, map[string]any{"enabled": false})
	if resp.StatusCode != 200 {
		t.Fatalf("disable DSH plugin failed: %d %s", resp.StatusCode, body)
	}
	if srv.DSH.Status().Running {
		t.Fatal("DSH sidecar should stop when last DSH plugin is disabled")
	}
	resp, _ = httpReq("GET", "/api/galleries/hairstyles/items", true, nil)
	if resp.StatusCode != 404 {
		t.Fatalf("expected DSH gallery to be unregistered on disable, got %d", resp.StatusCode)
	}
}
