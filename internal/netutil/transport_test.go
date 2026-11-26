package netutil

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestParseWindowsProxy(t *testing.T) {
	httpsURL, _ := url.Parse("https://handraw-style.com/api/auth/device")
	httpURL, _ := url.Parse("http://example.com/test")
	localURL, _ := url.Parse("http://127.0.0.1:18520/api/boot")

	cases := []struct {
		name     string
		server   string
		override string
		target   *url.URL
		want     string
	}{
		{"simple clash port", "127.0.0.1:7897", "", httpsURL, "http://127.0.0.1:7897"},
		{"scheme prefixed", "http://127.0.0.1:7890", "", httpsURL, "http://127.0.0.1:7890"},
		{"per-protocol https", "http=127.0.0.1:7890;https=127.0.0.1:7891", "", httpsURL, "http://127.0.0.1:7891"},
		{"per-protocol http", "http=127.0.0.1:7890;https=127.0.0.1:7891", "", httpURL, "http://127.0.0.1:7890"},
		{"socks fallback", "socks=127.0.0.1:10808", "", httpsURL, "socks5://127.0.0.1:10808"},
		{"override exact", "127.0.0.1:7890", "handraw-style.com;localhost", httpsURL, ""},
		{"override wildcard", "127.0.0.1:7890", "*.handraw-style.com;handraw-style.com", httpsURL, ""},
		{"loopback always bypassed", "127.0.0.1:7890", "", localURL, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseWindowsProxy(tc.server, tc.override, tc.target)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			gotStr := ""
			if got != nil {
				gotStr = got.String()
			}
			if gotStr != tc.want {
				t.Fatalf("got %q, want %q", gotStr, tc.want)
			}
		})
	}
}

func TestParseMacSCUtilProxy(t *testing.T) {
	sample := `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}`
	u, _ := url.Parse("https://handraw-style.com/api/auth/device")
	got := parseMacSCUtilProxy(sample, u)
	if got == nil || got.String() != "http://127.0.0.1:7891" {
		t.Fatalf("expected http://127.0.0.1:7891, got %v", got)
	}
	localU, _ := url.Parse("https://printer.local/status")
	if got := parseMacSCUtilProxy(sample, localU); got != nil {
		t.Fatalf("expected *.local bypassed, got %v", got)
	}
}

func TestSystemProxyEnvPrecedenceAndLoopbackBypass(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:19999")
	req, _ := http.NewRequest("GET", "https://handraw-style.com/api/auth/device", nil)
	got, err := SystemProxyFunc(req)
	if err != nil || got == nil || got.String() != "http://127.0.0.1:19999" {
		t.Fatalf("expected env HTTPS_PROXY to win, got %v err=%v", got, err)
	}
	localReq, _ := http.NewRequest("GET", "http://127.0.0.1:18520/api/boot", nil)
	if got, err := SystemProxyFunc(localReq); err != nil || got != nil {
		t.Fatalf("expected loopback never proxied, got %v err=%v", got, err)
	}
}

func TestIsTransientReset(t *testing.T) {
	wsarecv := errors.New(`Post "https://handraw-style.com/api/auth/device": read tcp [2408:8240::1]:11594->[2606:4700:3036::6815:f66]:443: wsarecv: An existing connection was forcibly closed by the remote host.`)
	if !IsTransientReset(wsarecv) {
		t.Fatalf("expected Windows wsarecv reset to be classified as transient reset")
	}
	if IsTransientReset(context.Canceled) || IsTransientReset(context.DeadlineExceeded) {
		t.Fatalf("context cancellation/deadline must not be classified as transient reset")
	}
}

func TestPreferIPv4DialAndClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	c := NewClient(0)
	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatalf("client GET failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}
