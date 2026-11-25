package harnesses

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNpmPrefixDir(t *testing.T) {
	home := t.TempDir()
	customPrefix := filepath.Join(home, "custom-npm")
	npmrc := "# comment\nregistry=https://registry.npmjs.org/\nprefix = \"" + customPrefix + "\"\n"
	if err := os.WriteFile(filepath.Join(home, ".npmrc"), []byte(npmrc), 0o644); err != nil {
		t.Fatal(err)
	}
	got := npmPrefixDir(home)
	want := customPrefix
	if runtime.GOOS != "windows" {
		want = filepath.Join(customPrefix, "bin")
	}
	if got != want {
		t.Fatalf("npmPrefixDir = %q, want %q", got, want)
	}
}

func TestNodeVersionDirsOrder(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"v9.11.0", "v22.12.0", "v20.1.0", "lts", "v18.0.0"} {
		if err := os.MkdirAll(filepath.Join(root, v, "bin"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got := nodeVersionDirs(root, "bin")
	wantOrder := []string{"v22.12.0", "v20.1.0", "v18.0.0", "v9.11.0", "lts"}
	if len(got) != len(wantOrder) {
		t.Fatalf("got %d dirs (%v), want %d", len(got), got, len(wantOrder))
	}
	for i, w := range wantOrder {
		if filepath.Base(filepath.Dir(got[i])) != w {
			t.Fatalf("index %d = %q, want version %q", i, got[i], w)
		}
	}
}

func TestNpmShimExe(t *testing.T) {
	dir := t.TempDir()
	exeRel := filepath.Join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
	exeAbs := filepath.Join(dir, exeRel)
	if err := os.MkdirAll(filepath.Dir(exeAbs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exeAbs, []byte("MZ"), 0o755); err != nil {
		t.Fatal(err)
	}
	shimPath := filepath.Join(dir, "claude")
	shimContent := "#!/bin/sh\nbasedir=$(dirname \"$0\")\nexec \"$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe\" \"$@\"\n"
	if err := os.WriteFile(shimPath, []byte(shimContent), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := npmShimExe(shimPath); got != exeAbs {
		t.Fatalf("npmShimExe = %q, want %q", got, exeAbs)
	}

	// Path traversal in shim must be rejected.
	badShim := filepath.Join(dir, "bad")
	_ = os.WriteFile(badShim, []byte("#!/bin/sh\nexec \"$basedir/../../evil.exe\" \"$@\"\n"), 0o644)
	if got := npmShimExe(badShim); got != "" {
		t.Fatalf("expected traversal shim rejected, got %q", got)
	}
}

func TestAgentConfigDirHeuristics(t *testing.T) {
	root := t.TempDir()

	// 1. Empty dir -> false
	emptyDir := filepath.Join(root, "empty")
	_ = os.MkdirAll(emptyDir, 0o755)
	if isGenuineAgentConfigDir(emptyDir) {
		t.Fatalf("empty dir should not be genuine config dir")
	}

	// 2. skills/ + logs/ + diagnostics/ + cache/ only -> false (Magpie leftover rule)
	leftoverOnly := filepath.Join(root, "codebuddy")
	for _, sub := range []string{"skills", "logs", "diagnostics", "cache"} {
		_ = os.MkdirAll(filepath.Join(leftoverOnly, sub), 0o755)
	}
	_ = os.WriteFile(filepath.Join(leftoverOnly, ".DS_Store"), []byte("x"), 0o644)
	if isGenuineAgentConfigDir(leftoverOnly) {
		t.Fatalf("leftover/skills-only dir should not be genuine config dir")
	}

	// 3. Regular file occupying config path -> Taken -> false
	takenFile := filepath.Join(root, "dsh-file")
	_ = os.WriteFile(takenFile, []byte("not a dir"), 0o644)
	if isGenuineAgentConfigDir(takenFile) {
		t.Fatalf("regular file should not be genuine config dir")
	}

	// 4. Real config file present -> true
	realDir := filepath.Join(root, "real-dsh")
	_ = os.MkdirAll(filepath.Join(realDir, "skills"), 0o755)
	_ = os.WriteFile(filepath.Join(realDir, "config.yaml"), []byte("version: 1\n"), 0o644)
	if !isGenuineAgentConfigDir(realDir) {
		t.Fatalf("dir with real config.yaml should be genuine config dir")
	}
}

func TestCollisionGuards(t *testing.T) {
	// VS Code copilot shim must be rejected; standalone npm copilot accepted.
	if !isEditorCopilotShim(`D:\Users\me\AppData\Local\Programs\Microsoft VS Code\bin\copilot-shim\copilot.EXE`) {
		t.Fatalf("expected VS Code copilot-shim to be rejected")
	}
	if isEditorCopilotShim(`D:\npm-global\copilot.CMD`) {
		t.Fatalf("expected standalone copilot.CMD to be accepted")
	}

	// Grok regex formula rejected; Grok Build accepted.
	if !isNonGrokBuildBinary("/opt/homebrew/Cellar/grok/1.20110708.1/bin/grok") {
		t.Fatalf("expected Homebrew regex grok to be rejected")
	}
	if isNonGrokBuildBinary(`C:\Users\me\.grok\bin\grok.EXE`) {
		t.Fatalf("expected ~/.grok/bin/grok.EXE to be accepted")
	}

	// Non-cursor agent rejected; cursor-agent accepted.
	if !isNonCursorAgentBinary(`C:\Users\me\.grok\bin\agent.EXE`) {
		t.Fatalf("expected ~/.grok/bin/agent.EXE to be rejected for Cursor CLI")
	}
	if isNonCursorAgentBinary(`/Users/me/.local/bin/cursor-agent`) {
		t.Fatalf("expected cursor-agent to be accepted")
	}

	// Go binary detection: current test binary IS a Go binary; plain text file is NOT.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if !isGoBinary(exe) {
		t.Fatalf("expected Go test executable %q to be detected as Go binary", exe)
	}
	fakeRust := filepath.Join(t.TempDir(), "goose.exe")
	_ = os.WriteFile(fakeRust, []byte("ELF-rust-block-goose-binary"), 0o755)
	if isGoBinary(fakeRust) {
		t.Fatalf("expected non-Go binary not to be flagged as Go binary")
	}
}

func TestBuildArgsExtendedDrivers(t *testing.T) {
	qArgs, qIn := BuildArgs("qwen", "qwen3-coder", nil, "写一段文案", "")
	if qIn != "写一段文案" || !strings.Contains(strings.Join(qArgs, " "), "-o json") {
		t.Fatalf("unexpected qwen args: %v stdin=%q", qArgs, qIn)
	}

	kArgs, kIn := BuildArgs("kimi", "k2", nil, "你好", "")
	if kIn != "" || !strings.Contains(strings.Join(kArgs, " "), "-p 你好") {
		t.Fatalf("unexpected kimi args: %v stdin=%q", kArgs, kIn)
	}

	hArgs, hIn := BuildArgs("hermes", "sonnet", nil, "测一下", "")
	if hIn != "" || !strings.Contains(strings.Join(hArgs, " "), "chat -Q -q 测一下 -m sonnet") {
		t.Fatalf("unexpected hermes args: %v stdin=%q", hArgs, hIn)
	}

	gArgs, gIn := BuildArgs("grok", "grok-4", nil, "prompt", "/tmp/p.txt")
	if gIn != "" || !strings.Contains(strings.Join(gArgs, " "), "--prompt-file /tmp/p.txt") {
		t.Fatalf("unexpected grok args: %v stdin=%q", gArgs, gIn)
	}

	oArgs, oIn := BuildArgs("omp", "opus", nil, "hi", "")
	if oIn != "hi" || !strings.Contains(strings.Join(oArgs, " "), "-p --mode text --model opus") {
		t.Fatalf("unexpected omp args: %v stdin=%q", oArgs, oIn)
	}

	goArgs, goIn := BuildArgs("goose", "", nil, "hi", "/tmp/g.txt")
	if goIn != "" || !strings.Contains(strings.Join(goArgs, " "), "run --no-session -i /tmp/g.txt") {
		t.Fatalf("unexpected goose args: %v stdin=%q", goArgs, goIn)
	}
}

func TestDiscoverIsolatedMultiSourceAndConfigHint(t *testing.T) {
	t.Setenv("HANDRAW_HARNESS_TEST_ISOLATE", "1")
	fakeHome := t.TempDir()
	t.Setenv("USERPROFILE", fakeHome)
	t.Setenv("HOME", fakeHome)
	t.Setenv("APPDATA", filepath.Join(fakeHome, "AppData", "Roaming"))
	t.Setenv("LOCALAPPDATA", filepath.Join(fakeHome, "AppData", "Local"))
	Rescan()
	defer Rescan()

	dirA := t.TempDir()
	dirB := t.TempDir()
	dshCfg := t.TempDir()
	_ = os.WriteFile(filepath.Join(dshCfg, ".env"), []byte("FOO=bar\n"), 0o644)

	binName := func(base string) string {
		if runtime.GOOS == "windows" {
			return base + ".cmd"
		}
		return base
	}
	p1 := filepath.Join(dirA, binName("claude"))
	p2 := filepath.Join(dirB, binName("claude"))
	_ = os.WriteFile(p1, []byte("#!/bin/sh\necho ok\n"), 0o755)
	_ = os.WriteFile(p2, []byte("#!/bin/sh\necho ok\n"), 0o755)

	t.Setenv("PATH", dirA+string(os.PathListSeparator)+dirB)
	t.Setenv("DSH_HOME", dshCfg)
	// Point BUN_INSTALL to an isolated dir with omp
	bunRoot := t.TempDir()
	bunBin := filepath.Join(bunRoot, "bin")
	_ = os.MkdirAll(bunBin, 0o755)
	ompPath := filepath.Join(bunBin, binName("omp"))
	_ = os.WriteFile(ompPath, []byte("#!/bin/sh\necho ok\n"), 0o755)
	t.Setenv("BUN_INSTALL", bunRoot)

	items := Discover(nil)
	byID := map[string]Status{}
	for _, it := range items {
		byID[it.ID] = it
	}

	cl := byID["claude"]
	if !cl.Detected || cl.ResolvedPath != p1 || cl.DetectionSource != "PATH" {
		t.Fatalf("expected claude detected from PATH=%q, got %+v", p1, cl)
	}
	if len(cl.Candidates) != 2 {
		t.Fatalf("expected 2 claude candidates across PATH dirs, got %v", cl.Candidates)
	}

	omp := byID["omp"]
	if !omp.Detected || omp.ResolvedPath != ompPath || omp.DetectionSource != "Bun 全局目录" {
		t.Fatalf("expected omp detected via BUN_INSTALL, got %+v", omp)
	}

	dsh := byID["dsh"]
	if dsh.Detected {
		t.Fatalf("dsh binary should not be detected in isolated env, got %+v", dsh)
	}
	if !dsh.ConfigDetected || dsh.ConfigDir != dshCfg || dsh.DiagnosticHint == "" {
		t.Fatalf("expected dsh config-only diagnostic hint, got %+v", dsh)
	}
}

func TestLiveHostDiscoveryReport(t *testing.T) {
	if os.Getenv("HANDRAW_LIVE_PROBE") == "" {
		t.Skip("set HANDRAW_LIVE_PROBE=1 to inspect live host harness discovery")
	}
	Rescan()
	logItems := func(label string, items []Status) {
		det, cfgOnly := 0, 0
		t.Logf("=== %s ===", label)
		for _, it := range items {
			if it.Detected {
				det++
				t.Logf("[OK]  %-10s src=%-14s path=%s candidates=%d", it.ID, it.DetectionSource, it.ResolvedPath, len(it.Candidates))
			} else if it.ConfigDetected && it.DiagnosticHint != "" {
				cfgOnly++
				t.Logf("[CFG] %-10s cfg=%s hint=%s", it.ID, it.ConfigDir, it.DiagnosticHint)
			}
		}
		t.Logf("SUMMARY: total=%d detected=%d configOnly=%d", len(items), det, cfgOnly)
	}

	logItems("FULL PATH", Discover(nil))

	if runtime.GOOS == "windows" {
		t.Setenv("PATH", `C:\Windows\System32;C:\Windows`)
		Rescan()
		logItems("STRIPPED GUI PATH", Discover(nil))
	}
}
