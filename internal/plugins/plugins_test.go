package plugins

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestReconcileOrderAndFailure(t *testing.T) {
	r := NewRuntime(t.TempDir())
	var order []string
	r.Register(Manifest{ID: "b", Requires: []string{"svc-a"}, Apply: func(c *Ctx) error { order = append(order, "b"); return nil }})
	r.Register(Manifest{ID: "a", Provides: []string{"svc-a"}, Apply: func(c *Ctx) error { order = append(order, "a"); return nil }})
	r.Register(Manifest{ID: "bad", Apply: func(c *Ctx) error { panic("boom") }})
	r.Register(Manifest{ID: "err", Apply: func(c *Ctx) error { return errors.New("nope") }})
	r.Reconcile(map[string]bool{}, nil)
	if len(order) != 2 || order[0] != "a" || order[1] != "b" {
		t.Fatalf("order %v", order)
	}
	st := map[string]State{}
	for _, s := range r.States() {
		st[s.ID] = s
	}
	if st["bad"].State != "failed" || st["err"].State != "failed" || st["a"].State != "active" {
		t.Fatalf("states %+v", st)
	}
	// Turning a off disposes b, which requires it.
	disposed := false
	r2 := NewRuntime(t.TempDir())
	r2.Register(Manifest{ID: "a", Provides: []string{"svc-a"}})
	r2.Register(Manifest{ID: "b", Requires: []string{"svc-a"}, Apply: func(c *Ctx) error { c.OnDispose(func() { disposed = true }); return nil }})
	r2.Reconcile(nil, nil)
	r2.Reconcile(map[string]bool{"a": false, "b": false}, nil)
	if !disposed || r2.Active("b") {
		t.Fatal("b not disposed")
	}
}

func TestInUseStaysOn(t *testing.T) {
	r := NewRuntime(t.TempDir())
	r.Register(Manifest{ID: "canvas", InUse: func() (int, error) { return 2, nil }})
	r.Reconcile(map[string]bool{"canvas": false}, nil)
	if !r.Active("canvas") {
		t.Fatal("in-use plugin was switched off")
	}
	if r.CanDisable("canvas") == nil {
		t.Fatal("CanDisable should refuse")
	}
}

func TestValidateConfig(t *testing.T) {
	r := NewRuntime(t.TempDir())
	min, max := 1, 10
	r.Register(Manifest{ID: "x", Settings: []Setting{{Key: "n", Title: "N", Type: "int", Min: &min, Max: &max, Default: 3}, {Key: "m", Title: "M", Type: "enum", Enum: []string{"a", "b"}, Default: "a"}}})
	if _, err := r.ValidateConfig("x", map[string]any{"n": float64(11)}); err == nil {
		t.Fatal("range not checked")
	}
	if _, err := r.ValidateConfig("x", map[string]any{"m": "z"}); err == nil {
		t.Fatal("enum not checked")
	}
	if out, err := r.ValidateConfig("x", map[string]any{"n": float64(5), "junk": 1}); err != nil || out["n"] != float64(5) || out["junk"] != nil {
		t.Fatalf("got %v %v", out, err)
	}
}

func zipOf(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, _ := w.Create(name)
		f.Write([]byte(body))
	}
	w.Close()
	return buf.Bytes()
}

func TestInstallZip(t *testing.T) {
	dir := t.TempDir()
	r := NewRuntime(dir)
	pkg := `{"name":"demo-card","version":"0.1.0","handraw":{"name":"示例","permissions":["works:read"],"page":{"file":"index.html","title":"示例"},"actions":[{"id":"open","menu":"work","title":"用示例打开"}]}}`
	c, err := r.InstallZip(zipOf(t, map[string]string{"repo-main/package.json": pkg, "repo-main/index.html": "<p>hi</p>"}), "test")
	if err != nil {
		t.Fatal(err)
	}
	if c.ID != "demo-card" {
		t.Fatalf("id %q", c.ID)
	}
	if _, err := os.Stat(filepath.Join(dir, "demo-card", "index.html")); err != nil {
		t.Fatal("not unpacked")
	}
	if got := r.ListCommunity(map[string]bool{"community:demo-card": true}); len(got) != 1 || !got[0].Enabled {
		t.Fatalf("list %+v", got)
	}
	// Unknown permission is refused.
	bad := `{"name":"x-plugin","handraw":{"permissions":["fs:write"]}}`
	if _, err := r.InstallZip(zipOf(t, map[string]string{"package.json": bad}), "test"); err == nil {
		t.Fatal("unknown permission accepted")
	}
	// Path escape is skipped, and a provider must point to loopback.
	evil := `{"name":"evil-plugin","handraw":{"permissions":["provider"],"providers":[{"id":"p","name":"p","endpoint":"https://evil.example"}]}}`
	if _, err := r.InstallZip(zipOf(t, map[string]string{"package.json": evil, "../../x.txt": "x"}), "test"); err == nil {
		t.Fatal("remote provider accepted")
	}
}
