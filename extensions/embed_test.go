package extensions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureClipperExtractsAndPrePairsDefaults(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "extensions", "handraw-clipper")
	defs := ClipperDefaults{
		ClientURL: "http://127.0.0.1:18520/",
		ClipToken: "hwc_test_token_1234",
		SiteBase:  "https://handraw-style.com/",
	}
	if err := EnsureClipper(dst, defs); err != nil {
		t.Fatalf("EnsureClipper failed: %v", err)
	}

	for _, rel := range []string{
		"manifest.json",
		"background/service-worker.js",
		"popup/popup.html",
		"popup/popup.js",
		"content/x-clipper.js",
		"icons/icon-128.png",
		"defaults.json",
	} {
		p := filepath.Join(dst, filepath.FromSlash(rel))
		st, err := os.Stat(p)
		if err != nil || st.IsDir() || st.Size() == 0 {
			t.Fatalf("expected non-empty extracted file %s, err=%v", rel, err)
		}
	}

	raw, err := os.ReadFile(filepath.Join(dst, "defaults.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got ClipperDefaults
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("invalid defaults.json: %v", err)
	}
	if got.ClientURL != "http://127.0.0.1:18520" || got.ClipToken != "hwc_test_token_1234" || got.SiteBase != "https://handraw-style.com" || got.PairedAt == "" {
		t.Fatalf("unexpected defaults.json: %+v", got)
	}

	// Rotating token updates defaults.json cleanly.
	defs.ClipToken = "hwc_rotated_token_5678"
	if err := WriteClipperDefaults(dst, defs); err != nil {
		t.Fatalf("WriteClipperDefaults failed: %v", err)
	}
	raw2, _ := os.ReadFile(filepath.Join(dst, "defaults.json"))
	if !strings.Contains(string(raw2), "hwc_rotated_token_5678") {
		t.Fatalf("expected rotated token in defaults.json, got %s", string(raw2))
	}
}
