// Package updater checks GitHub Releases for new versions, verifies the
// ed25519-signed SHA256SUMS (like Magpie), replaces the program, and updates
// the resource pack file by file.
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
)

// PublicKey verifies release signatures. Set at build time with
// -ldflags "-X github.com/yang0/handraw-client/internal/updater.PublicKey=<base64>".
var PublicKey = ""

const Repo = "yang0/handraw-client"

// Feeds are tried in order; the first that answers wins.
var Feeds = []string{
	"https://api.github.com/repos/" + Repo + "/releases/latest",
	"https://gitee.com/api/v5/repos/yang02010/handraw-client/releases/latest",
	"https://handraw-style.com/static/client/latest.json",
}

type Asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

type Release struct {
	Tag       string  `json:"tag_name"`
	Name      string  `json:"name"`
	Body      string  `json:"body"`
	Published string  `json:"published_at"`
	Assets    []Asset `json:"assets"`
	Feed      string  `json:"feed"`
}

type Status struct {
	Current       string `json:"current"`
	Latest        string `json:"latest"`
	Notes         string `json:"notes"`
	Available     bool   `json:"available"`
	Checking      bool   `json:"checking"`
	Downloading   bool   `json:"downloading"`
	Progress      int    `json:"progress"`
	Ready         bool   `json:"ready"` // downloaded and verified; restart to apply
	Error         string `json:"error,omitempty"`
	CheckedAt     string `json:"checkedAt,omitempty"`
	AssetName     string `json:"assetName,omitempty"`
	ResourceLocal string `json:"resourceLocal,omitempty"`
	ResourceNew   string `json:"resourceNew,omitempty"`
	ResourceFiles int    `json:"resourceFiles,omitempty"`
	ResourceBytes int64  `json:"resourceBytes,omitempty"`
}

type Updater struct {
	Version  string
	Dir      string // where downloads are staged
	HTTP     *http.Client
	mu       sync.Mutex
	status   Status
	release  *Release
	staged   string
	OnChange func(Status)
}

func New(version, dir string) *Updater {
	return &Updater{Version: version, Dir: dir, HTTP: &http.Client{Timeout: 30 * time.Minute}, status: Status{Current: version}}
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

// Check reads the latest release from the first reachable feed.
func (u *Updater) Check(ctx context.Context) (Status, error) {
	u.set(func(s *Status) { s.Checking = true; s.Error = "" })
	var lastErr error
	for _, feed := range Feeds {
		rel, err := u.fetchRelease(ctx, feed)
		if err != nil {
			lastErr = err
			continue
		}
		u.mu.Lock()
		u.release = rel
		u.mu.Unlock()
		latest := strings.TrimPrefix(rel.Tag, "v")
		avail := Newer(latest, u.Version)
		asset := assetName()
		u.set(func(s *Status) {
			s.Checking = false
			s.Latest = latest
			s.Notes = rel.Body
			s.Available = avail
			s.CheckedAt = time.Now().Format(time.RFC3339)
			s.AssetName = asset
		})
		return u.Status(), nil
	}
	msg := "检查更新失败"
	if lastErr != nil {
		msg += "：" + lastErr.Error()
	}
	u.set(func(s *Status) { s.Checking = false; s.Error = msg; s.CheckedAt = time.Now().Format(time.RFC3339) })
	return u.Status(), lastErr
}

func (u *Updater) fetchRelease(ctx context.Context, feed string) (*Release, error) {
	c := &http.Client{Timeout: 20 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "GET", feed, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "handraw-client/"+u.Version)
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s 返回 %d", hostOf(feed), resp.StatusCode)
	}
	var rel Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return nil, err
	}
	if rel.Tag == "" {
		return nil, errors.New("发布信息缺少版本号")
	}
	rel.Feed = feed
	return &rel, nil
}

func hostOf(u string) string {
	u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	if i := strings.IndexByte(u, '/'); i > 0 {
		return u[:i]
	}
	return u
}

