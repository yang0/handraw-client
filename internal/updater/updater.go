// Package updater checks Gitee / official mirror / GitHub Releases for new
// versions, verifies the ed25519-signed SHA256SUMS (like Magpie), replaces the
// program, and updates the resource pack file by file.
package updater

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/netutil"
)

// PublicKey verifies release signatures. Set at build time with
// -ldflags "-X github.com/yang0/handraw-client/internal/updater.PublicKey=<base64>".
var PublicKey = ""

const Repo = "yang0/handraw-client"

const (
	maxMetadataBytes     = 4 << 20   // 4 MiB for SHA256SUMS / manifest.json
	maxSigBytes          = 16 << 10  // 16 KiB for ed25519 signature files
	maxBinaryBytes       = 256 << 20 // 256 MiB max installer download
	maxResourceFileBytes = 64 << 20  // 64 MiB max single resource pack file
	maxUnzipTotalBytes   = 512 << 20 // 512 MiB max total extracted bundle size
	maxUnzipFileBytes    = 256 << 20 // 256 MiB max single extracted file
	maxUnzipFiles        = 2000      // max archive entries in macOS bundle zip
)

// Feeds are tried in order; the first that answers wins.
// Metadata checks (< 2 KB) prefer the Cloudflare-cached static latest.json
// with ETag/304 so large user bases put near-zero load on origin or Gitee API;
// 26 MB binary downloads prefer asset.Mirrors (Gitee Releases CDN first) (#182).
var Feeds = []string{
	"https://handraw-style.com/static/client/latest.json",
	"https://gitee.com/api/v5/repos/yang02010/handraw-client/releases/latest",
	"https://api.github.com/repos/" + Repo + "/releases/latest",
}

type Asset struct {
	Name    string   `json:"name"`
	URL     string   `json:"browser_download_url"`
	Mirrors []string `json:"mirrors,omitempty"`
	Size    int64    `json:"size"`
}

type Release struct {
	Tag            string   `json:"tag_name"`
	Name           string   `json:"name"`
	Body           string   `json:"body"`
	Published      string   `json:"published_at"`
	Assets         []Asset  `json:"assets"`
	Feed           string   `json:"feed"`
	RolloutPercent int      `json:"rolloutPercent,omitempty"`
	SpreadHours    *float64 `json:"spreadHours,omitempty"`
}

type Status struct {
	Current           string `json:"current"`
	Latest            string `json:"latest"`
	Notes             string `json:"notes"`
	Available         bool   `json:"available"`
	Checking          bool   `json:"checking"`
	Downloading       bool   `json:"downloading"`
	Progress          int    `json:"progress"`
	Ready             bool   `json:"ready"` // downloaded and verified; restart or quit to apply
	Error             string `json:"error,omitempty"`
	CheckedAt         string `json:"checkedAt,omitempty"`
	AssetName         string `json:"assetName,omitempty"`
	AutoMode          string `json:"autoMode,omitempty"`          // auto | notify | off
	AutoApplyOnQuit   bool   `json:"autoApplyOnQuit,omitempty"`   // will silently replace on normal exit
	StagedVersion     string `json:"stagedVersion,omitempty"`     // verified version ready on disk
	AutoDeferredUntil string `json:"autoDeferredUntil,omitempty"` // spread-window scheduled download time
	ApplyFailed       bool   `json:"applyFailed,omitempty"`       // previous quit-apply failed (stop loop)
	ResourceLocal     string `json:"resourceLocal,omitempty"`
	ResourceNew       string `json:"resourceNew,omitempty"`
	ResourceFiles     int    `json:"resourceFiles,omitempty"`
	ResourceBytes     int64  `json:"resourceBytes,omitempty"`
}

type Updater struct {
	Version         string
	Dir             string // where downloads are staged
	HTTP            *http.Client
	CheckCooldown   time.Duration
	StartupDelayMin time.Duration
	StartupDelayMax time.Duration
	Mode            func() string    // returns auto | notify | off
	IsBusy          func() bool      // true when active generation jobs should defer download/apply
	BucketKey       func() string    // stable anonymous device ID for rollout bucketing
	Now             func() time.Time // overridable clock for tests
	mu              sync.Mutex
	applyMu         sync.Mutex
	stateMu         sync.Mutex
	status          Status
	release         *Release
	staged          string
	stagedVersion   string
	stagedSHA256    string
	applied         bool
	appliedExe      string
	executableFn    func() (string, error) // overridable in tests
	nudgeCh         chan struct{}
	OnChange        func(Status)
	OnDownloadError func(version string, err error)
}

