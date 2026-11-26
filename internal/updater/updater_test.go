package updater

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.2.0", "0.1.9", true},
		{"0.1.10", "0.1.9", true},
		{"0.1.0", "0.1.0", false},
		{"0.1.0", "0.2.0", false},
		{"0.1.0", "dev", true},
		{"v1.0.0", "0.9.9", true},
		{"1.0.0-beta", "1.0.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestVerifySums(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	sums := []byte("abc123  handraw-windows-amd64.exe\ndef456  handraw-darwin-arm64.zip\n")
	sig := ed25519.Sign(priv, append([]byte("handraw release 0.2.0\n"), sums...))
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	sigB64 := []byte(base64.StdEncoding.EncodeToString(sig))

	m, err := VerifySums("v0.2.0", sums, sigB64, pubB64)
	if err != nil {
		t.Fatal(err)
	}
	if m["handraw-windows-amd64.exe"] != "abc123" {
		t.Fatalf("bad table %v", m)
	}
	// A signature is only good for its own version (no downgrade replay).
	if _, err := VerifySums("0.1.0", sums, sigB64, pubB64); err == nil {
		t.Fatal("signature accepted for another version")
	}
	// Tampered sums are refused.
	if _, err := VerifySums("0.2.0", append(sums, 'x'), sigB64, pubB64); err == nil {
		t.Fatal("tampered sums accepted")
	}
	if _, err := VerifySums("0.2.0", sums, sigB64, ""); err == nil {
		t.Fatal("accepted without a public key")
	}
}

// A Windows-first release must not be offered to macOS clients (and vice versa).
func TestReleaseHasPlatformAsset(t *testing.T) {
	winOnly := &Release{Tag: "v0.6.0", Assets: []Asset{
		{Name: "handraw-windows-amd64.exe"}, {Name: "handraw-windows-arm64.exe"},
		{Name: "SHA256SUMS"}, {Name: "SHA256SUMS.sig"},
	}}
	if !releaseHas(winOnly, "handraw-windows-amd64.exe", "SHA256SUMS", "SHA256SUMS.sig") {
		t.Fatalf("windows asset should be found")
	}
	if releaseHas(winOnly, "handraw-darwin-arm64.zip", "SHA256SUMS", "SHA256SUMS.sig") {
		t.Fatalf("darwin asset must be reported missing")
	}
	unsigned := &Release{Assets: []Asset{{Name: "handraw-windows-amd64.exe"}}}
	if releaseHas(unsigned, "handraw-windows-amd64.exe", "SHA256SUMS", "SHA256SUMS.sig") {
		t.Fatalf("release without signed checksums must not be offered")
	}
}
