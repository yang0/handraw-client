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
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func TestRolloutBucketAndEvaluateAutoDownload(t *testing.T) {
	b1 := RolloutBucket("dc_device_a", "v0.7.0")
	b2 := RolloutBucket("dc_device_a", "0.7.0")
	if b1 != b2 || b1 < 0 || b1 >= 100 {
		t.Fatalf("RolloutBucket must be deterministic in [0,99], got %d and %d", b1, b2)
	}

	pub := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	spread := 2.0
	rel := &Release{
		Tag:            "v0.7.0",
		Published:      pub.Format(time.RFC3339),
		RolloutPercent: 100,
		SpreadHours:    &spread,
	}
	// Find a device key with bucket >= 50 so its slot is at least 1 hour after pub.
	key := "dc_high"
	for i := 0; i < 200; i++ {
		cand := fmt.Sprintf("dc_probe_%d", i)
		if RolloutBucket(cand, "0.7.0") >= 50 {
			key = cand
			break
		}
	}
	okNow, until := EvaluateAutoDownload(rel, key, pub.Add(10*time.Minute))
	if okNow || until.IsZero() || !until.After(pub.Add(50*time.Minute)) {
		t.Fatalf("expected spread-window deferral, got ok=%v until=%v", okNow, until)
	}
	okLater, untilLater := EvaluateAutoDownload(rel, key, pub.Add(2*time.Hour))
	if !okLater || !untilLater.IsZero() {
		t.Fatalf("expected eligible after spread window, got ok=%v until=%v", okLater, untilLater)
	}

	// RolloutPercent smaller than bucket excludes device from automatic download.
	relSmall := &Release{
		Tag:            "v0.7.0",
		Published:      pub.Format(time.RFC3339),
		RolloutPercent: 10,
		SpreadHours:    &spread,
	}
	okSmall, untilSmall := EvaluateAutoDownload(relSmall, key, pub.Add(24*time.Hour))
	if okSmall || !untilSmall.IsZero() {
		t.Fatalf("expected bucket %d excluded from 10%% rollout, got ok=%v until=%v", RolloutBucket(key, "0.7.0"), okSmall, untilSmall)
	}

	// Negative RolloutPercent pauses automatic rollout completely.
	relPaused := &Release{Tag: "v0.7.0", RolloutPercent: -1}
	if okPaused, _ := EvaluateAutoDownload(relPaused, key, pub.Add(24*time.Hour)); okPaused {
		t.Fatalf("negative RolloutPercent must pause auto downloads")
	}
}