func New(version, dir string) *Updater {
	u := &Updater{
		Version: version,
		Dir:     dir,
		HTTP:    netutil.NewClient(30 * time.Minute),
		status:  Status{Current: version, AutoMode: AutoModeAuto},
		nudgeCh: make(chan struct{}, 1),
	}
	u.LoadStaged()
	return u
}

func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.status
}

func (u *Updater) set(fn func(*Status)) {
	u.mu.Lock()
	fn(&u.status)
	s := u.status
	u.mu.Unlock()
	if u.OnChange != nil {
		u.OnChange(s)
	}
}

// Loop checks now and every interval until ctx ends.
func (u *Updater) Loop(ctx context.Context, interval time.Duration, enabled func() bool) {
	t := time.NewTimer(5 * time.Second)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if enabled() {
				_, _ = u.Check(ctx)
			}
			t.Reset(interval)
		}
	}
}

// Check reads the latest release from the first reachable feed, honoring ETag/304.
func (u *Updater) Check(ctx context.Context) (Status, error) {
	u.set(func(s *Status) { s.Checking = true; s.Error = "" })
	u.stateMu.Lock()
	ps := u.loadState()
	u.stateMu.Unlock()

	var lastErr error
	for _, feed := range Feeds {
		var ifNoneMatch string
		var cached *Release
		if ps.ETagFeed == feed && ps.ETag != "" && ps.CachedRelease != nil {
			ifNoneMatch = ps.ETag
			cached = ps.CachedRelease
		}
		rel, etag, notModified, err := u.fetchRelease(ctx, feed, ifNoneMatch, cached)
		if err != nil {
			lastErr = err
			continue
		}
		checkedAt := u.now()
		u.updateState(func(s *persistedState) {
			s.LastCheckAt = checkedAt.UTC().Format(time.RFC3339)
			s.CachedRelease = rel
			if notModified {
				return
			}
			if etag != "" {
				s.ETag = etag
				s.ETagFeed = feed
			} else if s.ETagFeed == feed {
				s.ETag = ""
				s.ETagFeed = ""
			}
		})
		return u.applyReleaseStatus(rel, checkedAt), nil
	}
	msg := "检查更新失败"
	if lastErr != nil {
		msg += "：" + lastErr.Error()
	}
	u.set(func(s *Status) {
		s.Checking = false
		s.Error = msg
		s.CheckedAt = u.now().Format(time.RFC3339)
		s.AutoMode = u.currentMode()
	})
	return u.Status(), lastErr
}

func (u *Updater) applyReleaseStatus(rel *Release, checkedAt time.Time) Status {
	latest := strings.TrimPrefix(rel.Tag, "v")
	asset := assetName()
	// A release may ship some platforms first (e.g. Windows before macOS),
	// or the current OS may not publish prebuilt binaries (e.g. Linux nogui).
	// Only offer it when this platform has an asset and signed checksums (#180).
	avail := asset != "" && Newer(latest, u.Version) && releaseHas(rel, asset, "SHA256SUMS", "SHA256SUMS.sig")
	mode := u.currentMode()
	u.mu.Lock()
	u.release = rel
	sameStaged := u.staged != "" && u.stagedVersion == latest && u.status.Ready
	u.mu.Unlock()
	u.set(func(s *Status) {
		s.Checking = false
		s.Latest = latest
		s.Notes = rel.Body
		s.Available = avail
		s.CheckedAt = checkedAt.Format(time.RFC3339)
		s.AssetName = asset
		s.AutoMode = mode
		if !avail {
			s.Ready = false
			s.AutoApplyOnQuit = false
			s.AutoDeferredUntil = ""
		} else if sameStaged {
			s.Ready = true
			s.Progress = 100
			s.StagedVersion = latest
			s.AutoApplyOnQuit = mode == AutoModeAuto && !s.ApplyFailed
		} else if s.Ready && s.StagedVersion != latest {
			// A newer version superseded an older staged build.
			s.Ready = false
			s.Progress = 0
			s.AutoApplyOnQuit = false
		}
	})
	return u.Status()
}

