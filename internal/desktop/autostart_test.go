package desktop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAutoStartFormattersAndTempGuard(t *testing.T) {
	winCmd := formatWindowsRunCommand(`C:\Program Files\Handraw\handraw.exe`)
	wantWin := `"C:\Program Files\Handraw\handraw.exe" --autostart`
	if winCmd != wantWin {
		t.Fatalf("formatWindowsRunCommand = %q, want %q", winCmd, wantWin)
	}

	plist := renderMacLaunchAgentPlist(`/Applications/手绘风 & Co.app/Contents/MacOS/handraw`)
	if !strings.Contains(plist, "<string>com.handraw.client</string>") ||
		!strings.Contains(plist, "<string>/Applications/手绘风 &amp; Co.app/Contents/MacOS/handraw</string>") ||
		!strings.Contains(plist, "<string>--autostart</string>") ||
		!strings.Contains(plist, "<key>RunAtLoad</key>") {
		t.Fatalf("unexpected macOS plist:\n%s", plist)
	}

	desktopFile := renderLinuxDesktopEntry(`/opt/handraw/handraw`)
	if !strings.Contains(desktopFile, `Exec="/opt/handraw/handraw" --autostart`) {
		t.Fatalf("unexpected linux desktop entry:\n%s", desktopFile)
	}

	// Dev / test temporary executables must be detected so go run/test never pollute OS startup.
	tmpExe := filepath.Join(os.TempDir(), "go-build12345", "handraw.exe")
	if !isTempExecutable(tmpExe) {
		t.Fatalf("expected temp go-build executable %q to be treated as temporary", tmpExe)
	}
	if !isTempExecutable(`/Users/dev/desktop.test`) {
		t.Fatalf("expected .test binary to be treated as temporary")
	}
	if isTempExecutable(`C:\Users\alice\AppData\Local\Handraw\handraw.exe`) {
		t.Fatalf("normal installed executable should not be treated as temporary")
	}
}
