package desktop

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/yang0/handraw-client/internal/server"
)

// OpenBrowser opens an http/https URL in the user's default web browser.
func OpenBrowser(rawURL string) error {
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://") {
		return fmt.Errorf("不支持的链接协议")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// rundll32 avoids cmd.exe metacharacter parsing while launching default browser.
		sysRoot := os.Getenv("SystemRoot")
		if sysRoot == "" {
			sysRoot = `C:\Windows`
		}
		cmd = exec.Command(filepath.Join(sysRoot, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", rawURL)
	case "darwin":
		cmd = exec.Command("open", rawURL)
	default:
		cmd = exec.Command("xdg-open", rawURL)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// OpenFolder opens a folder (or highlights a file on Windows/macOS) without blocking the UI thread.
func OpenFolder(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command(windowsExplorer())
		prepareWindowsExplorerCmd(cmd, path, st.IsDir())
	case "darwin":
		if st.IsDir() {
			cmd = exec.Command("open", path)
		} else {
			cmd = exec.Command("open", "-R", path)
		}
	default:
		target := path
		if !st.IsDir() {
			target = filepath.Dir(path)
		}
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// CopyImageFile puts an image file onto the OS clipboard so the user can paste into WeChat / Docs.
func CopyImageFile(path string) error {
	if _, err := os.Stat(path); err != nil {
		return err
	}
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command",
			`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile($env:HANDRAW_CLIP_PATH); try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }`)
		cmd.Env = append(os.Environ(), "HANDRAW_CLIP_PATH="+path)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("复制图片失败：%w (%s)", err, strings.TrimSpace(string(out)))
		}
		return nil
	case "darwin":
		cmd := exec.Command("osascript", "-e", `on run argv`, "-e", `set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)`, "-e", `end run`, path)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("复制图片失败：%w (%s)", err, strings.TrimSpace(string(out)))
		}
		return nil
	default:
		return fmt.Errorf("当前系统不支持命令行复制图片")
	}
}

// CopyTextOS writes plain UTF-8 text to the OS clipboard.
func CopyTextOS(text string) error {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command",
			`[System.Windows.Forms.Clipboard]::SetText($env:HANDRAW_CLIP_TEXT)`)
		cmd.Env = append(os.Environ(), "HANDRAW_CLIP_TEXT="+text)
		return cmd.Run()
	case "darwin":
		cmd := exec.Command("pbcopy")
		cmd.Stdin = strings.NewReader(text)
		return cmd.Run()
	default:
		cmd := exec.Command("xclip", "-selection", "clipboard")
		cmd.Stdin = strings.NewReader(text)
		return cmd.Run()
	}
}

// PickDirectoryOS opens a native OS folder selection dialog and returns the
// chosen directory path (or empty string if canceled).
func PickDirectoryOS() (string, error) {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command",
			`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择文件夹'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`)
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("打开目录选择器失败：%w", err)
		}
		return strings.TrimSpace(string(out)), nil
	case "darwin":
		cmd := exec.Command("osascript", "-e", `POSIX path of (choose folder with prompt "选择文件夹")`)
		out, err := cmd.Output()
		if err != nil {
			return "", nil
		}
		return strings.TrimRight(strings.TrimSpace(string(out)), "/"), nil
	default:
		return "", fmt.Errorf("当前系统不支持原生目录选择器")
	}
}

type webHost struct{}

// WebHost returns a server.Host backed by OS tools for `handraw web` debug mode.
func WebHost() server.Host { return webHost{} }

func (webHost) OpenURL(url string) error     { return OpenBrowser(url) }
func (webHost) OpenPath(path string) error   { return OpenFolder(path) }
func (webHost) CopyImage(path string) error  { return CopyImageFile(path) }
func (webHost) CopyText(text string) error   { return CopyTextOS(text) }
func (webHost) PickDirectory() (string, error) { return PickDirectoryOS() }
func (webHost) ShowMain()                    {}
func (webHost) HideQuick()                   {}
func (webHost) Restart()                     {}
func (webHost) SetHotkey(string) error       { return nil }
