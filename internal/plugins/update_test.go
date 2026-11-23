package plugins

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		cand string
		cur  string
		want bool
	}{
		{"1.0.1", "1.0.0", true},
		{"v1.2.0", "1.1.9", true},
		{"2.0.0", "1.9.9", true},
		{"1.0.0", "1.0.0-rc.1", true},
		{"1.0.0-rc.2", "1.0.0-rc.1", true},
		{"1.0.0-rc.10", "1.0.0-rc.2", true},
		{"1.0.0-beta.1", "1.0.0-1", true},
		// Equal or older must NEVER trigger update (no downgrade).
		{"1.0.0", "1.0.0", false},
		{"0.7.9", "0.8.0", false},
		{"1.0.0-rc.1", "1.0.0", false},
		{"dev", "1.0.0", false},
		{"1.0.0", "", false},
	}
	for _, tc := range cases {
		if got := NewerVersion(tc.cand, tc.cur); got != tc.want {
			t.Errorf("NewerVersion(%q, %q) = %v, want %v", tc.cand, tc.cur, got, tc.want)
		}
	}
}

func TestSameCommitAndShortCommit(t *testing.T) {
	if !SameCommit("4e95996", "4e959966464e0b3b7aa8fb39ef535946b5362ff1") {
		t.Fatal("expected short SHA to match full SHA")
	}
	if !SameCommit("4E959966464E", "4e95996") {
		t.Fatal("expected case-insensitive prefix match")
	}
	if SameCommit("4e95996", "ad836e7") {
		t.Fatal("different SHAs should not match")
	}
	if SameCommit("", "4e95996") {
		t.Fatal("empty SHA should not match")
	}
	if got := ShortCommit("4e959966464e0b3b7aa8fb39ef535946b5362ff1"); got != "4e95996" {
		t.Fatalf("ShortCommit got %q, want 4e95996", got)
	}
}

func TestInstallMetaReadWriteAndLegacyFallback(t *testing.T) {
	// 1. Structured .install.json round-trip.
	d1 := t.TempDir()
	want := InstallMeta{
		Type:         "market",
		Source:       "market:demo@1.0.0 (https://example.com/index.json)",
		MarketURL:    "https://example.com/index.json",
		MarketSource: "handraw-official",
		Package:      "demo",
		Commit:       "4e959966464e0b3b7aa8fb39ef535946b5362ff1",
	}
	if err := WriteInstallMeta(d1, want); err != nil {
		t.Fatalf("WriteInstallMeta failed: %v", err)
	}
	got := ReadInstallMeta(d1)
	if got == nil || got.Type != "market" || got.Package != "demo" || !SameCommit(got.Commit, "4e95996") || got.InstalledAt == 0 {
		t.Fatalf("unexpected InstallMeta: %+v", got)
	}

	// 2. Legacy .source fallback (market).
	d2 := t.TempDir()
	_ = os.WriteFile(filepath.Join(d2, ".source"), []byte("market:dsh-plugin-pose-studio@0.7.9 (https://example.com/index.json)"), 0o644)
	got2 := ReadInstallMeta(d2)
	if got2 == nil || got2.Type != "market" || got2.Package != "dsh-plugin-pose-studio" || got2.MarketURL != "https://example.com/index.json" {
		t.Fatalf("legacy market fallback failed: %+v", got2)
	}

	// 3. Legacy .source fallback (npm).
	d3 := t.TempDir()
	_ = os.WriteFile(filepath.Join(d3, ".source"), []byte("npm:dsh-media-desk@2.7.2"), 0o644)
	got3 := ReadInstallMeta(d3)
	if got3 == nil || got3.Type != "npm" || got3.Package != "dsh-media-desk" {
		t.Fatalf("legacy npm fallback failed: %+v", got3)
	}

	// 4. Legacy .link fallback (local).
	d4 := t.TempDir()
	_ = os.WriteFile(filepath.Join(d4, ".link"), []byte(d1), 0o644)
	got4 := ReadInstallMeta(d4)
	if got4 == nil || got4.Type != "local" {
		t.Fatalf("legacy local fallback failed: %+v", got4)
	}
}
