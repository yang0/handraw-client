package dshbridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/plugins"
)

func TestBridgeLifecycleRoutesAndHandrawHostBridge(t *testing.T) {
	nodePath, _ := DetectNode()
	if nodePath == "" {
		t.Skip("node not installed in test environment")
	}

	// Mock Go host server verifying X-Handraw-Token and serving galleries + models.
	const tok = "test-host-token"
	var registeredGallery string
	mockHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Handraw-Token") != tok {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/galleries":
			_, _ = w.Write([]byte(`{"galleries":[{"id":"styles","name":"画风"},{"id":"hairstyles","name":"发型"}]}`))
		case r.Method == "POST" && r.URL.Path == "/api/host/galleries/register":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			registeredGallery, _ = body["id"].(string)
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == "GET" && r.URL.Path == "/api/host/models":
			_, _ = w.Write([]byte(`{"defaultTextModel":"p1:demo-llm","text":[{"ref":"p1:demo-llm","label":"Demo LLM"}]}`))
		case r.Method == "POST" && r.URL.Path == "/api/host/models/chat":
			_, _ = w.Write([]byte(`{"content":"来自宿主模型的回复"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockHost.Close()

	// Create a synthetic DSH plugin exercising connection.fetch, webServer, llm, and ctx.get('handraw').
	plugDir := t.TempDir()
	hostJS := `
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/demo.inspect',
    methods: ['GET'],
    async fetch() {
      const hr = ctx.get('handraw');
      const gals = await hr.galleries.list();
      await hr.galleries.register({ id: 'dsh-poses', name: 'DSH姿势', items: [] });
      const llm = ctx.get('llm');
      const sel = ctx.get('agentDefaultModel').currentSelection();
      const call = await llm.prepareCall({ provider: sel.provider, model: sel.model });
      let reply = '';
      for await (const chunk of call.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (chunk.type === 'text-delta') reply += chunk.text;
      }
      return Response.json({ galleries: gals.map(g => g.id), reply, model: sel.model });
    }
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/demo-desk',
    handler(req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, admitted: ctx.connection.admit(req, res) }));
    }
  }));
}
`
	if err := os.WriteFile(filepath.Join(plugDir, "host.js"), []byte(hostJS), 0o644); err != nil {
		t.Fatal(err)
	}

	mgr := New(t.TempDir())
	defer mgr.Stop()
	mgr.SetHostEndpoint(mockHost.URL, tok)

	// 1. Zero overhead when no DSH plugins are enabled.
	if err := mgr.Sync(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if mgr.Status().Running {
		t.Fatal("sidecar should not run when no DSH plugins are enabled")
	}

	// 2. Enable our DSH plugin.
	comm := plugins.Community{
		ID:      "dsh-demo",
		Kind:    "dsh",
		Name:    "Demo DSH",
		Dir:     plugDir,
		Enabled: true,
		DSH: &plugins.DSHMeta{
			PackageName: "dsh-demo",
			HostEntry:   "host.js",
			Compat:      "full",
		},
	}
	if err := mgr.Sync(context.Background(), []plugins.Community{comm}); err != nil {
		t.Fatalf("Sync failed: %v", err)
	}
	st := mgr.Status()
	if !st.Running || !mgr.MatchRoute("/api/demo.inspect") || !mgr.MatchRoute("/demo-desk/state") {
		t.Fatalf("unexpected bridge status: %+v", st)
	}

	// 3. Invoke exact connection.fetch route via ReverseProxy.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://127.0.0.1/api/demo.inspect", nil)
	mgr.ServeHTTP(rr, req)
	body, _ := io.ReadAll(rr.Result().Body)
	if rr.Code != 200 {
		t.Fatalf("exact route returned %d: %s", rr.Code, string(body))
	}
	sBody := string(body)
	if !strings.Contains(sBody, "hairstyles") || !strings.Contains(sBody, "来自宿主模型的回复") || registeredGallery != "dsh-poses" {
		t.Fatalf("unexpected exact route body=%s registeredGallery=%q", sBody, registeredGallery)
	}

	// 4. Invoke webServer prefix route.
	rr2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "http://127.0.0.1/demo-desk/state?x=1", nil)
	mgr.ServeHTTP(rr2, req2)
	if rr2.Code != 200 || !strings.Contains(rr2.Body.String(), `"admitted":true`) {
		t.Fatalf("prefix route failed: %d %s", rr2.Code, rr2.Body.String())
	}

	// 5. Disable all DSH plugins -> sidecar stops automatically.
	if err := mgr.Sync(context.Background(), []plugins.Community{}); err != nil {
		t.Fatal(err)
	}
	if mgr.Status().Running {
		t.Fatal("sidecar should stop when all DSH plugins are disabled")
	}
}
