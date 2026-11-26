//go:build darwin

package netutil

import (
	"context"
	"net/url"
	"os/exec"
	"sync"
	"time"
)

var macProxyCache struct {
	mu  sync.Mutex
	at  time.Time
	raw string
}

func osSystemProxy(u *url.URL) (*url.URL, error) {
	macProxyCache.mu.Lock()
	if time.Since(macProxyCache.at) < 10*time.Second {
		raw := macProxyCache.raw
		macProxyCache.mu.Unlock()
		return parseMacSCUtilProxy(raw, u), nil
	}
	macProxyCache.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "scutil", "--proxy").Output()
	raw := ""
	if err == nil {
		raw = string(out)
	}

	macProxyCache.mu.Lock()
	macProxyCache.at = time.Now()
	macProxyCache.raw = raw
	macProxyCache.mu.Unlock()
	return parseMacSCUtilProxy(raw, u), nil
}
