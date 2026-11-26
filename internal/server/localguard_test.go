package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestIsLocalOriginExactHostMatch(t *testing.T) {
	ok := []string{
		"http://127.0.0.1", "http://127.0.0.1:18520", "http://localhost:18520",
		"https://wails.localhost", "http://[::1]:18520", "wails://wails",
	}
	bad := []string{
		"http://127.0.0.1.attacker.example", "http://127.0.0.1.attacker.example:18520",
		"http://localhost.attacker.example", "https://wails.localhost.attacker.example",
		"http://attacker.example", "https://handraw-style.com", "file://", "null", "",
		"http://127.0.0.1@attacker.example",
	}
	for _, o := range ok {
		if !isLocalOrigin(o) {
			t.Errorf("expected local origin: %q", o)
		}
	}
	for _, o := range bad {
		if isLocalOrigin(o) {
			t.Errorf("must reject origin: %q", o)
		}
	}
	if !isClipOrigin("chrome-extension://abcdefghijklmnop") {
		t.Errorf("paired extension origin should be accepted on clip paths")
	}
	if isClipOrigin("http://localhost.attacker.example") {
		t.Errorf("clip origin must not accept look-alike hosts")
	}
}

func rawReq(h http.Handler, method, target, host string, headers map[string]string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://127.0.0.1:18520"+target, bytes.NewBufferString(body))
	req.Host = host
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// #171: the DNS-rebinding chain reproduced during the security review.
func TestLocalServerRejectsRebindingAndSimpleRequestBypass(t *testing.T) {
	srv, cancel := setupTestServer(t, "")
	defer cancel()
	srv.Web = fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html>")}}
	h := srv.Handler()
	tok := srv.Token

	// 1. A foreign Host (rebinding page) must not get the UI or the token cookie.
	rr := rawReq(h, "GET", "/", "127.0.0.1.attacker.example:18520", nil, "")
	if rr.Code != http.StatusForbidden {
		t.Fatalf("foreign Host should be rejected, got %d", rr.Code)
	}
	if strings.Contains(rr.Header().Get("Set-Cookie"), "hw=") {
		t.Fatalf("token cookie must not be issued to a foreign Host")
	}

	// 2. Look-alike Origin with a valid token in the query, text/plain body.
	rr = rawReq(h, "POST", "/api/posts?t="+tok, "127.0.0.1:18520",
		map[string]string{"Origin": "http://127.0.0.1.attacker.example", "Content-Type": "text/plain"}, `{"platform":"xiaohongshu"}`)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("look-alike origin must be rejected, got %d %s", rr.Code, rr.Body.String())
	}

	// 3. Even without an Origin header, a write that carries the token only in
	//    the query/cookie (what a cross-site "simple" request can do) is refused.
	rr = rawReq(h, "POST", "/api/posts?t="+tok, "127.0.0.1:18520",
		map[string]string{"Content-Type": "text/plain"}, `{"platform":"xiaohongshu"}`)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("write without token header must be rejected, got %d", rr.Code)
	}
	req := httptest.NewRequest("POST", "http://127.0.0.1:18520/api/posts", bytes.NewBufferString(`{}`))
	req.Host = "127.0.0.1:18520"
	req.AddCookie(&http.Cookie{Name: "hw", Value: tok})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cookie-only write must be rejected, got %d", rec.Code)
	}

	// 4. The desktop UI's own requests keep working.
	rr = rawReq(h, "POST", "/api/posts", "127.0.0.1:18520",
		map[string]string{"Origin": "http://127.0.0.1:18520", "X-Handraw-Token": tok, "Content-Type": "application/json"}, `{"platform":"xiaohongshu"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("legitimate UI write should succeed, got %d %s", rr.Code, rr.Body.String())
	}
	rr = rawReq(h, "GET", "/api/posts?t="+tok, "localhost:18520", nil, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("token-in-query reads (image src) should still work, got %d", rr.Code)
	}
	rr = rawReq(h, "GET", "/", "127.0.0.1:18520", nil, "")
	if !strings.Contains(rr.Header().Get("Set-Cookie"), "hw=") {
		t.Fatalf("UI on a local Host should still receive the token cookie")
	}
}

// #171: HTML/SVG from library folders must not run as same-origin pages.
func TestActiveDocumentsServedSandboxed(t *testing.T) {
	for _, p := range []string{"a.svg", "b.HTML", "c.xml"} {
		if !isActiveDocumentExt(p) {
			t.Errorf("%s should be sandboxed", p)
		}
	}
	for _, p := range []string{"a.png", "b.jpg", "c.webp", "d.mp4", "e.pdf"} {
		if isActiveDocumentExt(p) {
			t.Errorf("%s should be served normally", p)
		}
	}
}
