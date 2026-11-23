//go:build !windows

package dshbridge

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
