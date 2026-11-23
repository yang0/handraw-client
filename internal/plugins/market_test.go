package plugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
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
}