func (u *Updater) fetchRelease(ctx context.Context, feed, ifNoneMatch string, cached *Release) (*Release, string, bool, error) {
	c := netutil.NewClient(20 * time.Second)
	resp, err := netutil.DoWithRetry(ctx, c, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", feed, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/vnd.github+json, application/json;q=0.9")
		req.Header.Set("User-Agent", "handraw-client/"+u.Version)
		if ifNoneMatch != "" {
			req.Header.Set("If-None-Match", ifNoneMatch)
		}
		return req, nil
	})
	if err != nil {
		return nil, "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified && cached != nil {
		cp := *cached
		cp.Feed = feed
		return &cp, ifNoneMatch, true, nil
	}
	if resp.StatusCode != 200 {
		return nil, "", false, fmt.Errorf("%s 返回 %d", hostOf(feed), resp.StatusCode)
	}
	var rel Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return nil, "", false, err
	}
	if rel.Tag == "" {
		return nil, "", false, errors.New("发布信息缺少版本号")
	}
	rel.Feed = feed
	return &rel, strings.TrimSpace(resp.Header.Get("ETag")), false, nil
}

func hostOf(u string) string {
	u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	if i := strings.IndexByte(u, '/'); i > 0 {
		return u[:i]
	}
	return u
}

// releaseHas reports whether every named asset is attached to rel.
func releaseHas(rel *Release, names ...string) bool {
	have := map[string]bool{}
	for _, a := range rel.Assets {
		have[a.Name] = true
	}
	for _, n := range names {
		if !have[n] {
			return false
		}
	}
	return true
}

// assetName is the program file for this platform, e.g. handraw-windows-amd64.exe.
// Returns "" on platforms that do not ship prebuilt release binaries (e.g. Linux nogui) (#180).
func assetName() string { return assetNameFor(runtime.GOOS, runtime.GOARCH) }

func assetNameFor(goos, goarch string) string {
	switch goos {
	case "windows":
		return "handraw-windows-" + goarch + ".exe"
	case "darwin":
		return "handraw-darwin-" + goarch + ".zip"
	default:
		return ""
	}
}

// Newer reports whether SemVer a is newer than b ("dev" is treated as oldest).
// Prerelease suffixes follow SemVer 2.0 precedence: 1.0.0 > 1.0.0-rc.1 > 1.0.0-beta.2 > 1.0.0-beta.1.
func Newer(a, b string) bool {
	if a == "" {
		return false
	}
	if b == "" || b == "dev" {
		return a != "dev"
	}
	if a == "dev" {
		return false
	}
	pa, preA := parseSemver(a)
	pb, preB := parseSemver(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	if preA == preB {
		return false
	}
	if preA == "" {
		return true // release beats prerelease of the same core version
	}
	if preB == "" {
		return false // prerelease never beats its own release
	}
	return comparePrerelease(preA, preB) > 0
}

func parseSemver(v string) ([]int, string) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	pre := ""
	if i := strings.IndexByte(v, '-'); i >= 0 {
		pre = v[i+1:]
		v = v[:i]
	}
	var out []int
	for _, p := range strings.Split(v, ".") {
		n, _ := strconv.Atoi(p)
		out = append(out, n)
	}
	return out, pre
}

func comparePrerelease(a, b string) int {
	pa := strings.Split(a, ".")
	pb := strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		if pa[i] == pb[i] {
			continue
		}
		na, errA := strconv.Atoi(pa[i])
		nb, errB := strconv.Atoi(pb[i])
		switch {
		case errA == nil && errB == nil:
			if na < nb {
				return -1
			}
			return 1
		case errA == nil:
			return -1 // SemVer 2.0: numeric identifiers have lower precedence than non-numeric
		case errB == nil:
			return 1
		case pa[i] < pb[i]:
			return -1
		default:
			return 1
		}
	}
	if len(pa) < len(pb) {
		return -1
	}
	if len(pa) > len(pb) {
		return 1
	}
	return 0
}

func (u *Updater) asset(name string) (Asset, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.release == nil {
		return Asset{}, false
	}
	for _, a := range u.release.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return Asset{}, false
}

