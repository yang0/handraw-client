package netutil

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
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

func TestProxyOverrideCIDRAndNoProxy(t *testing.T) {
	if !matchProxyOverride("192.168.0.0/16;169.254/16;.internal.corp", "192.168.1.55") {
		t.Fatalf("expected standard CIDR 192.168.0.0/16 match")
	}
	if !matchProxyOverride("192.168.0.0/16;169.254/16;.internal.corp", "169.254.10.20") {
		t.Fatalf("expected macOS shorthand CIDR 169.254/16 match")
	}
	if !matchProxyOverride("192.168.0.0/16;169.254/16;.internal.corp", "api.internal.corp") {
		t.Fatalf("expected leading-dot domain match")
	}
	if matchProxyOverride("192.168.0.0/16;169.254/16", "104.21.15.102") {
		t.Fatalf("public IP must not match private CIDR overrides")
	}

	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:19999")
	t.Setenv("NO_PROXY", "handraw-style.com,.example.org")
	req, _ := http.NewRequest("GET", "https://handraw-style.com/api/boot", nil)
	if got, err := SystemProxyFunc(req); err != nil || got != nil {
		t.Fatalf("expected NO_PROXY to bypass env/OS proxy, got %v err=%v", got, err)
	}
}

func TestOrderIPsPreferIPv4AndProxyEndpointAddr(t *testing.T) {
	ips := []net.IPAddr{
		{IP: net.ParseIP("2606:4700:3036::6815:f66")},
		{IP: net.ParseIP("104.21.15.102")},
		{IP: net.ParseIP("2606:4700:3036::ac43:d2d4")},
		{IP: net.ParseIP("172.67.210.212")},
	}
	ordered := OrderIPsPreferIPv4(ips)
	if ordered[0].IP.String() != "104.21.15.102" || ordered[1].IP.String() != "172.67.210.212" || ordered[2].IP.To4() != nil {
		t.Fatalf("expected IPv4 addresses first, got %+v", ordered)
	}
	pu, _ := url.Parse("http://127.0.0.1:7897")
	if got := ProxyEndpointAddr(pu); got != "127.0.0.1:7897" {
		t.Fatalf("unexpected ProxyEndpointAddr: %q", got)
	}
	puDefault, _ := url.Parse("socks5://127.0.0.1")
	if got := ProxyEndpointAddr(puDefault); got != "127.0.0.1:1080" {
		t.Fatalf("unexpected default socks5 port: %q", got)
	}
}

type rtFunc func(*http.Request) (*http.Response, error)

func (f rtFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDoWithRetry(t *testing.T) {
	var attempts atomic.Int32
	c := &http.Client{
		Transport: rtFunc(func(r *http.Request) (*http.Response, error) {
			if attempts.Add(1) == 1 {
				return nil, errors.New("wsarecv: An existing connection was forcibly closed by the remote host.")
			}
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader("ok")),
			}, nil
		}),
	}
	resp, err := DoWithRetry(context.Background(), c, func() (*http.Request, error) {
		return http.NewRequestWithContext(context.Background(), "GET", "https://handraw-style.example/test", nil)
	})
	if err != nil {
		t.Fatalf("DoWithRetry failed: %v", err)
	}
	resp.Body.Close()
	if attempts.Load() != 2 || resp.StatusCode != 200 {
		t.Fatalf("expected 2 attempts and 200, got attempts=%d status=%d", attempts.Load(), resp.StatusCode)
	}
}
