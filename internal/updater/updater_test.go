package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

// End-to-end verification of the v0.6.0 -> v0.6.1 upgrade path (#172):
// - Skips a v0.6.1 release that lacks this platform's asset
// - Fails over from unreachable primary (GitHub) + 404 secondary (Gitee) to the
//   third fallback feed (handraw-style.com/static/client/latest.json schema)
// - Verifies ed25519 signature and SHA256, stages the verified binary
// - Rejects a tampered binary payload
func TestUpgradeV060ToV061WithFallbackFeed(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	origPub := PublicKey
	origFeeds := Feeds
	PublicKey = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() {
		PublicKey = origPub
		Feeds = origFeeds
	})

	curAsset := assetName()
	otherAsset := "handraw-darwin-arm64.zip"
	if curAsset == otherAsset {
		otherAsset = "handraw-windows-amd64.exe"
	}

	binPayload := []byte("fake-handraw-v0.6.1-binary-payload-content")
	binSum := sha256.Sum256(binPayload)
	sumsText := fmt.Sprintf("%s  %s\n", hex.EncodeToString(binSum[:]), curAsset)
	sig := ed25519.Sign(priv, append([]byte("handraw release 0.6.1\n"), []byte(sumsText)...))
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	mode := "other-platform-only" // other-platform-only | valid | tampered-bin
	var fallback *httptest.Server
	fallback = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/static/client/latest.json":
			w.Header().Set("Content-Type", "application/json")
			var assets []Asset
			if mode == "other-platform-only" {
				assets = []Asset{
					{Name: otherAsset, URL: fallback.URL + "/static/client/v0.6.1/" + otherAsset, Size: 123},
					{Name: "SHA256SUMS", URL: fallback.URL + "/static/client/v0.6.1/SHA256SUMS", Size: int64(len(sumsText))},
					{Name: "SHA256SUMS.sig", URL: fallback.URL + "/static/client/v0.6.1/SHA256SUMS.sig", Size: int64(len(sigB64))},
				}
			} else {
				assets = []Asset{
					{Name: curAsset, URL: fallback.URL + "/static/client/v0.6.1/" + curAsset, Size: int64(len(binPayload))},
					{Name: "SHA256SUMS", URL: fallback.URL + "/static/client/v0.6.1/SHA256SUMS", Size: int64(len(sumsText))},
					{Name: "SHA256SUMS.sig", URL: fallback.URL + "/static/client/v0.6.1/SHA256SUMS.sig", Size: int64(len(sigB64))},
				}
			}
			_ = json.NewEncoder(w).Encode(Release{
				Tag:       "v0.6.1",
				Name:      "手绘风 v0.6.1",
				Body:      "测试升级",
				Published: "2026-11-26T09:30:00Z",
				Assets:    assets,
			})
		case "/static/client/v0.6.1/SHA256SUMS":
			_, _ = w.Write([]byte(sumsText))
		case "/static/client/v0.6.1/SHA256SUMS.sig":
			_, _ = w.Write([]byte(sigB64))
		case "/static/client/v0.6.1/" + curAsset:
			if mode == "tampered-bin" {
				_, _ = w.Write(append(append([]byte{}, binPayload...), 'X'))
				return
			}
			_, _ = w.Write(binPayload)
		default:
			http.NotFound(w, r)
		}
	}))
	defer fallback.Close()

	brokenPrimary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	defer brokenPrimary.Close()
	missingSecondary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer missingSecondary.Close()

	Feeds = []string{
		brokenPrimary.URL + "/releases/latest",
		missingSecondary.URL + "/releases/latest",
		fallback.URL + "/static/client/latest.json",
	}

	stageDir := t.TempDir()
	u := New("v0.6.0", stageDir)

	// 1. Platform asset missing -> must NOT offer update.
	st, err := u.Check(context.Background())
	if err != nil {
		t.Fatalf("Check (other-platform-only): %v", err)
	}
	if st.Available || st.Latest != "0.6.1" {
		t.Fatalf("expected available=false latest=0.6.1 when platform asset missing, got %+v", st)
	}

	// 2. Platform asset present on fallback mirror -> failover succeeds, Download verifies & stages.
	mode = "valid"
	st, err = u.Check(context.Background())
	if err != nil {
		t.Fatalf("Check (valid): %v", err)
	}
	if !st.Available || st.Latest != "0.6.1" || st.AssetName != curAsset {
		t.Fatalf("expected available=true latest=0.6.1 asset=%s, got %+v", curAsset, st)
	}
	if err := u.Download(context.Background()); err != nil {
		t.Fatalf("Download (valid): %v", err)
	}
	st = u.Status()
	if !st.Ready || st.Progress != 100 {
		t.Fatalf("expected ready=true progress=100, got %+v", st)
	}
	stagedPath := filepath.Join(stageDir, curAsset)
	gotBytes, err := os.ReadFile(stagedPath)
	if err != nil || string(gotBytes) != string(binPayload) {
		t.Fatalf("staged binary mismatch: err=%v len=%d", err, len(gotBytes))
	}

	// 3. Tampered binary must be rejected.
	mode = "tampered-bin"
	u2 := New("v0.6.0", t.TempDir())
	if _, err := u2.Check(context.Background()); err != nil {
		t.Fatalf("Check (tampered): %v", err)
	}
	err = u2.Download(context.Background())
	if err == nil || !strings.Contains(err.Error(), "校验失败") {
		t.Fatalf("expected checksum failure on tampered binary, got %v", err)
	}
	if u2.Status().Ready {
		t.Fatalf("tampered download must not mark Ready=true")
	}
}

