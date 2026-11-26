package resources

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureBuiltinMaterializesAndLoadsPack(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureBuiltin(dir); err != nil {
		t.Fatalf("EnsureBuiltin failed: %v", err)
	}
	if !HasBuiltinMarker(dir) {
		t.Fatalf("expected HasBuiltinMarker(dir) == true after EnsureBuiltin")
	}

	p, err := Load(dir)
	if err != nil {
		t.Fatalf("Load(dir) failed: %v", err)
	}
	if len(p.Styles) < 300 {
		t.Fatalf("expected >= 300 embedded styles, got %d", len(p.Styles))
	}
	if len(p.Layouts) < 100 {
		t.Fatalf("expected >= 100 embedded layouts, got %d", len(p.Layouts))
	}
	if len(p.Colors) < 20 {
		t.Fatalf("expected >= 20 embedded colors, got %d", len(p.Colors))
	}
	if len(p.Tones) < 5 {
		t.Fatalf("expected >= 5 embedded tones, got %d", len(p.Tones))
	}
	if _, ok := p.Style("FA-001"); !ok {
		t.Fatalf("expected FA-001 in embedded styles")
	}
	if l, ok := p.Layout("SB-001"); !ok || l.PromptZh == "" {
		t.Fatalf("expected SB-001 layout with hydrated PromptZh, got ok=%v len=%d", ok, len(l.PromptZh))
	}

	// Simulate an older builtin marker + cached image: upgrade must refresh references
	// while keeping any cached image intact.
	cachedImg := filepath.Join(dir, "images", "individual", "FA", "FA-001.webp")
	if err := os.MkdirAll(filepath.Dir(cachedImg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachedImg, []byte("cached-webp"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "builtin_version.json"), []byte(`{"version":"0.0.1"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureBuiltin(dir); err != nil {
		t.Fatalf("EnsureBuiltin upgrade failed: %v", err)
	}
	if got, err := os.ReadFile(cachedImg); err != nil || string(got) != "cached-webp" {
		t.Fatalf("expected cached image preserved across builtin upgrade, got %q err=%v", string(got), err)
	}
}

func TestEnsureBuiltinRespectsSignedManifestPack(t *testing.T) {
	dir := t.TempDir()
	refDir := filepath.Join(dir, "references")
	if err := os.MkdirAll(refDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sentinel := `[{"number":"FA-001","group":"FA Test / Test","generation_name":"CustomSigned"}]`
	if err := os.WriteFile(filepath.Join(refDir, "styles.json"), []byte(sentinel), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"version":"9.9.9","files":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := EnsureBuiltin(dir); err != nil {
		t.Fatalf("EnsureBuiltin failed: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(refDir, "styles.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != sentinel {
		t.Fatalf("EnsureBuiltin overwrote signed manifest pack!")
	}
	if HasBuiltinMarker(dir) {
		t.Fatalf("signed manifest pack must not report HasBuiltinMarker == true")
	}
}
