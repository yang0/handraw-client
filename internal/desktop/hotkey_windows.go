//go:build windows && !nogui

package desktop

import (
	"fmt"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procRegisterHotKey      = user32.NewProc("RegisterHotKey")
	procUnregisterHotKey    = user32.NewProc("UnregisterHotKey")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procPostThreadMessageW  = user32.NewProc("PostThreadMessageW")
)

const (
	modAlt     = 0x0001
	modControl = 0x0002
	modShift   = 0x0004
	modWin     = 0x0008
	modNoRep   = 0x4000
	wmHotKey   = 0x0312
	wmQuit     = 0x0012
)

type winMSG struct {
	HWND    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

type hotkeyManager struct {
	mu      sync.Mutex
	tid     uint32
	done    chan struct{}
	trigger func()
}

func newHotkeyManager(trigger func()) *hotkeyManager {
	return &hotkeyManager{trigger: trigger}
}

func (m *hotkeyManager) Set(spec string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()

	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil
	}
	mods, vk, err := parseHotkeySpec(spec)
	if err != nil {
		return err
	}

	ready := make(chan error, 1)
	done := make(chan struct{})
	m.done = done

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(done)

		tid := windows.GetCurrentThreadId()
		r1, _, callErr := procRegisterHotKey.Call(0, 1, uintptr(mods|modNoRep), uintptr(vk))
		if r1 == 0 {
			ready <- fmt.Errorf("注册快捷键 %s 失败：%w", spec, callErr)
			return
		}
		m.mu.Lock()
		m.tid = tid
		m.mu.Unlock()
		ready <- nil

		defer procUnregisterHotKey.Call(0, 1)

		var msg winMSG
		for {
			ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if int32(ret) <= 0 {
				break
			}
			if msg.Message == wmHotKey && m.trigger != nil {
				go m.trigger()
			}
		}
	}()

	return <-ready
}

func (m *hotkeyManager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
}

func (m *hotkeyManager) stopLocked() {
	if m.tid != 0 {
		_, _, _ = procPostThreadMessageW.Call(uintptr(m.tid), wmQuit, 0, 0)
		m.tid = 0
	}
	if m.done != nil {
		<-m.done
		m.done = nil
	}
}

func parseHotkeySpec(spec string) (uint32, uint32, error) {
	var mods uint32
	var vk uint32
	for _, raw := range strings.Split(spec, "+") {
		p := strings.TrimSpace(strings.ToUpper(raw))
		switch p {
		case "ALT":
			mods |= modAlt
		case "CTRL", "CONTROL":
			mods |= modControl
		case "SHIFT":
			mods |= modShift
		case "WIN", "META", "SUPER":
			mods |= modWin
		case "SPACE":
			vk = 0x20
		case "ENTER", "RETURN":
			vk = 0x0D
		case "TAB":
			vk = 0x09
		default:
			if len(p) == 1 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= '0' && p[0] <= '9')) {
				vk = uint32(p[0])
			} else if strings.HasPrefix(p, "F") && len(p) >= 2 && len(p) <= 3 {
				var fn int
				if _, err := fmt.Sscanf(p, "F%d", &fn); err == nil && fn >= 1 && fn <= 12 {
					vk = uint32(0x70 + fn - 1)
				}
			}
		}
	}
	if vk == 0 {
		return 0, 0, fmt.Errorf("无法识别快捷键：%s", spec)
	}
	return mods, vk, nil
}
