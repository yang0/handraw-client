package server

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/web"
)

// TestWebAssetsCompatibleWithMacOS12WebKit15 guards against modern JS/CSS features
// that break app boot, styling, or interaction in macOS 12 Monterey WKWebView
// (WebKit / Safari 15.x) (#209).
func TestWebAssetsCompatibleWithMacOS12WebKit15(t *testing.T) {
	reLookbehind := regexp.MustCompile(`\(\?<[=!]`)
	reObjectHasOwn := regexp.MustCompile(`\bObject\.hasOwn\s*\(`)
	reBareStructuredClone := regexp.MustCompile(`\bstructuredClone\s*\(`)
	reBareRandomUUID := regexp.MustCompile(`\bcrypto\.randomUUID\s*\(`)
	reBareDialogProto := regexp.MustCompile(`"closedBy"\s+in\s+HTMLDialogElement\.prototype`)

	err := fs.WalkDir(web.FS, "js", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() || !strings.HasSuffix(path, ".js") {
			return walkErr
		}
		raw, err := fs.ReadFile(web.FS, path)
		if err != nil {
			return err
		}
		src := string(raw)

		if reLookbehind.MatchString(src) {
			t.Errorf("%s contains regex lookbehind (?<= or (?<!) which causes a SyntaxError at parse time on macOS 12 / Safari < 16.4", path)
		}
		if reObjectHasOwn.MatchString(src) {
			t.Errorf("%s uses Object.hasOwn() which is unavailable on macOS 12.0-12.2 / Safari < 15.4; use hasOwn() from api.js", path)
		}
		if path != "js/api.js" && reBareStructuredClone.MatchString(src) {
			t.Errorf("%s calls structuredClone() directly (unavailable on Safari < 15.4); use cloneData() from api.js", path)
		}
		if path != "js/api.js" && path != "js/obsidian-shim.js" && reBareRandomUUID.MatchString(src) {
			t.Errorf("%s calls crypto.randomUUID() directly (unavailable on Safari < 15.4); use randomId() from api.js", path)
		}
		if reBareDialogProto.MatchString(src) && !strings.Contains(src, `typeof HTMLDialogElement !== "undefined"`) {
			t.Errorf("%s accesses HTMLDialogElement.prototype without guarding typeof HTMLDialogElement !== \"undefined\"", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk web/js: %v", err)
	}

	err = fs.WalkDir(web.FS, "css", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() || !strings.HasSuffix(path, ".css") {
			return walkErr
		}
		raw, err := fs.ReadFile(web.FS, path)
		if err != nil {
			return err
		}
		if strings.Contains(string(raw), "light-dark(") {
			t.Errorf("%s uses CSS light-dark() which is unsupported on macOS 12-14.4 / Safari < 17.5", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk web/css: %v", err)
	}

	indexBytes, err := fs.ReadFile(web.FS, "index.html")
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if !strings.Contains(string(indexBytes), "no-popover") {
		t.Errorf("web/index.html must detect missing Popover API and set html.no-popover before paint")
	}

	appCSSBytes, err := fs.ReadFile(web.FS, "css/app.css")
	if err != nil {
		t.Fatalf("read css/app.css: %v", err)
	}
	if !strings.Contains(string(appCSSBytes), "html.no-popover [popover]") {
		t.Errorf("web/css/app.css must hide [popover] elements when html.no-popover is set")
	}
}
