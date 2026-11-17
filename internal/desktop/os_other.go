//go:build !windows

package desktop

import "os/exec"

func windowsExplorer() string { return "" }

func prepareWindowsExplorerCmd(_ *exec.Cmd, _ string, _ bool) {}