// assetName is the program file for this platform, e.g. handraw-windows-amd64.exe.
func assetName() string {
	switch runtime.GOOS {
	case "windows":
		return "handraw-windows-" + runtime.GOARCH + ".exe"
	case "darwin":
		return "handraw-darwin-" + runtime.GOARCH + ".zip"
	}
	return "handraw-" + runtime.GOOS + "-" + runtime.GOARCH
}

// Newer reports whether version a is newer than b (dotted numbers, "dev" is oldest).
func Newer(a, b string) bool {
	if a == "" {
		return false
	}
	if b == "" || b == "dev" {
		return a != "dev"
	}
	pa, pb := parts(a), parts(b)
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
	return false
}

func parts(v string) []int {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out []int
	for _, p := range strings.Split(v, ".") {
		n, _ := strconv.Atoi(p)
		out = append(out, n)
	}
	return out
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
func (u *Updater) Download(ctx context.Context) error {
	st := u.Status()
	if !st.Available {
		return errors.New("没有可用的新版本")
	}
	name := assetName()
	a, ok := u.asset(name)
	if !ok {
		return fmt.Errorf("新版本没有 %s 安装包", name)
	}
	sumsA, ok1 := u.asset("SHA256SUMS")
	sigA, ok2 := u.asset("SHA256SUMS.sig")
	if !ok1 || !ok2 {
		return errors.New("新版本缺少签名文件，已拒绝更新")
	}
	u.set(func(s *Status) { s.Downloading = true; s.Progress = 0; s.Error = "" })
	fail := func(err error) error {
		u.set(func(s *Status) { s.Downloading = false; s.Error = err.Error() })
		return err
	}
	sums, err := u.get(ctx, sumsA.URL, nil)
	if err != nil {
		return fail(err)
	}
	sig, err := u.get(ctx, sigA.URL, nil)
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
	data, err := u.get(ctx, a.URL, func(n int64) {
		if a.Size > 0 {
			u.set(func(s *Status) { s.Progress = int(n * 100 / a.Size) })
		}
	})
	if err != nil {
		return fail(err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != want {
		return fail(errors.New("安装包校验失败，已丢弃"))
	}
	_ = os.MkdirAll(u.Dir, 0o755)
	staged := filepath.Join(u.Dir, name)
	if err := os.WriteFile(staged, data, 0o755); err != nil {
		return fail(err)
	}
	u.mu.Lock()
	u.staged = staged
	u.mu.Unlock()
	u.set(func(s *Status) { s.Downloading = false; s.Progress = 100; s.Ready = true })
	return nil
}

func (u *Updater) get(ctx context.Context, url string, progress func(int64)) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "handraw-client/"+u.Version)
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("下载失败：%d", resp.StatusCode)
	}
	var buf bytes.Buffer
	var n int64
	chunk := make([]byte, 64<<10)
	for {
		k, err := resp.Body.Read(chunk)
		if k > 0 {
			buf.Write(chunk[:k])
			n += int64(k)
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

// Apply swaps the running program for the staged one. The caller restarts.
func (u *Updater) Apply() (string, error) {
	u.mu.Lock()
	staged := u.staged
	u.mu.Unlock()
	if staged == "" {
		return "", errors.New("没有已下载的更新")
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	if runtime.GOOS == "darwin" {
		return applyMac(exe, staged)
	}
	// Windows can't overwrite a running exe but can rename it.
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return "", fmt.Errorf("替换程序失败：%w", err)
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
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		target := filepath.Join(dst, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(target, filepath.Clean(dst)+string(os.PathSeparator)) {
			return errors.New("更新包含有非法路径")
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(target, 0o755)
			continue
		}
		os.MkdirAll(filepath.Dir(target), 0o755)
		if f.Mode()&os.ModeSymlink != 0 {
			rc, _ := f.Open()
			link, _ := io.ReadAll(rc)
			rc.Close()
			_ = os.Symlink(string(link), target)
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
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return err
		}
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

// CleanupOld removes the previous program left by Apply on Windows.
func CleanupOld() {
	if exe, err := os.Executable(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}
