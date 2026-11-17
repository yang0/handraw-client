//go:build windows && !nogui

package desktop

import (
	"sync"
	"testing"
	"time"
)

func TestHotkeyLifecycle(t *testing.T) {
	triggered := make(chan struct{}, 1)
	m := newHotkeyManager(func() { triggered <- struct{}{} })
	t.Cleanup(m.Stop)

	const spec = "Ctrl+Alt+Shift+F10"
	if err := m.Set(spec); err != nil {
		t.Fatal(err)
	}
	if m.tid == 0 {
		t.Fatal("registered hotkey has no message thread")
	}
	if ok, _, err := procPostThreadMessageW.Call(uintptr(m.tid), wmHotKey, 1, 0); ok == 0 {
		t.Fatal(err)
	}
	select {
	case <-triggered:
	case <-time.After(2 * time.Second):
		t.Fatal("hotkey message did not reach callback")
	}

	other := newHotkeyManager(nil)
	t.Cleanup(other.Stop)
	if err := other.Set(spec); err == nil {
		t.Fatal("duplicate hotkey registration unexpectedly succeeded")
	}
	// Replacing a shortcut must release the old registration before returning.
	if err := m.Set("Ctrl+Alt+Shift+F9"); err != nil {
		t.Fatal(err)
	}
	if err := other.Set(spec); err != nil {
		t.Fatalf("failed registration did not recover: %v", err)
	}
	if err := m.Set(""); err != nil {
		t.Fatal(err)
	}
	if m.tid != 0 || m.done != nil {
		t.Fatal("clearing hotkey left a running message thread")
	}
	m.Stop()
	m.Stop()
}

func TestHotkeyImmediateStopAndConcurrentSet(t *testing.T) {
	m := newHotkeyManager(nil)
	t.Cleanup(m.Stop)
	// Stop can run as soon as Set returns, before GetMessage starts waiting.
	for range 20 {
		if err := m.Set("Ctrl+Alt+Shift+F8"); err != nil {
			t.Fatal(err)
		}
		m.Stop()
	}

	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if err := m.Set("Ctrl+Alt+Shift+F8"); err != nil {
				t.Error(err)
			}
			m.Stop()
		})
	}
	wg.Wait()
}
