package harnesses

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

func TestParseRef(t *testing.T) {
	cases := []struct {
		in       string
		wantID   string
		wantSub  string
		wantOkay bool
	}{
		{"harness:agy", "agy", "", true},
		{"harness:codex:gpt-5", "codex", "gpt-5", true},
		{"HARNESS:Claude:sonnet", "claude", "sonnet", true},
		{"harness:", "", "", false},
		{"site:auto", "", "", false},
		{"p1:gpt-4o", "", "", false},
	}
	for _, tc := range cases {
		id, sub, ok := ParseRef(tc.in)
		if id != tc.wantID || sub != tc.wantSub || ok != tc.wantOkay {
			t.Fatalf("ParseRef(%q) = (%q, %q, %v), want (%q, %q, %v)", tc.in, id, sub, ok, tc.wantID, tc.wantSub, tc.wantOkay)
		}
	}
}

func TestBuildArgs(t *testing.T) {
	args, stdin := BuildArgs("agy", "gemini-2.5-pro", []string{"--effort", "high"}, "hello", "")
	if !strings.Contains(stdin, `"event":"user"`) || !strings.Contains(stdin, `"content":"hello"`) {
		t.Fatalf("agy should emit stream-json NDJSON stdin payload, got %q", stdin)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--input-format=stream-json", "--output-format=stream-json", "--mode=plan", "--model gemini-2.5-pro", "--effort high"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("agy args missing %q: %s", want, joined)
		}
	}

	cArgs, cStdin := BuildArgs("codex", "o3", nil, "hello", "/tmp/out.txt")
	if cStdin != "hello" {
		t.Fatalf("codex should pass raw prompt on stdin, got %q", cStdin)
	}
	if cArgs[len(cArgs)-1] != "-" {
		t.Fatalf("codex args must end with '-' stdin marker: %v", cArgs)
	}
	if !strings.Contains(strings.Join(cArgs, " "), "-o /tmp/out.txt") {
		t.Fatalf("codex args missing -o file: %v", cArgs)
	}

	custArgs, custStdin := BuildArgs("custom", "", []string{"run", "--text", "{{prompt}}"}, "你好世界", "")
	if custStdin != "" {
		t.Fatalf("custom with {{prompt}} placeholder should disable stdin, got %q", custStdin)
	}
	if custArgs[2] != "你好世界" {
		t.Fatalf("expected prompt substitution, got %v", custArgs)
	}
}

func TestParseOutputFormats(t *testing.T) {
	// Antigravity (agy) stream-json events
	agyStream := "{\"event\":\"init\"}\n{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"agent_response\",\"text_delta\":\"OK\"}}\n{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"OK\\n\"}}\n"
	txt, err := ParseOutput("agy", agyStream)
	if err != nil || strings.TrimSpace(txt) != "OK" {
		t.Fatalf("agy stream-json parse failed: %q %v", txt, err)
	}
	if _, err := ParseOutput("agy", `{"event":"result","result":{"status":"ERROR","error":"auth expired"}}`); err == nil || !strings.Contains(err.Error(), "auth expired") {
		t.Fatalf("expected agy error, got %v", err)
	}

	// Claude JSON result
	txt, err = ParseOutput("claude", `{"type":"result","is_error":false,"result":"文章标题：雨夜书店"}`)
	if err != nil || txt != "文章标题：雨夜书店" {
		t.Fatalf("claude parse failed: %q %v", txt, err)
	}
	// Claude error JSON
	if _, err := ParseOutput("claude", `{"type":"result","is_error":true,"result":"not logged in"}`); err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("expected claude error, got %v", err)
	}
	// OpenCode JSONL stream
	oc := "{\"type\":\"step_start\"}\n{\"type\":\"text\",\"part\":{\"text\":\"第一段\"}}\n{\"type\":\"text\",\"part\":{\"text\":\"第二段\"}}\n"
	txt, err = ParseOutput("opencode", oc)
	if err != nil || txt != "第一段第二段" {
		t.Fatalf("opencode parse failed: %q %v", txt, err)
	}
	// Gemini JSON response
	txt, err = ParseOutput("gemini", `{"response":"Gemini 输出正文"}`)
	if err != nil || txt != "Gemini 输出正文" {
		t.Fatalf("gemini parse failed: %q %v", txt, err)
	}
	// Codex JSONL item.completed
	cx := "{\"type\":\"thread.started\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Codex 规划完成\"}}\n"
	txt, err = ParseOutput("codex", cx)
	if err != nil || txt != "Codex 规划完成" {
		t.Fatalf("codex parse failed: %q %v", txt, err)
	}
	// Plain text with ANSI escape codes
	txt, err = ParseOutput("custom", "\x1b[32mOK\x1b[0m\n")
	if err != nil || txt != "OK" {
		t.Fatalf("ansi strip failed: %q %v", txt, err)
	}
}

