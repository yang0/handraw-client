package desktop

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// AutoStartArg is passed to the executable when launched by OS login items
	// so the app can start quietly in the system tray (#183).
	AutoStartArg = "--autostart"
	// AutoStartRegistryValue is the HKCU\...\Run value name on Windows.
	AutoStartRegistryValue = "HandrawClient"
	// AutoStartMacLabel is the LaunchAgent label on macOS.
	AutoStartMacLabel = "com.handraw.client"
)

// SetAutoStart registers or removes the current executable as an OS login item
// for the current user (no admin privileges required). Temporary executables
// (such as `go run` or `go test`) are skipped when enabling so dev runs never
// pollute the user's real OS startup entries (#183).
func SetAutoStart(enabled bool) error {
	if !enabled {
		return setAutoStartOS(false, "")
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("无法获取程序路径：%w", err)
	}
	if resolved, rErr := filepath.EvalSymlinks(exe); rErr == nil && resolved != "" {
		exe = resolved
	}
	if abs, aErr := filepath.Abs(exe); aErr == nil && abs != "" {
		exe = abs
	}
	if isTempExecutable(exe) {
		return nil
	}
	return setAutoStartOS(true, exe)
}

func isTempExecutable(exe string) bool {
	clean := strings.ToLower(filepath.Clean(strings.TrimSpace(exe)))
	if clean == "" {
		return true
	}
	base := filepath.Base(clean)
	if strings.HasSuffix(base, ".test") || strings.HasSuffix(base, ".test.exe") {
		return true
	}
	if strings.Contains(clean, string(os.PathSeparator)+"go-build") {
		return true
	}
	tmp := strings.ToLower(filepath.Clean(os.TempDir()))
	if tmp != "" && (clean == tmp || strings.HasPrefix(clean, tmp+string(os.PathSeparator))) {
		return true
	}
	return false
}

func formatWindowsRunCommand(exePath string) string {
	return fmt.Sprintf(`"%s" %s`, strings.TrimSpace(exePath), AutoStartArg)
}

func xmlEscapeText(s string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(s))
	return buf.String()
}

func renderMacLaunchAgentPlist(exePath string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`, AutoStartMacLabel, xmlEscapeText(strings.TrimSpace(exePath)), AutoStartArg)
}

func renderLinuxDesktopEntry(exePath string) string {
	quoted := strings.ReplaceAll(strings.TrimSpace(exePath), `"`, `\"`)
	return fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=手绘风生图工作台
Comment=本地优先的手绘风格创作台
Exec="%s" %s
Terminal=false
X-GNOME-Autostart-enabled=true
`, quoted, AutoStartArg)
}
