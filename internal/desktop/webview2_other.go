//go:build !windows && !nogui

package desktop

import "github.com/wailsapp/wails/v3/pkg/application"

func checkWebView2(*application.App) bool { return true }
