//go:build !windows

package plugins

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
