// Package netutil provides an HTTP transport tailored for desktop users:
// it honors OS system proxy settings (Windows Internet Settings / macOS scutil)
// in addition to HTTP_PROXY/HTTPS_PROXY environment variables, prefers IPv4 over
// flaky ISP IPv6 paths to Cloudflare, and classifies transient TLS/TCP resets (#181).
package netutil

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

var (
	sharedOnce      sync.Once
	sharedTransport *http.Transport
)

// SharedTransport returns the process-wide pooled HTTP transport with OS system
// proxy support and IPv4-first dialing.
func SharedTransport() *http.Transport {
	sharedOnce.Do(func() {
		sharedTransport = NewTransport()
	})
	return sharedTransport
}

// NewTransport constructs a fresh HTTP transport configured with OS system proxy
// resolution and IPv4-first dialing.
func NewTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 SystemProxyFunc,
		DialContext:           PreferIPv4DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   12 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

// NewClient returns an *http.Client backed by SharedTransport.
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: SharedTransport(),
	}
}

// InstallDefaultTransport replaces http.DefaultTransport with SharedTransport
// so every package using &http.Client{} (providers, plugins, skills, media
// fetches, etc.) automatically honors OS system proxy settings and prefers IPv4.
func InstallDefaultTransport() {
	http.DefaultTransport = SharedTransport()
}

// SystemProxyFunc resolves proxy settings in priority order:
//  1. Never proxy loopback destinations (127.0.0.1, localhost, ::1).
//  2. Respect NO_PROXY / no_proxy environment bypasses.
//  3. Standard HTTP_PROXY / HTTPS_PROXY environment variables.
//  4. Live OS system proxy (Windows Internet Settings / macOS scutil --proxy).
func SystemProxyFunc(req *http.Request) (*url.URL, error) {
	if req == nil || req.URL == nil {
		return nil, nil
	}
	if isLoopbackHost(req.URL.Hostname()) {
		return nil, nil
	}
	if envNoProxyMatches(req.URL.Hostname()) {
		return nil, nil
	}
	if envProxy, err := http.ProxyFromEnvironment(req); envProxy != nil || err != nil {
		return envProxy, err
	}
	return osSystemProxy(req.URL)
}

func envNoProxyMatches(host string) bool {
	raw := strings.TrimSpace(os.Getenv("NO_PROXY"))
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("no_proxy"))
	}
	if raw == "" {
		return false
	}
	return matchProxyOverride(strings.ReplaceAll(raw, ",", ";"), host)
}

// OrderIPsPreferIPv4 returns a new slice with IPv4 addresses placed before IPv6
// addresses while preserving relative order within each family.
func OrderIPsPreferIPv4(ips []net.IPAddr) []net.IPAddr {
	if len(ips) <= 1 {
		return ips
	}
	out := make([]net.IPAddr, 0, len(ips))
	for _, ip := range ips {
		if ip.IP != nil && ip.IP.To4() != nil {
			out = append(out, ip)
		}
	}
	for _, ip := range ips {
		if ip.IP == nil || ip.IP.To4() == nil {
			out = append(out, ip)
		}
	}
	return out
}

// ProxyEndpointAddr returns the canonical host:port dialed by net/http when
// connecting to proxyURL (supplying the scheme's default port when omitted).
func ProxyEndpointAddr(proxyURL *url.URL) string {
	if proxyURL == nil || proxyURL.Host == "" {
		return ""
	}
	host := proxyURL.Hostname()
	port := proxyURL.Port()
	if port == "" {
		switch strings.ToLower(proxyURL.Scheme) {
		case "https":
			port = "443"
		case "socks", "socks5", "socks5h":
			port = "1080"
		default:
			port = "80"
		}
	}
	return strings.ToLower(net.JoinHostPort(host, port))
}

