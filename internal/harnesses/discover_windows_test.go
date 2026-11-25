//go:build windows

package harnesses

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildBatchCmdLineQuoting(t *testing.T) {
	line, err := buildBatchCmdLine(`C:\Program Files\nodejs\claude.CMD`, []string{
		"-p",
		"--model",
		"claude-sonnet",
		`hello & world | %PATH% "quoted"`,
	})
	if err != nil {
		t.Fatalf("buildBatchCmdLine error: %v", err)
	}
	if !strings.HasPrefix(line, `/d /e:ON /v:OFF /s /c ""C:\Program Files\nodejs\claude.CMD"`) {
		t.Fatalf("unexpected cmdline prefix: %s", line)
	}
	if !strings.Contains(line, `%%cd:~,%PATH%%cd:~,%`) {
		t.Fatalf("expected %% variables to be broken up for cmd.exe safety: %s", line)
	}
	if !strings.Contains(line, `""quoted""`) {
		t.Fatalf("expected quotes to be doubled for cmd.exe: %s", line)
	}
	if _, err := buildBatchCmdLine(`C:\a.cmd`, []string{"bad\nline"}); err == nil {
		t.Fatalf("expected newline in batch arg to be rejected")
	}
}

func TestToolInDirSkipsExtensionlessShShimOnWindows(t *testing.T) {
	dir := t.TempDir()
	// Write a bare extensionless sh shim without .cmd or .exe target
	_ = os.WriteFile(filepath.Join(dir, "foo"), []byte("#!/bin/sh\nnode foo.js\n"), 0o644)
	if got := toolInDir(dir, "foo"); got != "" {
		t.Fatalf("expected extensionless non-exe sh shim to be skipped on Windows, got %q", got)
	}
	// Adding .cmd should resolve cleanly
	cmdPath := filepath.Join(dir, "foo.cmd")
	_ = os.WriteFile(cmdPath, []byte("@echo off\n"), 0o644)
	if got := toolInDir(dir, "foo"); got != cmdPath {
		t.Fatalf("toolInDir = %q, want %q", got, cmdPath)
	}
	// Adding .exe should take precedence over .cmd
	exePath := filepath.Join(dir, "foo.exe")
	_ = os.WriteFile(exePath, []byte("MZ"), 0o755)
	if got := toolInDir(dir, "foo"); got != exePath {
		t.Fatalf("toolInDir = %q, want %q (.exe over .cmd)", got, exePath)
	}
}
