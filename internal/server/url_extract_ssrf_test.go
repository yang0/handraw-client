package server

import (
	"context"
	"net"
	"testing"
)

// #179: safeExtractDialContext must reject loopback/private/link-local targets
// even if invoked directly with a hostname or IP (prevents DNS/rebinding SSRF).
func TestSafeExtractDialContextBlocksPrivateAndLoopback(t *testing.T) {
	orig := allowPrivateURLFetchForTest
	allowPrivateURLFetchForTest = false
	t.Cleanup(func() { allowPrivateURLFetchForTest = orig })

	for _, rawIP := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.5", "192.168.1.1", "169.254.169.254", "::1", "0.0.0.0"} {
		if !isBlockedIP(net.ParseIP(rawIP)) {
			t.Fatalf("expected %s to be blocked", rawIP)
		}
	}
	if isBlockedIP(net.ParseIP("93.184.216.34")) {
		t.Fatalf("public IP should not be blocked")
	}
	for _, addr := range []string{"127.0.0.1:80", "169.254.169.254:80", "localhost:8080"} {
		if _, err := safeExtractDialContext(context.Background(), "tcp", addr); err == nil {
			t.Fatalf("expected safeExtractDialContext(%q) to be blocked", addr)
		}
	}
}
