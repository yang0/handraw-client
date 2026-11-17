//go:build windows

package desktop

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func windowsExplorer() string {
	for _, k := range []string{"SystemRoot", "windir"} {
		if v := os.Getenv(k); v != "" {
			if p := filepath.Join(v, "explorer.exe"); fileExists(p) {
				return p
			}
		}
	}
	return `C:\Windows\explorer.exe`
}

func prepareWindowsExplorerCmd(cmd *exec.Cmd, path string, isDir bool) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	if isDir {
		cmd.SysProcAttr.CmdLine = fmt.Sprintf(`explorer.exe "%s"`, path)
	} else {
		cmd.SysProcAttr.CmdLine = fmt.Sprintf(`explorer.exe /select,"%s"`, path)
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