// DoWithRetry executes an HTTP request created by makeReq, retrying once on a
// pre-response transient TCP/TLS reset (after closing idle connections).
func DoWithRetry(ctx context.Context, client *http.Client, makeReq func() (*http.Request, error)) (*http.Response, error) {
	if client == nil {
		client = NewClient(60 * time.Second)
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := makeReq()
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if attempt == 0 && ctx.Err() == nil && IsTransientReset(err) {
			if tr, ok := client.Transport.(*http.Transport); ok && tr != nil {
				tr.CloseIdleConnections()
			} else if client.Transport == nil {
				if tr, ok := http.DefaultTransport.(*http.Transport); ok && tr != nil {
					tr.CloseIdleConnections()
				}
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}
		break
	}
	return nil, lastErr
}

// PreferIPv4DialContext dials IPv4 ("tcp4") first for dual-stack "tcp" requests
// so mainland China broadband ISPs with broken Cloudflare IPv6 routes do not
// establish IPv6 TCP connections only to receive post-connect TLS RSTs.
// Falls back to "tcp6" automatically on IPv6-only networks.
func PreferIPv4DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	if network != "tcp" {
		return d.DialContext(ctx, network, addr)
	}
	host, _, err := net.SplitHostPort(addr)
	if err == nil {
		if ip := net.ParseIP(host); ip != nil || isLoopbackHost(host) {
			return d.DialContext(ctx, network, addr)
		}
	}

	v4Ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	conn, err4 := d.DialContext(v4Ctx, "tcp4", addr)
	cancel()
	if err4 == nil {
		return conn, nil
	}
	if ctx.Err() != nil {
		return nil, err4
	}
	conn6, err6 := d.DialContext(ctx, "tcp6", addr)
	if err6 == nil {
		return conn6, nil
	}
	return nil, err4
}

// IsTransientReset reports whether err represents a pre-response connection
// reset/drop (e.g. Windows WSAECONNRESET / wsarecv forcibly closed, ECONNRESET,
// unexpected EOF) where retrying on a fresh connection is safe and useful.
func IsTransientReset(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	low := strings.ToLower(err.Error())
	for _, needle := range []string{
		"forcibly closed by the remote host",
		"connection reset by peer",
		"wsarecv",
		"wsasend",
		"unexpected eof",
		"broken pipe",
		"use of closed network connection",
		"tls: handshake failure",
	} {
		if strings.Contains(low, needle) {
			return true
		}
	}
	return false
}

// FriendlyNetworkError returns a concise, actionable Chinese diagnosis when a
// network error looks like a carrier/proxy/TLS reset.
func FriendlyNetworkError(err error) string {
	if err == nil {
		return ""
	}
	if IsTransientReset(err) {
		return "连接官网时被远端或运营商链路重置（常见于宽带 IPv6 波动或代理未生效），已自动重试仍失败；如正在使用代理请确认已开启系统代理或 TUN 模式，也可切换网络后重试"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "连接官网超时，请检查当前网络或代理设置后重试"
	}
	return ""
}

func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(strings.Trim(host, "[]")))
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// parseWindowsProxy interprets Windows Internet Settings registry values
// (ProxyServer and ProxyOverride) for target URL u.
func parseWindowsProxy(proxyServer, proxyOverride string, u *url.URL) (*url.URL, error) {
	proxyServer = strings.TrimSpace(proxyServer)
	if proxyServer == "" || u == nil {
		return nil, nil
	}
	if isLoopbackHost(u.Hostname()) || matchProxyOverride(proxyOverride, u.Hostname()) {
		return nil, nil
	}
	targetScheme := strings.ToLower(strings.TrimSpace(u.Scheme))
	if targetScheme == "" {
		targetScheme = "https"
	}

	var chosen string
	if strings.Contains(proxyServer, "=") {
		// Format: "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"
		byScheme := map[string]string{}
		for _, part := range strings.Split(proxyServer, ";") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			k, v, ok := strings.Cut(part, "=")
			if !ok {
				continue
			}
			k = strings.ToLower(strings.TrimSpace(k))
			v = strings.TrimSpace(v)
			if k != "" && v != "" {
				byScheme[k] = v
			}
		}
		if v := byScheme[targetScheme]; v != "" {
			chosen = v
		} else if targetScheme == "https" && byScheme["http"] != "" {
			chosen = byScheme["http"]
		} else if v := byScheme["socks"]; v != "" {
			if !strings.Contains(v, "://") {
				chosen = "socks5://" + v
			} else {
				chosen = v
			}
		} else if v := byScheme["socks5"]; v != "" {
			if !strings.Contains(v, "://") {
				chosen = "socks5://" + v
			} else {
				chosen = v
			}
		}
	} else {
		chosen = proxyServer
	}
	chosen = strings.TrimSpace(chosen)
	if chosen == "" {
		return nil, nil
	}
	if !strings.Contains(chosen, "://") {
		chosen = "http://" + chosen
	}
	parsed, err := url.Parse(chosen)
	if err != nil || parsed.Host == "" {
		return nil, nil
	}
	return parsed, nil
}