func TestAutoUpdateETag304CooldownMirrorsAndStagedRestore(t *testing.T) {
	curAsset := assetName()
	if curAsset == "" {
		t.Skip("self-update binary assets are only published for windows/darwin (#180)")
	}

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

	payload := []byte("signed-handraw-v0.6.7-auto-binary")
	sum := sha256.Sum256(payload)
	sumsText := fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), curAsset)
	sig := ed25519.Sign(priv, append([]byte("handraw release 0.6.7\n"), []byte(sumsText)...))
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	var metadataHits, notModifiedHits, mirrorHits, originBinHits atomic.Int32
	zeroSpread := 0.0
	pubTime := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)

	// Primary mirror (simulating Gitee Releases CDN) serves the binary.
	cdnMirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gitee/" + curAsset:
			mirrorHits.Add(1)
			_, _ = w.Write(payload)
		case "/gitee/SHA256SUMS":
			_, _ = w.Write([]byte(sumsText))
		case "/gitee/SHA256SUMS.sig":
			_, _ = w.Write([]byte(sigB64))
		default:
			http.NotFound(w, r)
		}
	}))
	defer cdnMirror.Close()

	// Metadata server (simulating Cloudflare-cached latest.json with ETag/304).
	metaSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest.json":
			metadataHits.Add(1)
			const tag = `"v0.6.7-etag"`
			if r.Header.Get("If-None-Match") == tag {
				notModifiedHits.Add(1)
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", tag)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(Release{
				Tag:            "v0.6.7",
				Name:           "手绘风 v0.6.7",
				Body:           "无感自动更新测试",
				Published:      pubTime.Format(time.RFC3339),
				RolloutPercent: 100,
				SpreadHours:    &zeroSpread,
				Assets: []Asset{
					{
						Name:    curAsset,
						URL:     "http://127.0.0.1:1/should-not-hit-origin",
						Mirrors: []string{cdnMirror.URL + "/gitee/" + curAsset},
						Size:    int64(len(payload)),
					},
					{
						Name:    "SHA256SUMS",
						URL:     "http://127.0.0.1:1/sums",
						Mirrors: []string{cdnMirror.URL + "/gitee/SHA256SUMS"},
						Size:    int64(len(sumsText)),
					},
					{
						Name:    "SHA256SUMS.sig",
						URL:     "http://127.0.0.1:1/sig",
						Mirrors: []string{cdnMirror.URL + "/gitee/SHA256SUMS.sig"},
						Size:    int64(len(sigB64)),
					},
				},
			})
		default:
			originBinHits.Add(1)
			http.NotFound(w, r)
		}
	}))
	defer metaSrv.Close()

	Feeds = []string{metaSrv.URL + "/latest.json"}
	stageDir := t.TempDir()
	now := pubTime.Add(1 * time.Hour)

	u := New("v0.6.6", stageDir)
	u.Now = func() time.Time { return now }
	u.Mode = func() string { return AutoModeAuto }
	u.BucketKey = func() string { return "dc_test_user" }
	busy := true
	u.IsBusy = func() bool { return busy }

	// 1. Busy state: CheckAuto runs, sees v0.6.7, defers download by 2 minutes.
	wake := u.AutoStep(context.Background())
	if wake != 2*time.Minute {
		t.Fatalf("expected 2m busy deferral, got %v", wake)
	}
	if metadataHits.Load() != 1 || mirrorHits.Load() != 0 {
		t.Fatalf("expected 1 metadata hit and 0 downloads while busy, got meta=%d mirror=%d", metadataHits.Load(), mirrorHits.Load())
	}

	// 2. Idle 5 minutes later (still inside 6h cooldown): CheckAuto must NOT hit
	//    network again, and AutoStep must silently download via CDN mirror!
	now = now.Add(5 * time.Minute)
	busy = false
	_ = u.AutoStep(context.Background())
	if metadataHits.Load() != 1 {
		t.Fatalf("expected 6h cooldown to prevent second metadata request, got %d hits", metadataHits.Load())
	}
	if mirrorHits.Load() != 1 || originBinHits.Load() != 0 {
		t.Fatalf("expected download from mirror (1) without touching origin (0), got mirror=%d origin=%d", mirrorHits.Load(), originBinHits.Load())
	}
	st := u.Status()
	if !st.Ready || !st.AutoApplyOnQuit || st.StagedVersion != "0.6.7" {
		t.Fatalf("expected ready & autoApplyOnQuit after AutoStep, got %+v", st)
	}

	// 3. Manual Check bypasses cooldown and sends If-None-Match -> 304 Not Modified!
	if _, err := u.Check(context.Background()); err != nil {
		t.Fatalf("manual Check failed: %v", err)
	}
	if notModifiedHits.Load() != 1 {
		t.Fatalf("expected 304 Not Modified on second check with ETag, got %d", notModifiedHits.Load())
	}
	if !u.Status().Ready {
		t.Fatalf("304 check must preserve already-staged Ready state")
	}

	// 4. Restarting with a new Updater instance restores staged Ready state from disk with 0 downloads.
	u2 := New("v0.6.6", stageDir)
	u2.Mode = func() string { return AutoModeAuto }
	u2.LoadStaged()
	if !u2.Status().Ready || u2.Status().StagedVersion != "0.6.7" || !u2.Status().AutoApplyOnQuit {
		t.Fatalf("expected LoadStaged to restore verified update, got %+v", u2.Status())
	}

	// 5. After upgrading to v0.6.7, LoadStaged cleans up the old staged file.
	uUpgraded := New("v0.6.7", stageDir)
	uUpgraded.LoadStaged()
	if uUpgraded.Status().Ready {
		t.Fatalf("upgraded version must not report Ready for older staged file")
	}
	if _, err := os.Stat(filepath.Join(stageDir, curAsset)); !os.IsNotExist(err) {
		t.Fatalf("expected old staged binary cleaned up after upgrade, stat err=%v", err)
	}
}

