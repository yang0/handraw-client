package updater

import (
	"archive/zip"
	"bytes"
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
		{"dev", "0.1.0", false},
		{"v1.0.0", "0.9.9", true},
		{"1.0.0-beta", "1.0.0", false},
		{"1.0.0", "1.0.0-beta", true},
		{"1.0.0-beta.2", "1.0.0-beta.1", true},
		{"1.0.0-beta.10", "1.0.0-beta.2", true},
		{"1.0.0-rc.1", "1.0.0-beta.9", true},
		{"1.0.0-beta.1", "1.0.0-beta.1", false},
		{"1.0.0+build1", "1.0.0+build2", false},
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

// Default update feeds must prefer Gitee first, then official mirror, then GitHub (#173).
func TestDefaultFeedsPreferGitee(t *testing.T) {
	if len(Feeds) < 3 {
		t.Fatalf("expected at least 3 update feeds, got %v", Feeds)
	}
	if !strings.Contains(Feeds[0], "gitee.com/") {
		t.Fatalf("expected Gitee as default primary feed, got %q", Feeds[0])
	}
	if !strings.Contains(Feeds[1], "handraw-style.com/static/client/latest.json") {
		t.Fatalf("expected official mirror as second feed, got %q", Feeds[1])
	}
	if !strings.Contains(Feeds[2], "api.github.com/") {
		t.Fatalf("expected GitHub as third fallback feed, got %q", Feeds[2])
	}
	if len(ResourceFeed) < 3 || !strings.Contains(ResourceFeed[0], "gitee.com/") {
		t.Fatalf("expected Gitee first in ResourceFeed, got %v", ResourceFeed)
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

// #176 audit items #1 and #2: PlanResources must fail closed without PublicKey,
// and must verify real SHA-256 contents to catch same-size corrupted files.
func TestResourcesFailClosedAndRealSHA256(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	origPub := PublicKey
	origResFeed := ResourceFeed
	t.Cleanup(func() {
		PublicKey = origPub
		ResourceFeed = origResFeed
	})

	goodBody := []byte("hello-world-good-content")
	corruptSameSize := []byte("hello-world-BAD!-content")
	if len(goodBody) != len(corruptSameSize) {
		t.Fatalf("test fixture sizes differ")
	}
	goodSum := sha256.Sum256(goodBody)
	goodHex := hex.EncodeToString(goodSum[:])

	manifest := Manifest{
		Version: "1.2.3",
		Files: []ManifestFile{
			{Path: "styles/sample.txt", Size: int64(len(goodBody)), SHA256: goodHex},
		},
	}
	manifestRaw, _ := json.Marshal(manifest)
	sig := ed25519.Sign(priv, append([]byte("handraw release resources-1.2.3\n"), manifestRaw...))
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			_, _ = w.Write(manifestRaw)
		case "/manifest.json.sig":
			_, _ = w.Write([]byte(sigB64))
		case "/styles/sample.txt":
			_, _ = w.Write(goodBody)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ResourceFeed = []string{srv.URL}

	packDir := t.TempDir()
	u := New("v0.6.3", t.TempDir())

	// 1. Fail-closed when PublicKey is empty.
	PublicKey = ""
	if _, err := u.PlanResources(context.Background(), packDir); err == nil {
		t.Fatalf("PlanResources must fail closed when PublicKey is empty")
	}

	// 2. Valid PublicKey succeeds and detects same-size corrupted local file.
	PublicKey = base64.StdEncoding.EncodeToString(pub)
	if err := os.MkdirAll(filepath.Join(packDir, "styles"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packDir, "manifest.json"), manifestRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packDir, "styles", "sample.txt"), corruptSameSize, 0o644); err != nil {
		t.Fatal(err)
	}

	plan, err := u.PlanResources(context.Background(), packDir)
	if err != nil {
		t.Fatalf("PlanResources with valid key failed: %v", err)
	}
	if len(plan.Changed) != 1 || plan.Changed[0].Path != "styles/sample.txt" {
		t.Fatalf("expected corrupted same-size file to be scheduled for repair, got %+v", plan.Changed)
	}

	// 3. ApplyResources repairs it; next PlanResources sees 0 changes.
	if err := u.ApplyResources(context.Background(), packDir, plan, nil); err != nil {
		t.Fatalf("ApplyResources failed: %v", err)
	}
	repaired, err := os.ReadFile(filepath.Join(packDir, "styles", "sample.txt"))
	if err != nil || string(repaired) != string(goodBody) {
		t.Fatalf("expected repaired content, got %q (err=%v)", string(repaired), err)
	}
	plan2, err := u.PlanResources(context.Background(), packDir)
	if err != nil {
		t.Fatalf("second PlanResources failed: %v", err)
	}
	if len(plan2.Changed) != 0 {
		t.Fatalf("expected 0 changes after repair, got %+v", plan2.Changed)
	}
}

// #176 audit items #3 and #4: downloadToFile enforces size caps, and unzipBundle
// rejects symlink traversal and zip-bomb total byte expansion.
func TestDownloadLimitAndUnzipBundleSecurity(t *testing.T) {
	// 1. Streaming download rejects payload exceeding maxBytes.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("A"), 2048))
	}))
	defer srv.Close()
	u := New("v0.6.3", t.TempDir())
	if _, err := u.downloadToFile(context.Background(), srv.URL, filepath.Join(t.TempDir(), "out.bin"), 1024, nil); err == nil {
		t.Fatalf("expected oversized download to be rejected")
	}

	// 2. Zip with symlink escaping destination root must be rejected.
	makeZip := func(entries []struct {
		name string
		mode os.FileMode
		data []byte
	}) string {
		zp := filepath.Join(t.TempDir(), "bundle.zip")
		f, err := os.Create(zp)
		if err != nil {
			t.Fatal(err)
		}
		zw := zip.NewWriter(f)
		for _, e := range entries {
			hdr := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
			hdr.SetMode(e.mode)
			w, err := zw.CreateHeader(hdr)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write(e.data)
		}
		_ = zw.Close()
		_ = f.Close()
		return zp
	}

	escapeZip := makeZip([]struct {
		name string
		mode os.FileMode
		data []byte
	}{
		{name: "app/escape", mode: os.ModeSymlink | 0o777, data: []byte("../../outside.txt")},
	})
	if err := unzipBundleWithLimits(escapeZip, filepath.Join(t.TempDir(), "dst"), 1<<20, 1<<20, 100); err == nil {
		t.Fatalf("expected escaping symlink in zip to be rejected")
	}

	// 3. Zip exceeding total extracted byte limit must be rejected.
	bombZip := makeZip([]struct {
		name string
		mode os.FileMode
		data []byte
	}{
		{name: "app/a.bin", mode: 0o644, data: bytes.Repeat([]byte("X"), 4096)},
		{name: "app/b.bin", mode: 0o644, data: bytes.Repeat([]byte("Y"), 4096)},
	})
	if err := unzipBundleWithLimits(bombZip, filepath.Join(t.TempDir(), "dst2"), 5000, 5000, 100); err == nil {
		t.Fatalf("expected zip exceeding total byte limit to be rejected")
	}
}

func TestAssetNameUnsupportedOS(t *testing.T) {
	if got := assetNameFor("windows", "amd64"); got != "handraw-windows-amd64.exe" {
		t.Fatalf("windows asset = %q", got)
	}
	if got := assetNameFor("darwin", "arm64"); got != "handraw-darwin-arm64.zip" {
		t.Fatalf("darwin asset = %q", got)
	}
	if got := assetNameFor("linux", "amd64"); got != "" {
		t.Fatalf("linux nogui should not claim a non-existent release asset, got %q", got)
	}
}