// matchProxyOverride checks whether host matches a semicolon-separated Windows
// ProxyOverride / macOS ExceptionsList / NO_PROXY list (supporting wildcards
// like *.local, 127.*, <local>, leading-dot domains, and standard or shorthand CIDRs).
func matchProxyOverride(override, host string) bool {
	host = strings.ToLower(strings.TrimSpace(strings.Trim(host, "[]")))
	if host == "" {
		return false
	}
	hostIP := net.ParseIP(host)
	for _, raw := range strings.Split(override, ";") {
		pat := strings.ToLower(strings.TrimSpace(raw))
		if pat == "" {
			continue
		}
		if pat == "*" {
			return true
		}
		if pat == "<local>" {
			if !strings.Contains(host, ".") {
				return true
			}
			continue
		}
		// Strip optional scheme or :port from override pattern.
		if idx := strings.Index(pat, "://"); idx >= 0 {
			pat = pat[idx+3:]
		}
		if colon := strings.LastIndex(pat, ":"); colon > 0 && !strings.Contains(pat, "]") && !strings.Contains(pat, "/") {
			pat = pat[:colon]
		}
		if strings.Contains(pat, "/") && hostIP != nil {
			if matchCIDROverride(pat, hostIP) {
				return true
			}
			continue
		}
		if pat == host {
			return true
		}
		if strings.HasPrefix(pat, ".") && (host == pat[1:] || strings.HasSuffix(host, pat)) {
			return true
		}
		if strings.ContainsAny(pat, "*?") {
			if ok, _ := path.Match(pat, host); ok {
				return true
			}
			// "*.example.com" should also match "a.b.example.com".
			if strings.HasPrefix(pat, "*.") && strings.HasSuffix(host, pat[1:]) {
				return true
			}
		}
	}
	return false
}

// matchCIDROverride matches both full CIDRs ("192.168.0.0/16") and macOS
// scutil shorthand IPv4 CIDRs ("169.254/16", "10/8").
func matchCIDROverride(pat string, ip net.IP) bool {
	if _, ipnet, err := net.ParseCIDR(pat); err == nil {
		return ipnet.Contains(ip)
	}
	prefix, mask, ok := strings.Cut(pat, "/")
	if !ok || strings.Contains(prefix, ":") {
		return false
	}
	octets := strings.Split(prefix, ".")
	if len(octets) == 0 || len(octets) >= 4 {
		return false
	}
	for len(octets) < 4 {
		octets = append(octets, "0")
	}
	if _, ipnet, err := net.ParseCIDR(strings.Join(octets, ".") + "/" + mask); err == nil {
		return ipnet.Contains(ip)
	}
	return false
}

// parseMacSCUtilProxy parses output of `scutil --proxy` on macOS.
func parseMacSCUtilProxy(raw string, u *url.URL) *url.URL {
	if u == nil || isLoopbackHost(u.Hostname()) {
		return nil
	}
	kv := map[string]string{}
	var exceptions []string
	inExceptions := false
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "ExceptionsList") {
			inExceptions = true
			continue
		}
		if inExceptions {
			if trimmed == "}" {
				inExceptions = false
				continue
			}
			if _, val, ok := strings.Cut(trimmed, ":"); ok {
				if v := strings.TrimSpace(val); v != "" {
					exceptions = append(exceptions, v)
				}
			}
			continue
		}
		if k, v, ok := strings.Cut(trimmed, ":"); ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	if len(exceptions) > 0 && matchProxyOverride(strings.Join(exceptions, ";"), u.Hostname()) {
		return nil
	}
	targetScheme := strings.ToLower(strings.TrimSpace(u.Scheme))
	build := func(scheme, host, port string) *url.URL {
		if host == "" {
			return nil
		}
		addr := host
		if port != "" && port != "0" {
			addr = net.JoinHostPort(host, port)
		}
		parsed, err := url.Parse(scheme + "://" + addr)
		if err != nil {
			return nil
		}
		return parsed
	}
	if targetScheme == "https" && kv["HTTPSEnable"] == "1" {
		if pu := build("http", kv["HTTPSProxy"], kv["HTTPSPort"]); pu != nil {
			return pu
		}
	}
	if kv["HTTPEnable"] == "1" {
		if pu := build("http", kv["HTTPProxy"], kv["HTTPPort"]); pu != nil {
			return pu
		}
	}
	if kv["SOCKSEnable"] == "1" {
		if pu := build("socks5", kv["SOCKSProxy"], kv["SOCKSPort"]); pu != nil {
			return pu
		}
	}
	return nil
}
