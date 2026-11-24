//go:build !windows

package obsidian

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