// VerifySums checks the ed25519 signature over "handraw release <version>\n" + SHA256SUMS
// and returns the file -> hash map.
func VerifySums(version string, sums, sigB64 []byte, pubB64 string) (map[string]string, error) {
	if pubB64 == "" {
		return nil, errors.New("此版本未内置更新公钥，不能自动更新")
	}
	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pubB64))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("更新公钥无效")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigB64)))
	if err != nil {
		return nil, errors.New("签名格式无效")
	}
	msg := append([]byte("handraw release "+strings.TrimPrefix(version, "v")+"\n"), sums...)
	if !ed25519.Verify(ed25519.PublicKey(pub), msg, sig) {
		return nil, errors.New("签名校验失败，已拒绝此更新")
	}
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 {
			out[strings.TrimPrefix(f[1], "*")] = strings.ToLower(f[0])
		}
	}
	return out, nil
}

// Download fetches, verifies and stages the new program.
// Prefers asset.Mirrors (e.g. Gitee Releases CDN) before asset.URL (#182).
func (u *Updater) Download(ctx context.Context) error {
	u.mu.Lock()
	st := u.status
	if st.Downloading {
		u.mu.Unlock()
		return nil
	}
	if st.Ready && u.staged != "" && u.stagedVersion == st.Latest && u.stagedSHA256 != "" && fileSHA256Matches(u.staged, u.stagedSHA256) {
		u.mu.Unlock()
		return nil
	}
	if !st.Available {
		u.mu.Unlock()
		return errors.New("没有可用的新版本")
	}
	name := assetName()
	if name == "" {
		u.mu.Unlock()
		return errors.New("当前系统平台暂不支持自动更新")
	}
	u.status.Downloading = true
	u.status.Progress = 0
	u.status.Error = ""
	u.status.Ready = false
	u.status.AutoApplyOnQuit = false
	u.status.StagedVersion = ""
	onChange := u.OnChange
	snap := u.status
	u.mu.Unlock()
	if onChange != nil {
		onChange(snap)
	}

	fail := func(err error) error {
		u.set(func(s *Status) { s.Downloading = false; s.Error = err.Error() })
		return err
	}
	a, ok := u.asset(name)
	if !ok {
		return fail(fmt.Errorf("新版本没有 %s 安装包", name))
	}
	sumsA, ok1 := u.asset("SHA256SUMS")
	sigA, ok2 := u.asset("SHA256SUMS.sig")
	if !ok1 || !ok2 {
		return fail(errors.New("新版本缺少签名文件，已拒绝更新"))
	}
	sums, err := u.getLimitAny(ctx, assetURLs(sumsA), maxMetadataBytes, nil)
	if err != nil {
		return fail(err)
	}
	sig, err := u.getLimitAny(ctx, assetURLs(sigA), maxSigBytes, nil)
	if err != nil {
		return fail(err)
	}
	table, err := VerifySums(st.Latest, sums, sig, PublicKey)
	if err != nil {
		return fail(err)
	}
	want := table[name]
	if want == "" {
		return fail(fmt.Errorf("签名清单中没有 %s", name))
	}
	if err := os.MkdirAll(u.Dir, 0o755); err != nil {
		return fail(err)
	}
	staged := filepath.Join(u.Dir, name)
	// Reuse an already verified staged file on disk without hitting the network again.
	if fileSHA256Matches(staged, want) {
		u.finishStaged(st.Latest, name, staged, want)
		return nil
	}
	tmpPath := staged + ".part"
	_ = os.Remove(tmpPath)
	gotHash, err := u.downloadToFileAny(ctx, assetURLs(a), tmpPath, maxBinaryBytes, func(n int64) {
		if a.Size > 0 {
			pct := int(n * 100 / a.Size)
			if pct > 100 {
				pct = 100
			}
			u.set(func(s *Status) { s.Progress = pct })
		}
	})
	if err != nil {
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if gotHash != want {
		_ = os.Remove(tmpPath)
		return fail(errors.New("安装包校验失败，已丢弃"))
	}
	_ = os.Chmod(tmpPath, 0o755)
	_ = os.Remove(staged)
	if err := os.Rename(tmpPath, staged); err != nil {
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	u.finishStaged(st.Latest, name, staged, want)
	return nil
}

func (u *Updater) finishStaged(ver, name, staged, sha string) {
	mode := u.currentMode()
	u.mu.Lock()
	u.staged = staged
	u.stagedVersion = ver
	u.stagedSHA256 = sha
	u.mu.Unlock()
	ps := u.updateState(func(s *persistedState) {
		s.StagedVersion = ver
		s.StagedAsset = name
		s.StagedPath = staged
		s.StagedSHA256 = sha
		if s.AutoFailVersion == ver {
			s.AutoFailVersion = ""
			s.AutoFailCount = 0
			s.NextRetryAt = ""
		}
	})
	applyFailed := ps.ApplyFailedVersion == ver
	u.set(func(s *Status) {
		s.Downloading = false
		s.Progress = 100
		s.Ready = true
		s.Error = ""
		s.StagedVersion = ver
		s.AutoMode = mode
		s.ApplyFailed = applyFailed
		s.AutoApplyOnQuit = mode == AutoModeAuto && !applyFailed
		s.AutoDeferredUntil = ""
	})
}

func (u *Updater) getLimitAny(ctx context.Context, urls []string, maxBytes int64, progress func(int64)) ([]byte, error) {
	var lastErr error
	for _, target := range urls {
		b, err := u.getLimit(ctx, target, maxBytes, progress)
		if err == nil {
			return b, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("缺少下载地址")
	}
	return nil, lastErr
}

func (u *Updater) downloadToFileAny(ctx context.Context, urls []string, dstPath string, maxBytes int64, progress func(int64)) (string, error) {
	var lastErr error
	for _, target := range urls {
		_ = os.Remove(dstPath)
		h, err := u.downloadToFile(ctx, target, dstPath, maxBytes, progress)
		if err == nil {
			return h, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("缺少安装包下载地址")
	}
	return "", lastErr
}

func (u *Updater) getLimit(ctx context.Context, url string, maxBytes int64, progress func(int64)) ([]byte, error) {
	resp, err := netutil.DoWithRetry(ctx, u.HTTP, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "handraw-client/"+u.Version)
		return req, nil
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("下载失败：%d", resp.StatusCode)
	}
	if maxBytes > 0 && resp.ContentLength > maxBytes {
		return nil, fmt.Errorf("下载内容超过体积上限（%d 字节）", maxBytes)
	}
	var buf bytes.Buffer
	var n int64
	chunk := make([]byte, 64<<10)
	for {
		k, err := resp.Body.Read(chunk)
		if k > 0 {
			n += int64(k)
			if maxBytes > 0 && n > maxBytes {
				return nil, fmt.Errorf("下载内容超过体积上限（%d 字节）", maxBytes)
			}
			buf.Write(chunk[:k])
			if progress != nil {
				progress(n)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

// downloadToFile streams url directly to dstPath while computing SHA-256 and
// enforcing maxBytes, avoiding holding large installers in memory (#176).
func (u *Updater) downloadToFile(ctx context.Context, url, dstPath string, maxBytes int64, progress func(int64)) (string, error) {
	resp, err := netutil.DoWithRetry(ctx, u.HTTP, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "handraw-client/"+u.Version)
		return req, nil
	})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("下载失败：%d", resp.StatusCode)
	}
	if maxBytes > 0 && resp.ContentLength > maxBytes {
		return "", fmt.Errorf("安装包超过体积上限（%d 字节）", maxBytes)
	}
	out, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	var n int64
	chunk := make([]byte, 64<<10)
	for {
		k, rerr := resp.Body.Read(chunk)
		if k > 0 {
			n += int64(k)
			if maxBytes > 0 && n > maxBytes {
				out.Close()
				return "", fmt.Errorf("安装包超过体积上限（%d 字节）", maxBytes)
			}
			if _, werr := out.Write(chunk[:k]); werr != nil {
				out.Close()
				return "", werr
			}
			_, _ = h.Write(chunk[:k])
			if progress != nil {
				progress(n)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			return "", rerr
		}
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Apply swaps the running program for the staged one. The caller restarts.
// Safe to call from both manual "重启升级" and graceful-exit ApplyIfReady: once
// a swap succeeds, subsequent calls in the same process return immediately so
// the exiting process never re-renames the already-replaced binary (#192).
func (u *Updater) Apply() (string, error) {
	u.applyMu.Lock()
	defer u.applyMu.Unlock()

	u.mu.Lock()
	if u.applied {
		exe := u.appliedExe
		u.mu.Unlock()
		return exe, nil
	}
	staged := u.staged
	ver := u.stagedVersion
	execFn := u.executableFn
	u.mu.Unlock()

	if staged == "" {
		return "", errors.New("没有已下载的更新")
	}
	if execFn == nil {
		execFn = os.Executable
	}
	exe, err := execFn()
	if err != nil {
		return "", err
	}
	if resolved, rErr := filepath.EvalSymlinks(exe); rErr == nil && resolved != "" {
		exe = resolved
	}
	var targetExe string
	if runtime.GOOS == "darwin" {
		targetExe, err = applyMac(exe, staged)
	} else {
		targetExe, err = applyWindowsOrDirect(exe, staged)
	}
	if err != nil {
		return "", err
	}

	u.mu.Lock()
	u.applied = true
	u.appliedExe = targetExe
	u.staged = ""
	u.stagedVersion = ""
	u.stagedSHA256 = ""
	u.status.Ready = false
	u.status.AutoApplyOnQuit = false
	u.status.ApplyFailed = false
	u.status.StagedVersion = ""
	st := u.status
	onChange := u.OnChange
	u.mu.Unlock()

	u.updateState(func(s *persistedState) {
		s.StagedVersion = ""
		s.StagedAsset = ""
		s.StagedPath = ""
		s.StagedSHA256 = ""
		if ver != "" && s.ApplyFailedVersion == ver {
			s.ApplyFailedVersion = ""
		}
	})
	if onChange != nil {
		onChange(st)
	}
	return targetExe, nil
}

// applyWindowsOrDirect moves the running binary aside and copies the staged
// binary into place. If the default ".old" backup path is locked by a previous
// process or antivirus scanner, it retries briefly and falls back to a
// PID-qualified backup name so the swap can still succeed (#192, #202).
func applyWindowsOrDirect(exe, staged string) (string, error) {
	old := exe + ".old"
	var lastErr error
	renamed := false
	backoffs := []time.Duration{0, 200 * time.Millisecond, 500 * time.Millisecond, 1 * time.Second}
	for i, wait := range backoffs {
		if wait > 0 {
			time.Sleep(wait)
		}
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err == nil {
			renamed = true
			break
		} else {
			fallbackOld := fmt.Sprintf("%s.old.%d", exe, os.Getpid())
			if i > 0 {
				fallbackOld = fmt.Sprintf("%s.old.%d.%d", exe, os.Getpid(), i)
			}
			_ = os.Remove(fallbackOld)
			if err2 := os.Rename(exe, fallbackOld); err2 == nil {
				old = fallbackOld
				renamed = true
				break
			} else {
				lastErr = err2
			}
		}
	}
	if !renamed {
		return "", fmt.Errorf("替换程序失败：%w", lastErr)
	}
	if err := copyFile(staged, exe, 0o755); err != nil {
		_ = os.Rename(old, exe)
		return "", fmt.Errorf("替换程序失败：%w", err)
	}
	return exe, nil
}

// applyMac replaces the .app bundle from a zip that contains "手绘风.app/…".
func applyMac(exe, staged string) (string, error) {
	// exe is …/X.app/Contents/MacOS/handraw
	app := exe
	for i := 0; i < 3; i++ {
		app = filepath.Dir(app)
	}
	if !strings.HasSuffix(app, ".app") {
		// Not a bundle (dev run): replace the binary from the zip's binary.
		return exe, errors.New("开发运行方式不支持自动更新")
	}
	tmp := app + ".new"
	_ = os.RemoveAll(tmp)
	if err := unzipBundle(staged, tmp); err != nil {
		return "", err
	}
	entries, _ := os.ReadDir(tmp)
	var inner string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".app") {
			inner = filepath.Join(tmp, e.Name())
		}
	}
	if inner == "" {
		return "", errors.New("更新包中没有 .app")
	}
	old := app + ".old"
	_ = os.RemoveAll(old)
	if err := os.Rename(app, old); err != nil {
		return "", err
	}
	if err := os.Rename(inner, app); err != nil {
		_ = os.Rename(old, app)
		return "", err
	}
	_ = os.RemoveAll(tmp)
	_ = os.RemoveAll(old)
	return filepath.Join(app, "Contents", "MacOS", filepath.Base(exe)), nil
}

func unzipBundle(zipPath, dst string) error {
	return unzipBundleWithLimits(zipPath, dst, maxUnzipTotalBytes, maxUnzipFileBytes, maxUnzipFiles)
}

func isWithinDir(root, candidate string) bool {
	cleanRoot := filepath.Clean(root)
	cleanCand := filepath.Clean(candidate)
	if cleanCand == cleanRoot {
		return true
	}
	return strings.HasPrefix(cleanCand, cleanRoot+string(os.PathSeparator))
}

// ensureNoSymlinkEscape verifies that no existing path segment between root and
// target is a symlink, preventing zip entries from writing outside root via an
// earlier symlink entry (#176).
func ensureNoSymlinkEscape(root, target string) error {
	cleanRoot := filepath.Clean(root)
	rel, err := filepath.Rel(cleanRoot, filepath.Clean(target))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("更新包含有非法路径")
	}
	if rel == "." {
		return nil
	}
	cur := cleanRoot
	parts := strings.Split(rel, string(os.PathSeparator))
	for _, seg := range parts[:len(parts)-1] {
		cur = filepath.Join(cur, seg)
		if info, err := os.Lstat(cur); err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return errors.New("更新包路径经过符号链接，已拒绝")
			}
		}
	}
	return nil
}

func unzipBundleWithLimits(zipPath, dst string, maxTotal, maxFile int64, maxFiles int) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	if maxFiles > 0 && len(r.File) > maxFiles {
		return fmt.Errorf("更新包文件数量超过上限（%d）", maxFiles)
	}
	cleanDst := filepath.Clean(dst)
	if err := os.MkdirAll(cleanDst, 0o755); err != nil {
		return err
	}
	var totalWritten int64
	for _, f := range r.File {
		target := filepath.Join(cleanDst, filepath.FromSlash(f.Name))
		if !isWithinDir(cleanDst, target) || target == cleanDst {
			return errors.New("更新包含有非法路径")
		}
		if err := ensureNoSymlinkEscape(cleanDst, target); err != nil {
			return err
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if f.Mode()&os.ModeSymlink != 0 {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			linkBytes, err := io.ReadAll(io.LimitReader(rc, 4096+1))
			rc.Close()
			if err != nil {
				return err
			}
			if len(linkBytes) > 4096 {
				return errors.New("更新包符号链接目标过长")
			}
			linkTarget := strings.TrimSpace(string(linkBytes))
			if linkTarget == "" || filepath.IsAbs(linkTarget) || strings.HasPrefix(linkTarget, `\`) {
				return errors.New("更新包含有越界符号链接")
			}
			resolved := filepath.Clean(filepath.Join(filepath.Dir(target), filepath.FromSlash(linkTarget)))
			if !isWithinDir(cleanDst, resolved) {
				return errors.New("更新包含有越界符号链接")
			}
			_ = os.Remove(target)
			if err := os.Symlink(linkTarget, target); err != nil {
				return err
			}
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode()|0o600)
		if err != nil {
			rc.Close()
			return err
		}
		limit := maxFile
		if maxTotal > 0 {
			rem := maxTotal - totalWritten
			if rem < 0 {
				rem = 0
			}
			if limit <= 0 || rem < limit {
				limit = rem
			}
		}
		var n int64
		if limit > 0 {
			n, err = io.Copy(out, io.LimitReader(rc, limit+1))
			if err == nil && n > limit {
				err = errors.New("更新包解压体积超过上限")
			}
		} else {
			n, err = io.Copy(out, rc)
		}
		rc.Close()
		cerr := out.Close()
		if err != nil {
			return err
		}
		if cerr != nil {
			return cerr
		}
		totalWritten += n
	}
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// CleanupOld removes previous program backups (.old and .old.<pid>) left by
// Apply on Windows (#192).
func CleanupOld() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cleanupOldFor(exe)
}

func cleanupOldFor(exe string) {
	_ = os.Remove(exe + ".old")
	dir := filepath.Dir(exe)
	prefix := filepath.Base(exe) + ".old."
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasPrefix(e.Name(), prefix) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