func TestAutoDownloadFailureBackoffCap(t *testing.T) {
	u := New("v0.6.6", t.TempDir())
	base := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	u.Now = func() time.Time { return base }

	u.recordAutoDownloadFailure("0.6.7")
	ps := u.loadState()
	if ps.AutoFailCount != 1 || ps.NextRetryAt != base.Add(30*time.Minute).Format(time.RFC3339) {
		t.Fatalf("unexpected 1st backoff state: %+v", ps)
	}
	u.recordAutoDownloadFailure("0.6.7")
	ps = u.loadState()
	if ps.AutoFailCount != 2 || ps.NextRetryAt != base.Add(2*time.Hour).Format(time.RFC3339) {
		t.Fatalf("unexpected 2nd backoff state: %+v", ps)
	}
	u.recordAutoDownloadFailure("0.6.7")
	ps = u.loadState()
	if ps.AutoFailCount != 3 || ps.NextRetryAt != base.Add(6*time.Hour).Format(time.RFC3339) {
		t.Fatalf("unexpected 3rd backoff state: %+v", ps)
	}
}

func TestApplyPreventsDoubleApplyOnQuitAndFallbackOldName(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("direct exe swap test targets windows/linux binary replacement")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "handraw-windows-amd64.exe")
	stagedDir := filepath.Join(dir, "updates")
	if err := os.MkdirAll(stagedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(stagedDir, "handraw-windows-amd64.exe")
	oldBytes := []byte("old-v0.6.9-binary")
	newBytes := []byte("new-v0.6.10-binary")
	if err := os.WriteFile(exe, oldBytes, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staged, newBytes, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(newBytes)

	// Block the default ".old" path with a non-empty directory so os.Remove(old)
	// fails and applyWindowsOrDirect must fall back to ".old.<pid>" (#192).
	blocker := exe + ".old"
	if err := os.MkdirAll(filepath.Join(blocker, "locked"), 0o755); err != nil {
		t.Fatal(err)
	}

	u := New("v0.6.9", stagedDir)
	u.Mode = func() string { return AutoModeAuto }
	u.executableFn = func() (string, error) { return exe, nil }
	u.mu.Lock()
	u.staged = staged
	u.stagedVersion = "0.6.10"
	u.stagedSHA256 = hex.EncodeToString(sum[:])
	u.status.Ready = true
	u.status.StagedVersion = "0.6.10"
	u.status.AutoApplyOnQuit = true
	u.mu.Unlock()
	u.updateState(func(s *persistedState) {
		s.StagedVersion = "0.6.10"
		s.StagedPath = staged
		s.StagedSHA256 = hex.EncodeToString(sum[:])
	})

	// 1. Manual Apply ("重启升级") succeeds even with .old blocked.
	gotExe, err := u.Apply()
	if err != nil {
		t.Fatalf("first Apply failed: %v", err)
	}
	fiGot, err1 := os.Stat(gotExe)
	fiWant, err2 := os.Stat(exe)
	if err1 != nil || err2 != nil || !os.SameFile(fiGot, fiWant) {
		t.Fatalf("Apply returned %q, want same file as %q (errs: %v, %v)", gotExe, exe, err1, err2)
	}
	diskBytes, err := os.ReadFile(exe)
	if err != nil || string(diskBytes) != string(newBytes) {
		t.Fatalf("expected replaced binary %q, got %q (err=%v)", newBytes, diskBytes, err)
	}

	// 2. Subsequent ApplyIfReady during graceful shutdown must be a clean no-op
	// (never re-renaming the newly replaced binary or setting ApplyFailedVersion).
	appliedOnQuit, err := u.ApplyIfReady()
	if err != nil {
		t.Fatalf("ApplyIfReady after manual Apply returned unexpected error: %v", err)
	}
	if appliedOnQuit {
		t.Fatalf("ApplyIfReady after manual Apply should return applied=false")
	}
	ps := u.loadState()
	if ps.ApplyFailedVersion != "" || ps.StagedVersion != "" || ps.StagedPath != "" {
		t.Fatalf("expected clean state after manual Apply, got %+v", ps)
	}

	// 3. CleanupOld removes PID-qualified backup files.
	pidBackup := fmt.Sprintf("%s.old.%d", exe, os.Getpid())
	if _, err := os.Stat(pidBackup); err != nil {
		t.Fatalf("expected PID-qualified backup %s to exist: %v", pidBackup, err)
	}
	cleanupOldFor(exe)
	if _, err := os.Stat(pidBackup); !os.IsNotExist(err) {
		t.Fatalf("expected cleanupOldFor to remove %s, stat err=%v", pidBackup, err)
	}
}
