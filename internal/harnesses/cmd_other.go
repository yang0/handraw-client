//go:build !windows

package harnesses

import "os/exec"

func configureCommand(cmd *exec.Cmd) {
	// No hidden console attribute needed on Unix/macOS.
}
