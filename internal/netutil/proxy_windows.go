//go:build windows

package netutil

import (
	"net/url"
	"sync"
	"time"

	"golang.org/x/sys/windows/registry"
)

var winProxyCache struct {
	mu       sync.Mutex
	at       time.Time
	enabled  bool
	server   string
	override string
}

func readWindowsSystemProxy() (enabled bool, server, override string) {
	winProxyCache.mu.Lock()
	if time.Since(winProxyCache.at) < 5*time.Second {
		en, srv, ov := winProxyCache.enabled, winProxyCache.server, winProxyCache.override
		winProxyCache.mu.Unlock()
		return en, srv, ov
	}
	winProxyCache.mu.Unlock()

	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		if v, _, err := k.GetIntegerValue("ProxyEnable"); err == nil && v == 1 {
			enabled = true
		}
		if v, _, err := k.GetStringValue("ProxyServer"); err == nil {
			server = v
		}
		if v, _, err := k.GetStringValue("ProxyOverride"); err == nil {
			override = v
		}
	}

	winProxyCache.mu.Lock()
	winProxyCache.at = time.Now()
	winProxyCache.enabled = enabled
	winProxyCache.server = server
	winProxyCache.override = override
	winProxyCache.mu.Unlock()
	return enabled, server, override
}

func osSystemProxy(u *url.URL) (*url.URL, error) {
	enabled, server, override := readWindowsSystemProxy()
	if !enabled || server == "" {
		return nil, nil
	}
	return parseWindowsProxy(server, override, u)
}
