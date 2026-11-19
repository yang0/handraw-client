package server

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/store"
)

func writePNG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y += 7 {
		for x := 0; x < w; x += 7 {
			img.Set(x, y, color.RGBA{200, 75, 49, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestShareImageDownscalesLargePNGWithoutEncodedWebP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.png")
	writePNG(t, path, 3000, 1500)
	dataURL, name, err := shareImage(store.Image{Path: path}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dataURL, "data:image/jpeg;base64,") || name != "big.jpg" {
		t.Fatalf("want JPEG fallback, got %q %q", dataURL[:30], name)
	}
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, "data:image/jpeg;base64,"))
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width != 2048 || cfg.Height != 1024 {
		t.Fatalf("want 2048x1024, got %+v %v", cfg, err)
	}
}

func TestShareImageRejectsBogusEncodedWebP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "small.png")
	writePNG(t, path, 40, 30)
	bogus := "data:image/webp;base64," + base64.StdEncoding.EncodeToString([]byte("not a webp at all"))
	dataURL, _, err := shareImage(store.Image{Path: path}, bogus)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(dataURL, "data:image/webp") {
		t.Fatal("an invalid UI encoding must not be uploaded")
	}
}

func TestPublishRecipeKeepsOfficialCodesAndHidesCustomDefinitions(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mine := "mine:2b7d4c8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e"
	if err := db.PutDoc(&store.Doc{Kind: "style", ID: mine, Name: "我的纸感", Data: []byte(`{"traits":"secret"}`),
		RemoteID: "2b7d4c8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", RemoteRev: 1}); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: db}
	rec := s.publishRecipe(store.Run{Recipe: []byte(`{"style":"FA-001","style2":"` + mine + `","layout":"MY-LAY","ratio":"3:4","color":"C-15","tone":""}`)})
	if got := rec["styles"].([]string); len(got) != 1 || got[0] != "FA-001" {
		t.Fatalf("styles = %v", got)
	}
	if _, ok := rec["layout"]; ok {
		t.Fatal("MY-* layout must not be shared")
	}
	if got := rec["personalResources"].([]string); len(got) != 1 || got[0] != "2b7d4c8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e" {
		t.Fatalf("personalResources = %v", got)
	}
	if rec["ratio"] != "3:4" || len(rec["colors"].([]string)) != 1 {
		t.Fatalf("recipe = %v", rec)
	}
	if _, ok := rec["tones"]; ok {
		t.Fatal("empty tones must be omitted")
	}
}
