//go:build windows && !nogui

package desktop

import (
	"fmt"
	"log"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

var procMessageBoxW = user32.NewProc("MessageBoxW")

const webView2URL = "https://developer.microsoft.com/microsoft-edge/webview2/"

func checkWebView2(app *application.App) bool {
	info := app.Env.Info().PlatformInfo
	if v, ok := info["WebView2"]; ok && fmt.Sprint(v) == "" {
		log.Println("handraw: Microsoft Edge WebView2 Runtime missing; use 'handraw web' or install from", webView2URL)
		title := windows.StringToUTF16Ptr("手绘风工作台需要 WebView2")
		body := windows.StringToUTF16Ptr(
			"当前电脑未安装 Microsoft Edge WebView2 运行时，无法打开桌面窗口。\r\n\r\n" +
				"可运行 winget install Microsoft.EdgeWebView2Runtime 安装，或临时使用 \"handraw web\" 在浏览器中打开。\r\n\r\n" +
				"现在打开官方下载页面吗？",
		)
		const (
			mbYesNo         = 0x00000004
			mbIconError     = 0x00000010
			mbSetForeground = 0x00010000
			idYes           = 6
		)
		r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), mbYesNo|mbIconError|mbSetForeground)
		if int(r) == idYes {
			_ = OpenBrowser(webView2URL)
		}
		return false
	}
	return true
}