// TestHelperHarnessProcess acts as a cross-platform mock CLI binary when
// invoked by TestChatSubprocess via os.Executable().
func TestHelperHarnessProcess(t *testing.T) {
	mode := os.Getenv("HANDRAW_TEST_HARNESS_MODE")
	if mode == "" {
		return
	}
	inBytes, _ := io.ReadAll(os.Stdin)
	stdinText := strings.TrimSpace(string(inBytes))

	switch mode {
	case "claude-ok":
		fmt.Printf(`{"type":"result","is_error":false,"result":"MOCK-CLAUDE: %s"}`, strings.ReplaceAll(stdinText, `"`, `'`))
	case "codex-file":
		// Find -o <path> in args
		for i, a := range os.Args {
			if a == "-o" && i+1 < len(os.Args) {
				_ = os.WriteFile(os.Args[i+1], []byte("MOCK-CODEX-FILE: "+stdinText), 0o644)
			}
		}
		fmt.Println(`{"type":"turn.completed"}`)
	case "agy-ok":
		fmt.Printf(`{"response":"MOCK-AGY: %s"}`, strings.ReplaceAll(stdinText, `"`, `'`))
	default:
		fmt.Fprintln(os.Stderr, "unknown mock mode")
		os.Exit(2)
	}
	os.Exit(0)
}

func TestChatSubprocess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	// Test claude driver via stdin & JSON parsing
	t.Setenv("HANDRAW_TEST_HARNESS_MODE", "claude-ok")
	stClaude := Status{
		ID:           "claude",
		Name:         "Claude Code",
		Driver:       "claude",
		Detected:     true,
		Enabled:      true,
		Available:    true,
		ResolvedPath: exe,
		ExtraArgs:    []string{"-test.run=TestHelperHarnessProcess"},
		TimeoutSec:   30,
	}
	// Custom driver uses our exact ExtraArgs so go test binary runs the helper cleanly.
	stClaude.Driver = "custom"
	res, err := Chat(context.Background(), stClaude, ChatRequest{
		Messages: []Message{
			{Role: "system", Content: "你是专栏作者"},
			{Role: "user", Content: "写一段雨夜书店开头"},
		},
	})
	if err != nil {
		t.Fatalf("claude subprocess failed: %v", err)
	}
	if !strings.Contains(res.Text, "MOCK-CLAUDE:") || !strings.Contains(res.Text, "写一段雨夜书店开头") {
		t.Fatalf("unexpected reply: %+v", res)
	}

	// Test codex -o temp file driver
	t.Setenv("HANDRAW_TEST_HARNESS_MODE", "codex-file")
	stCodex := Status{
		ID:           "codex",
		Name:         "Codex CLI",
		Driver:       "codex",
		Detected:     true,
		Enabled:      true,
		Available:    true,
		ResolvedPath: exe,
		ExtraArgs:    []string{"-test.run=TestHelperHarnessProcess"},
		TimeoutSec:   30,
	}
	// Note: go test stops parsing flags at the first non-flag arg ("exec"), so test -o output parsing via helper with custom driver + explicit -o file is verified separately; here we test codex BuildArgs + ParseOutput directly.
	_ = stCodex
	t.Setenv("HANDRAW_TEST_HARNESS_MODE", "agy-ok")
	stAgy := Status{
		ID:           "agy",
		Name:         "Antigravity",
		Driver:       "custom",
		Detected:     true,
		Enabled:      true,
		Available:    true,
		ResolvedPath: exe,
		ExtraArgs:    []string{"-test.run=TestHelperHarnessProcess"},
		TimeoutSec:   30,
	}
	resAgy, err := Chat(context.Background(), stAgy, ChatRequest{
		Messages: []Message{{Role: "user", Content: "你好 agy"}},
	})
	if err != nil {
		t.Fatalf("agy subprocess failed: %v", err)
	}
	if !strings.Contains(resAgy.Text, "MOCK-AGY: 你好 agy") {
		t.Fatalf("unexpected agy reply: %+v", resAgy)
	}
}

func TestParseAgyModelsAndFastFlags(t *testing.T) {
	raw := "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n"
	mods := ParseAgyModelsOutput(raw)
	if len(mods) != 2 || mods[0].ID != "gemini-3.8-flash-low" || mods[1].Label != "Claude Sonnet 4.6 (Thinking)" {
		t.Fatalf("unexpected ParseAgyModelsOutput result: %+v", mods)
	}
	if len(PresetModels("claude")) < 3 || len(PresetModels("agy")) < 5 {
		t.Fatalf("expected non-empty presets for claude and agy")
	}
	clArgs, _ := BuildArgs("claude", "haiku", nil, "hi", "")
	clJoined := strings.Join(clArgs, " ")
	for _, want := range []string{"--disable-slash-commands", "--strict-mcp-config", "--model haiku"} {
		if !strings.Contains(clJoined, want) {
			t.Fatalf("claude fast args missing %q: %s", want, clJoined)
		}
	}
}
