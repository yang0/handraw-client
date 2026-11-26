package server

// Local-origin guards for the loopback API (#171).
//
// The API only ever serves the desktop window (127.0.0.1 / localhost /
// wails.localhost). Checks compare parsed host names exactly: a prefix test
// such as strings.HasPrefix(origin, "http://127.0.0.1") also accepts
// "http://127.0.0.1.attacker.example", which a DNS-rebinding page controls.

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// isLocalHostName reports whether h (no port) names this machine's loopback UI.
func isLocalHostName(h string) bool {
	h = strings.ToLower(strings.TrimSuffix(strings.Trim(h, "[]"), "."))
	switch h {
	case "127.0.0.1", "localhost", "wails.localhost", "::1":
		return true
	}
	return false
}

// isLocalHostHeader validates the Host header. Requests whose Host is a
// foreign name (DNS rebinding) are rejected before any handler runs.
func isLocalHostHeader(host string) bool {
	if host == "" {
		return true // HTTP/1.0 or in-process callers
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return isLocalHostName(host)
}

// isLocalOrigin reports whether an Origin header belongs to the desktop UI.
func isLocalOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "wails":
		return true // custom scheme only the app's own webview can use
	case "http", "https":
		return isLocalHostName(u.Hostname())
	}
	return false
}

// isClipOrigin additionally admits the paired browser extension.
func isClipOrigin(origin string) bool {
	if u, err := url.Parse(origin); err == nil && strings.EqualFold(u.Scheme, "chrome-extension") && u.Host != "" {
		return true
	}
	return isLocalOrigin(origin)
}

// isStateChanging reports whether the method can change server state.
func isStateChanging(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	return true
}
