package telemetry

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSanitizeErrorTextAndStack(t *testing.T) {
	raw := `Get https://handraw-style.com/api/me?token=secret123: open C:\Users\Alice\handraw\settings.json failed; Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload123456.sig123456; contact alice@example.com 13800138000 hwc_abcdef1234567890 sk-testkey12345678`
	got := SanitizeErrorText(raw)
	for _, forbidden := range []string{"Alice", "secret123", "eyJhbGciOiJIUzI1NiJ9", "alice@example.com", "13800138000", "hwc_abcdef1234567890", "sk-testkey12345678"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("SanitizeErrorText leaked %q in %q", forbidden, got)
		}
	}
	if !strings.Contains(got, `C:\Users\<USER>\`) || !strings.Contains(got, "<EMAIL>") || !strings.Contains(got, "<PHONE>") {
		t.Fatalf("expected redaction placeholders, got %q", got)
	}

	stack := "goroutine 1 [running]:\n" +
		"github.com/yang0/handraw-client/internal/server.(*Server).h.func1()\n" +
		"\tE:/projectHome/handraw-client/internal/server/server.go:350 +0x123\n" +
		"net/http.HandlerFunc.ServeHTTP(...)\n" +
		"\t/Users/bob/sdk/go/src/net/http/server.go:2220\n"
	sanStack := SanitizeStack(stack)
	if strings.Contains(sanStack, "bob") || strings.Contains(sanStack, "E:/projectHome/") {
		t.Fatalf("SanitizeStack leaked local path: %q", sanStack)
	}
	if !strings.Contains(sanStack, "handraw-client/internal/server/server.go:350") {
		t.Fatalf("SanitizeStack lost project frame: %q", sanStack)
	}
}

func TestReportErrorDedupRateLimitAndCrashReplay(t *testing.T) {
	c := New("0.6.7")
	c.Enabled = func() bool { return true }
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	c.Now = func() time.Time { return now }

	// Same error twice within 10m -> second suppressed.
	ok1 := c.ReportError(ErrorReport{
		Category: "api_5xx",
		Source:   "frontend",
		Route:    "POST /api/account/login",
		Status:   500,
		Message:  "dial tcp 1.2.3.4:443: wsarecv forcibly closed",
	})
	ok2 := c.ReportError(ErrorReport{
		Category: "api_5xx",
		Source:   "frontend",
		Route:    "POST /api/account/login",
		Status:   500,
		Message:  "dial tcp 1.2.3.4:443: wsarecv forcibly closed",
	})
	if !ok1 || ok2 {
		t.Fatalf("expected 1st accepted and 2nd deduplicated, got ok1=%v ok2=%v", ok1, ok2)
	}

	// After 11 minutes -> accepted again with count=2 (1 suppressed + 1 current).
	now = now.Add(11 * time.Minute)
	ok3 := c.ReportError(ErrorReport{
		Category: "api_5xx",
		Source:   "frontend",
		Route:    "POST /api/account/login",
		Status:   500,
		Message:  "dial tcp 1.2.3.4:443: wsarecv forcibly closed",
	})
	if !ok3 {
		t.Fatalf("expected error after dedup window to be accepted")
	}
	c.mu.Lock()
	if len(c.queue) != 2 || c.queue[1].Props["count"] != 2 {
		t.Fatalf("expected count=2 on second send after 1 suppressed, got queue=%+v", c.queue)
	}
	c.mu.Unlock()

	// Previous crash log replay reports once and removes the file.
	crashFile := filepath.Join(t.TempDir(), "crash-last.log")
	crashDump := "panic: runtime error: invalid memory address or nil pointer dereference\n\ngoroutine 9 [running]:\nE:/projectHome/handraw-client/internal/updater/auto.go:99\n"
	if err := os.WriteFile(crashFile, []byte(crashDump), 0o600); err != nil {
		t.Fatal(err)
	}
	if !c.ReportPreviousCrash(crashFile) {
		t.Fatalf("expected previous crash log to be reported")
	}
	if _, err := os.Stat(crashFile); !os.IsNotExist(err) {
		t.Fatalf("expected crash file removed after reporting, stat err=%v", err)
	}
	c.mu.Lock()
	last := c.queue[len(c.queue)-1]
	c.mu.Unlock()
	if last.Event != "client_crash" || last.Props["category"] != "go_crash" {
		t.Fatalf("unexpected crash event: %+v", last)
	}

	// Disabled telemetry -> zero reports.
	c.Enabled = func() bool { return false }
	if c.ReportError(ErrorReport{Category: "js_error", Message: "boom"}) {
		t.Fatalf("disabled telemetry must drop errors")
	}
}

func TestSanitizeNonUsersPathsAndGroupIdenticalUpdaterErrors(t *testing.T) {
	msgA := `替换程序失败：rename D:\download\handraw-windows-amd64.exe D:\download\handraw-windows-amd64.exe.old: Access is denied.`
	msgB := `替换程序失败：rename C:\Users\Alice\Downloads\handraw-windows-amd64 (1).exe C:\Users\Alice\Downloads\handraw-windows-amd64 (1).exe.old: Access is denied.`

	sanA := SanitizeErrorText(msgA)
	if strings.Contains(sanA, `D:\download\`) {
		t.Fatalf("expected non-Users drive folder redacted, got %q", sanA)
	}
	if !strings.Contains(sanA, `<WIN_PATH>\handraw-windows-amd64.exe`) {
		t.Fatalf("expected filename preserved with <WIN_PATH>, got %q", sanA)
	}

	sanB := SanitizeErrorText(msgB)
	if strings.Contains(sanB, "Alice") {
		t.Fatalf("expected Windows username redacted, got %q", sanB)
	}

	fpA := errorFingerprint(ErrorReport{Category: "updater_apply", Source: "backend", Message: msgA})
	fpB := errorFingerprint(ErrorReport{Category: "updater_apply", Source: "backend", Message: msgB})
	if fpA != fpB {
		t.Fatalf("expected identical fingerprint across different install paths, got %q vs %q", fpA, fpB)
	}
}

func TestTieredErrorRateLimitsAndDomainSanitization(t *testing.T) {
	c := New("0.6.12")
	c.Enabled = func() bool { return true }
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	c.Now = func() time.Time { return now }

	// SanitizeDomain strips scheme, userinfo, port, path, query.
	if got := SanitizeDomain("https://user:pass@PBS.TWIMG.COM:443/media/abc.jpg?name=large"); got != "pbs.twimg.com" {
		t.Fatalf("SanitizeDomain got %q, want pbs.twimg.com", got)
	}
	if got := SanitizeDomain("http://127.0.0.1:18520/files/local?p=C:/secret"); got != "localhost" {
		t.Fatalf("SanitizeDomain loopback got %q, want localhost", got)
	}

	// Saturate the warn tier (10/hour) with 12 distinct media_broken reports.
	warnAccepted := 0
	for i := 0; i < 12; i++ {
		if c.ReportError(ErrorReport{
			Category: "media_broken",
			Source:   "frontend",
			Route:    "external_media",
			Domain:   "cdn.example.com",
			Message:  "img load failed #" + string(rune('a'+i)),
		}) {
			warnAccepted++
		}
	}
	if warnAccepted != maxWarnErrorsPerHour {
		t.Fatalf("expected warn tier capped at %d, got %d", maxWarnErrorsPerHour, warnAccepted)
	}

	// Warn saturation MUST NOT block error or critical tier reports (#194).
	if !c.ReportError(ErrorReport{Category: "api_5xx", Source: "frontend", Route: "POST /api/generate", Status: 500, Message: "boom"}) {
		t.Fatalf("error tier was starved by warn tier")
	}
	if !c.ReportError(ErrorReport{Category: "http_panic", Source: "backend", Route: "GET /api/works", Status: 500, Message: "nil pointer"}) {
		t.Fatalf("critical tier was starved by warn tier")
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	last := c.queue[len(c.queue)-1]
	if last.Props["severity"] != "critical" {
		t.Fatalf("expected critical severity on http_panic, got %+v", last.Props)
	}
}
