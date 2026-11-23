package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func tgzOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, body := range files {
		hdr := &tar.Header{
			Name:     name,
			Mode:     0o644,
			Size:     int64(len(body)),
			Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	_ = tw.Close()
	_ = gw.Close()
	return buf.Bytes()
}

func TestParseMarketIndexAndIconResolution(t *testing.T) {
	raw := []byte(`{
		"format": 1,
		"title": {"zh": "手绘风官方市场", "en": "Handraw Market"},
		"metadata": {"categories": {"creation": {"title": {"zh": "创作"}}}},
		"plugins": [{
			"name": "dsh-plugin-demo",
			"title": {"zh": "演示插件"},
			"icon": "./icons/demo.svg",
			"metadata": {"categories": ["creation"]},
			"versions": [{"version": "1.0.0", "publishTimestamp": 1700000000, "source": {"type": "npm"}}]
		}]
	}`)
	idx, err := ParseMarketIndex(raw, "https://raw.githubusercontent.com/yang0/handraw-plugins/main/index.json")
	if err != nil {
		t.Fatalf("ParseMarketIndex failed: %v", err)
	}
	wantIcon := "https://raw.githubusercontent.com/yang0/handraw-plugins/main/icons/demo.svg"
	if idx.Plugins[0].Icon != wantIcon {
		t.Fatalf("expected resolved icon %q, got %q", wantIcon, idx.Plugins[0].Icon)
	}
	if _, err := ParseMarketIndex([]byte(`{"format": 2}`), "https://example.com/index.json"); err == nil {
		t.Fatal("expected unsupported format error")
	}
}

func TestInstallZipSubdirAndNPMTarGz(t *testing.T) {
	r := NewRuntime(t.TempDir())

	// 1. Monorepo zip with subdirectory (like plugins/dsh-handraw-style).
	pkgJSON := `{"name":"dsh-plugin-sub","version":"0.5.0","exports":{".":"./host.js","./client":"./client.js"},"dsh":{"client":{"platform":"web"}}}`
	z := zipOf(t, map[string]string{
		"repo-main/README.md":                         "root",
		"repo-main/plugins/sub/package.json":          pkgJSON,
		"repo-main/plugins/sub/host.js":               "export function apply(){}",
		"repo-main/plugins/sub/client.js":             "window.__ModuleLoader__.load({id:'x',factory:()=>({})})",
	})
	c, err := r.InstallZipSubdir(z, "plugins/sub", "market:dsh-plugin-sub@0.5.0")
	if err != nil {
		t.Fatalf("InstallZipSubdir failed: %v", err)
	}
	if c.ID != "dsh-plugin-sub" || c.Kind != "dsh" || c.DSH == nil || c.DSH.Compat != "full" {
		t.Fatalf("unexpected monorepo plugin: %+v", c)
	}

	// 2. npm registry + .tgz unpack via InstallFromMarketVersion.
	npmPkg := `{"name":"dsh-npm-demo","version":"2.1.0","exports":{".":"./host.js","./client":"./client.js"},"dsh":{"client":{"platform":"web"}}}`
	tgz := tgzOf(t, map[string]string{
		"package/package.json": npmPkg,
		"package/host.js":      "export function apply(){}",
		"package/client.js":    "window.__ModuleLoader__.load({id:'y',factory:()=>({})})",
	})
	var mockNPM *httptest.Server
	mockNPM = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/dsh-npm-demo/2.1.0":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"dist":{"tarball":"` + mockNPM.URL + `/dsh-npm-demo-2.1.0.tgz"}}`))
		case "/dsh-npm-demo-2.1.0.tgz":
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(tgz)
		default:
			http.NotFound(w, req)
		}
	}))
	defer mockNPM.Close()

	c2, err := r.InstallFromMarketVersion(context.Background(), "dsh-npm-demo", MarketVersion{
		Version: "2.1.0",
		Source:  MarketSourceSpec{Type: "npm", Registry: mockNPM.URL},
	}, "https://example.com/index.json")
	if err != nil {
		t.Fatalf("InstallFromMarketVersion(npm) failed: %v", err)
	}
	if c2.ID != "dsh-npm-demo" || c2.Version != "2.1.0" || c2.Kind != "dsh" {
		t.Fatalf("unexpected npm plugin: %+v", c2)
	}

	// 3. Streaming tar.gz with GitHub-style wrapper + monorepo subdir.
	ghTar := tgzOf(t, map[string]string{
		"handraw-style-abc123/README.md":                           "root",
		"handraw-style-abc123/plugins/dsh-sub/package.json":        pkgJSON,
		"handraw-style-abc123/plugins/dsh-sub/host.js":             "export function apply(){}",
		"handraw-style-abc123/plugins/dsh-sub/client.js":           "window.__ModuleLoader__.load({id:'z',factory:()=>({})})",
	})
	c3, err := r.InstallTarGzStream(bytes.NewReader(ghTar), "plugins/dsh-sub", "git-tar")
	if err != nil {
		t.Fatalf("InstallTarGzStream(subdir) failed: %v", err)
	}
	if c3.ID != "dsh-plugin-sub" || c3.Kind != "dsh" {
		t.Fatalf("unexpected tar.gz subdir plugin: %+v", c3)
	}
}

func TestInstallGitShallowAndSparseSubdir(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available")
	}
	repo := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command(gitBin, args...)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")

	_ = os.WriteFile(filepath.Join(repo, "BIG_UNRELATED.txt"), []byte("unrelated root file"), 0o644)
	sub := filepath.Join(repo, "plugins", "demo-git")
	_ = os.MkdirAll(sub, 0o755)
	_ = os.WriteFile(filepath.Join(sub, "package.json"), []byte(`{"name":"dsh-git-sparse","version":"0.3.0","exports":{".":"./host.js","./client":"./client.js"},"dsh":{"client":{"platform":"web"}}}`), 0o644)
	_ = os.WriteFile(filepath.Join(sub, "host.js"), []byte(`export function apply(){}`), 0o644)
	_ = os.WriteFile(filepath.Join(sub, "client.js"), []byte(`window.__ModuleLoader__.load({id:'g',factory:()=>({})})`), 0o644)
	run("add", ".")
	run("commit", "-m", "init")
	sha := run("rev-parse", "HEAD")

	r := NewRuntime(t.TempDir())
	c, err := r.InstallGit(context.Background(), repo, sha, "plugins/demo-git", "market:dsh-git-sparse@0.3.0")
	if err != nil {
		t.Fatalf("InstallGit sparse failed: %v", err)
	}
	if c.ID != "dsh-git-sparse" || c.Version != "0.3.0" || c.Kind != "dsh" {
		t.Fatalf("unexpected git plugin: %+v", c)
	}
	if _, err := os.Stat(filepath.Join(c.Dir, "BIG_UNRELATED.txt")); err == nil {
		t.Fatal("sparse subdir install leaked unrelated root file")
	}
}
