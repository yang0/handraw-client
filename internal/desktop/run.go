//go:build !nogui

package desktop

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/server"
	"github.com/yang0/handraw-client/internal/settings"
)

//go:embed icon.png
var appIcon []byte

//go:embed tray.png
var trayIcon []byte

type desktopHost struct {
	app       *application.App
	srv       *server.Server
	main      *application.WebviewWindow
	quick     *application.WebviewWindow
	tray      *application.SystemTray
	hotkeys   *hotkeyManager
	quitting  atomic.Bool
	ready     chan struct{}
	readyOnce sync.Once
}

func (h *desktopHost) whenReady(fn func()) {
	go func() {
		<-h.ready
		fn()
	}()
}

func (h *desktopHost) OpenURL(url string) error {
	if err := h.app.Browser.OpenURL(url); err == nil {
		return nil
	}
	return OpenBrowser(url)
}

func (h *desktopHost) OpenPath(path string) error  { return OpenFolder(path) }
func (h *desktopHost) CopyImage(path string) error { return CopyImageFile(path) }
func (h *desktopHost) PickDirectory() (string, error) {
	if h.app != nil {
		res, err := h.app.Dialog.OpenFile().
			CanChooseDirectories(true).
			CanChooseFiles(false).
			CanCreateDirectories(true).
			SetTitle("选择文件夹").
			PromptForSingleSelection()
		if err == nil {
			return strings.TrimSpace(res), nil
		}
		// Do not re-open a second fallback dialog if the user simply canceled.
		if strings.Contains(strings.ToLower(err.Error()), "cancel") {
			return "", nil
		}
	}
	return PickDirectoryOS()
}
func (h *desktopHost) CopyText(text string) error {
	if application.InvokeSyncWithResult(func() bool { return h.app.Clipboard.SetText(text) }) {
		return nil
	}
	return CopyTextOS(text)
}

func (h *desktopHost) ShowMain() {
	h.whenReady(func() {
		application.InvokeSync(func() {
			if h.main == nil {
				return
			}
			h.main.UnMinimise()
			h.main.Show()
			h.main.Focus()
		})
	})
}

func (h *desktopHost) HideQuick() {
	application.InvokeSync(func() {
		if h.quick != nil {
			h.quick.Hide()
		}
	})
}

func (h *desktopHost) ToggleQuick() {
	h.whenReady(func() {
		application.InvokeSync(func() {
			if h.quick == nil {
				return
			}
			if h.quick.IsVisible() {
				h.quick.Hide()
				return
			}
			h.quick.Center()
			h.quick.Show()
			h.quick.Focus()
		})
	})
}

func (h *desktopHost) SetHotkey(spec string) error {
	if h.hotkeys == nil {
		return nil
	}
	return h.hotkeys.Set(spec)
}

func (h *desktopHost) SetAutoStart(enabled bool) error {
	return SetAutoStart(enabled)
}

func (h *desktopHost) Restart() {
	exe, err := os.Executable()
	if err == nil {
		cmd := exec.Command(exe)
		_ = cmd.Start()
	}
	h.quitting.Store(true)
	if h.app != nil {
		h.app.Quit()
	}
}

