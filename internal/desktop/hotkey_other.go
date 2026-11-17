//go:build !windows && !nogui

package desktop

type hotkeyManager struct{}

func newHotkeyManager(func()) *hotkeyManager { return &hotkeyManager{} }
func (*hotkeyManager) Set(string) error     { return nil }
func (*hotkeyManager) Stop()                {}
