//go:build windows

package harnesses

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
)

var errBatchArg = errors.New("cmd.exe cannot run a batch file with quotes in path or control characters in arguments")

func configureCommand(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags = 0x08000000 // CREATE_NO_WINDOW
	configureBatchCommand(cmd)
}

// configureBatchCommand wraps .cmd / .bat shims (such as npm's claude.CMD,
// codex.CMD, gemini.CMD, qwen.CMD) with cmd.exe /d /e:ON /v:OFF /s /c and
// safe argument quoting (porting Magpie's proc/batch_windows.go).
func configureBatchCommand(cmd *exec.Cmd) {
	if cmd.Err != nil || cmd.Path == "" {
		return
	}
	switch strings.ToLower(filepath.Ext(cmd.Path)) {
	case ".cmd", ".bat":
	default:
		return
	}
	if strings.ContainsAny(cmd.Path, "\"\r\n") {
		cmd.Err = errBatchArg
		return
	}
	cmdLine, err := buildBatchCmdLine(cmd.Path, cmd.Args[1:])
	if err != nil {
		cmd.Err = err
		return
	}
	shell := comSpecPath()
	cmd.SysProcAttr.CmdLine = `"` + shell + `" ` + cmdLine
	cmd.Args = append([]string{shell, "/d", "/e:ON", "/v:OFF", "/s", "/c", cmd.Path}, cmd.Args[1:]...)
	cmd.Path = shell
}

func buildBatchCmdLine(batchPath string, args []string) (string, error) {
	var b strings.Builder
	b.WriteString(`/d /e:ON /v:OFF /s /c ""`)
	b.WriteString(batchPath)
	b.WriteByte('"')
	for _, a := range args {
		if strings.ContainsAny(a, "\r\n\x00") {
			return "", errBatchArg
		}
		b.WriteByte(' ')
		quoteBatchArg(&b, a)
	}
	b.WriteByte('"')
	return b.String(), nil
}

func quoteBatchArg(b *strings.Builder, a string) {
	quote := a == "" || strings.HasSuffix(a, `\`) || strings.IndexFunc(a, func(r rune) bool {
		if r < 0x80 {
			return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(`#$*+-./:?@\_`, r))
		}
		return unicode.IsControl(r)
	}) >= 0
	if quote {
		b.WriteByte('"')
	}
	backslashes := 0
	for _, r := range a {
		switch r {
		case '\\':
			backslashes++
			b.WriteRune(r)
			continue
		case '"':
			b.WriteString(strings.Repeat(`\`, backslashes))
			b.WriteByte('"')
		case '%':
			b.WriteString("%%cd:~,")
		}
		backslashes = 0
		b.WriteRune(r)
	}
	if quote {
		b.WriteString(strings.Repeat(`\`, backslashes))
		b.WriteByte('"')
	}
}

func comSpecPath() string {
	if c := os.Getenv("ComSpec"); filepath.IsAbs(c) && strings.EqualFold(filepath.Base(c), "cmd.exe") {
		return c
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "cmd.exe")
}