// Opt-in helper invoked via a compiled test binary (`go test -c`) to verify
// live Windows self-replacement (v0.6.0 -> real compiled v0.6.1 handraw.exe)
// without mutating the go test runner itself (#172).
func TestHelperApplyV060ToV061(t *testing.T) {
	baseDir := os.Getenv("HANDRAW_TEST_APPLY_BASE")
	if baseDir == "" {
		t.Skip("set HANDRAW_TEST_APPLY_BASE to run live self-swap verification")
	}
	curAsset := assetName()
	sumsBytes, err := os.ReadFile(filepath.Join(baseDir, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	sigBytes, err := os.ReadFile(filepath.Join(baseDir, "SHA256SUMS.sig"))
	if err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(baseDir, curAsset)
	binStat, err := os.Stat(binPath)
	if err != nil {
		t.Fatal(err)
	}

	var mirror *httptest.Server
	mirror = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/static/client/latest.json":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(Release{
				Tag:       "v0.6.1",
				Name:      "手绘风 v0.6.1",
				Body:      "v0.6.0 -> v0.6.1 real swap test",
				Published: "2026-11-26T09:35:00Z",
				Assets: []Asset{
					{Name: curAsset, URL: mirror.URL + "/static/client/v0.6.1/" + curAsset, Size: binStat.Size()},
					{Name: "SHA256SUMS", URL: mirror.URL + "/static/client/v0.6.1/SHA256SUMS", Size: int64(len(sumsBytes))},
					{Name: "SHA256SUMS.sig", URL: mirror.URL + "/static/client/v0.6.1/SHA256SUMS.sig", Size: int64(len(sigBytes))},
				},
			})
		case "/static/client/v0.6.1/SHA256SUMS":
			_, _ = w.Write(sumsBytes)
		case "/static/client/v0.6.1/SHA256SUMS.sig":
			_, _ = w.Write(sigBytes)
		case "/static/client/v0.6.1/" + curAsset:
			http.ServeFile(w, r, binPath)
		default:
			http.NotFound(w, r)
		}
	}))
	defer mirror.Close()

	brokenGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "github blocked", http.StatusBadGateway)
	}))
	defer brokenGH.Close()
	missingGitee := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer missingGitee.Close()

	origFeeds := Feeds
	Feeds = []string{
		brokenGH.URL + "/releases/latest",
		missingGitee.URL + "/releases/latest",
		mirror.URL + "/static/client/latest.json",
	}
	t.Cleanup(func() { Feeds = origFeeds })

	u := New("v0.6.0", filepath.Join(baseDir, "stage"))
	st, err := u.Check(context.Background())
	if err != nil || !st.Available || st.Latest != "0.6.1" {
		t.Fatalf("Check failed: err=%v st=%+v", err, st)
	}
	if err := u.Download(context.Background()); err != nil {
		t.Fatalf("Download failed: %v", err)
	}
	exe, err := u.Apply()
	if err != nil {
		t.Fatalf("Apply failed: %v", err)
	}
	t.Logf("SWAPPED_OK exe=%s latest=%s", exe, st.Latest)
}