// Run starts the Wails v3 desktop application backed by the local API server.
func Run(version string, srv *server.Server, addr string, showMain bool, deepLink string) error {
	go func() {
		if err := registerScheme(); err != nil {
			log.Println("handraw:// register:", err)
		}
	}()

	h := &desktopHost{
		srv:   srv,
		ready: make(chan struct{}),
	}
	h.hotkeys = newHotkeyManager(h.ToggleQuick)
	srv.Host = h

	var singleInst *application.SingleInstanceOptions
	if runtime.GOOS != "darwin" {
		sum := sha256.Sum256([]byte(appdir.Root()))
		singleInst = &application.SingleInstanceOptions{
			UniqueID: "com.handrawstyle.client." + hex.EncodeToString(sum[:6]),
			OnSecondInstanceLaunch: func(d application.SecondInstanceData) {
				for _, arg := range d.Args[min(1, len(d.Args)):] {
					if strings.HasPrefix(strings.ToLower(arg), "handraw://") {
						srv.HandleDeepLink(arg)
						return
					}
				}
				h.ShowMain()
			},
		}
	}

	h.app = application.New(application.Options{
		Name:        "手绘风生图工作台",
		Description: "本地优先的手绘风格创作台 " + version,
		Icon:        appIcon,
		Assets:      application.AssetOptions{Handler: srv.Handler()},
		SingleInstance: singleInst,
		Mac: application.MacOptions{
			ActivationPolicy: application.ActivationPolicyRegular,
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			WebviewUserDataPath:           filepath.Join(appdir.Root(), "webview2"),
		},
		Linux: application.LinuxOptions{
			DisableQuitOnLastWindowClosed: true,
			ProgramName:                   "handraw",
		},
		OnShutdown: func() {
			h.quitting.Store(true)
			h.hotkeys.Stop()
		},
		ErrorHandler: func(err error) { log.Println("handraw:", err) },
	})

	if !checkWebView2(h.app) {
		return nil
	}

	h.app.Event.RegisterApplicationEventHook(events.Mac.ApplicationShouldHandleReopen, func(e *application.ApplicationEvent) {
		h.ShowMain()
		e.Cancel()
	})

	h.main = h.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "手绘风生图工作台",
		URL:              addr + "/",
		Width:            1280,
		Height:           840,
		MinWidth:         900,
		MinHeight:        600,
		Hidden:           true,
		BackgroundColour: application.NewRGBA(246, 243, 236, 255),
	})

	h.main.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if h.quitting.Load() || !settings.Get().MinimizeToTray {
			return
		}
		h.main.Hide()
		e.Cancel()
	})

	qOpts := application.WebviewWindowOptions{
		Name:            "quick",
		Title:           "手绘风 · 快门",
		URL:             addr + "/quick.html",
		Width:           580,
		Height:          280,
		Hidden:          true,
		Frameless:       true,
		AlwaysOnTop:     true,
		DisableResize:   true,
		HideOnEscape:    true,
		HideOnFocusLost: true,
		Windows:         application.WindowsWindow{HiddenOnTaskbar: true},
		Mac: application.MacWindow{
			Backdrop:     application.MacBackdropTranslucent,
			CornerRadius: 12,
			CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces |
				application.MacWindowCollectionBehaviorFullScreenAuxiliary,
			WindowClass:      application.MacWindowClassPanel,
			PanelPreferences: application.MacPanelPreferences{NonActivating: true},
		},
	}
	if runtime.GOOS == "windows" {
		qOpts.MinimiseButtonState = application.ButtonHidden
		qOpts.MaximiseButtonState = application.ButtonHidden
		qOpts.CloseButtonState = application.ButtonHidden
	}
	h.quick = h.app.Window.NewWithOptions(qOpts)

	menu := h.app.NewMenu()
	menu.Add("打开主工作台").OnClick(func(*application.Context) { h.ShowMain() })
	menu.Add("唤起快门窗").OnClick(func(*application.Context) { h.ToggleQuick() })
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(*application.Context) {
		h.quitting.Store(true)
		h.app.Quit()
	})

	h.tray = h.app.SystemTray.New()
	h.tray.SetTooltip("手绘风生图工作台")
	h.tray.SetIcon(trayIcon)
	h.tray.SetMenu(menu)
	h.tray.OnClick(func() { h.ShowMain() })

	markReady := func() { h.readyOnce.Do(func() { close(h.ready) }) }
	if runtime.GOOS == "windows" {
		h.main.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) { markReady() })
		if !showMain {
			h.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) { markReady() })
		}
	} else {
		h.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) { markReady() })
	}

	if st := settings.Get(); st.QuickShotEnabled && st.QuickShotHotkey != "" {
		if err := h.SetHotkey(st.QuickShotHotkey); err != nil {
			log.Println("handraw hotkey:", err)
		}
	}

	if showMain {
		h.ShowMain()
	}
	if deepLink != "" {
		h.whenReady(func() { srv.HandleDeepLink(deepLink) })
	}
	h.app.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(e *application.ApplicationEvent) {
		u := e.Context().URL()
		if strings.HasPrefix(strings.ToLower(u), "handraw://") {
			srv.HandleDeepLink(u)
		}
	})

	return h.app.Run()
}
