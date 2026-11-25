// Package harnesses discovers and invokes locally installed AI coding/agent
// harness CLIs (Antigravity agy, Claude Code, Codex, OpenCode, Gemini CLI, DSH,
// and user-defined custom CLIs) behind one cross-platform, stdin-safe interface (#119).
package harnesses

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Message is one role/content chat turn passed to a local harness.
type Message struct {
	Role    string `json:"role"`
	Content any    `json:"content,omitempty"`
}

const (
	DefaultTimeoutSec = 180
	MinTimeoutSec     = 15
	MaxTimeoutSec     = 600
	maxOutputBytes    = 4 << 20 // 4 MiB safety cap
)

// Spec defines a built-in supported local AI harness CLI.
type Spec struct {
	ID          string
	Name        string
	Driver      string // agy | claude | codex | opencode | gemini | dsh | custom
	Binaries    []string
	Description string
	Homepage    string
}

// Config is the user-persisted configuration for a built-in override or custom harness.
type Config struct {
	ID         string   `json:"id"`
	Name       string   `json:"name,omitempty"`
	Driver     string   `json:"driver,omitempty"` // agy | claude | codex | opencode | gemini | dsh | custom
	Enabled    *bool    `json:"enabled,omitempty"`
	Command    string   `json:"command,omitempty"`   // optional explicit binary path or command name
	Model      string   `json:"model,omitempty"`     // optional sub-model flag value
	ExtraArgs  []string `json:"extraArgs,omitempty"` // optional extra CLI flags
	WorkDir    string   `json:"workDir,omitempty"`   // optional explicit working directory
	TimeoutSec int      `json:"timeoutSec,omitempty"`
	Custom     bool     `json:"custom,omitempty"`
}

// Status describes a harness's live detection, configuration, and availability.
type Status struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Driver       string   `json:"driver"`
	Description  string   `json:"description,omitempty"`
	Homepage     string   `json:"homepage,omitempty"`
	Builtin      bool     `json:"builtin"`
	Custom       bool     `json:"custom,omitempty"`
	Detected     bool     `json:"detected"`
	Enabled      bool     `json:"enabled"`
	Available    bool     `json:"available"`
	ResolvedPath string   `json:"resolvedPath,omitempty"`
	Command      string   `json:"command,omitempty"`
	Model        string   `json:"model,omitempty"`
	ExtraArgs    []string `json:"extraArgs,omitempty"`
	WorkDir      string   `json:"workDir,omitempty"`
	TimeoutSec   int      `json:"timeoutSec"`
	DefaultRef   string   `json:"defaultRef"`
}

// ChatRequest is a single text/planning turn sent to a local harness.
type ChatRequest struct {
	Messages []Message
	JSONMode bool
	Model    string // optional per-call sub-model override
	WorkDir  string // optional per-call workdir override
}

// ChatResult is the normalized assistant reply from a local harness.
type ChatResult struct {
	Text      string `json:"text"`
	HarnessID string `json:"harnessId"`
	Driver    string `json:"driver"`
	Model     string `json:"model,omitempty"`
	ElapsedMs int64  `json:"elapsedMs"`
}

// BuiltinSpecs returns the catalog of first-class local AI harnesses.
func BuiltinSpecs() []Spec {
	return []Spec{
		{
			ID:          "agy",
			Name:        "Antigravity (agy)",
			Driver:      "agy",
			Binaries:    []string{"agy"},
			Description: "Google Antigravity CLI，支持本地 Skill、思考模式与流式输出",
			Homepage:    "https://antigravity.google",
		},
		{
			ID:          "claude",
			Name:        "Claude Code",
			Driver:      "claude",
			Binaries:    []string{"claude"},
			Description: "Anthropic Claude Code CLI，复用本机订阅与 Skills",
			Homepage:    "https://docs.anthropic.com/en/docs/claude-code",
		},
		{
			ID:          "codex",
			Name:        "Codex CLI",
			Driver:      "codex",
			Binaries:    []string{"codex"},
			Description: "OpenAI Codex CLI，支持只读沙箱非交互执行",
			Homepage:    "https://github.com/openai/codex",
		},
		{
			ID:          "opencode",
			Name:        "OpenCode",
			Driver:      "opencode",
			Binaries:    []string{"opencode"},
			Description: "开源多模型终端 Agent，支持多提供商切换",
			Homepage:    "https://opencode.ai",
		},
		{
			ID:          "gemini",
			Name:        "Gemini CLI",
			Driver:      "gemini",
			Binaries:    []string{"gemini"},
			Description: "Google Gemini CLI，支持只读计划模式与结构化输出",
			Homepage:    "https://github.com/google-gemini/gemini-cli",
		},
		{
			ID:          "dsh",
			Name:        "DeepSeek Harness (DSH)",
			Driver:      "dsh",
			Binaries:    []string{"dsh"},
			Description: "DeepSeek Harness 本地 CLI（可在配置中指定可执行路径与参数）",
			Homepage:    "https://github.com/deepseek-ai",
		},
	}
}

// ValidID checks whether a harness ID is safe for refs ("harness:<id>") and URLs.
var validIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)

func ValidID(id string) bool {
	return validIDRe.MatchString(id)
}

func NormalizeDriver(d string) string {
	switch strings.ToLower(strings.TrimSpace(d)) {
	case "agy", "antigravity":
		return "agy"
	case "claude", "claude-code":
		return "claude"
	case "codex":
		return "codex"
	case "opencode":
		return "opencode"
	case "gemini", "gemini-cli":
		return "gemini"
	case "dsh":
		return "dsh"
	default:
		return "custom"
	}
}

func clampTimeout(sec int) int {
	if sec <= 0 {
		return DefaultTimeoutSec
	}
	if sec < MinTimeoutSec {
		return MinTimeoutSec
	}
	if sec > MaxTimeoutSec {
		return MaxTimeoutSec
	}
	return sec
}

// Discover combines built-in specs with user overrides and custom harnesses,
// probing local executables without invoking them.
func Discover(configs []Config) []Status {
	cfgByID := map[string]Config{}
	cfgOrder := []string{}
	for _, c := range configs {
		id := strings.ToLower(strings.TrimSpace(c.ID))
		if id == "" {
			continue
		}
		c.ID = id
		if _, exists := cfgByID[id]; !exists {
			cfgOrder = append(cfgOrder, id)
		}
		cfgByID[id] = c
	}

	seen := map[string]bool{}
	out := make([]Status, 0, len(BuiltinSpecs())+len(configs))

	for _, sp := range BuiltinSpecs() {
		seen[sp.ID] = true
		cfg := cfgByID[sp.ID]
		resolved := resolveBinary(cfg.Command, sp.Binaries)
		detected := resolved != ""
		enabled := detected
		if cfg.Enabled != nil {
			enabled = *cfg.Enabled
		}
		name := strings.TrimSpace(cfg.Name)
		if name == "" {
			name = sp.Name
		}
		driver := sp.Driver
		if strings.TrimSpace(cfg.Driver) != "" {
			driver = NormalizeDriver(cfg.Driver)
		}
		out = append(out, Status{
			ID:           sp.ID,
			Name:         name,
			Driver:       driver,
			Description:  sp.Description,
			Homepage:     sp.Homepage,
			Builtin:      true,
			Detected:     detected,
			Enabled:      enabled,
			Available:    enabled && detected,
			ResolvedPath: resolved,
			Command:      strings.TrimSpace(cfg.Command),
			Model:        strings.TrimSpace(cfg.Model),
			ExtraArgs:    cleanArgs(cfg.ExtraArgs),
			WorkDir:      strings.TrimSpace(cfg.WorkDir),
			TimeoutSec:   clampTimeout(cfg.TimeoutSec),
			DefaultRef:   "harness:" + sp.ID,
		})
	}

	for _, id := range cfgOrder {
		if seen[id] {
			continue
		}
		cfg := cfgByID[id]
		if !ValidID(id) {
			continue
		}
		cmdStr := strings.TrimSpace(cfg.Command)
		var resolved string
		if cmdStr != "" {
			resolved = resolveBinary(cmdStr, nil)
		}
		detected := resolved != ""
		enabled := true
		if cfg.Enabled != nil {
			enabled = *cfg.Enabled
		}
		name := strings.TrimSpace(cfg.Name)
		if name == "" {
			name = id
		}
		driver := NormalizeDriver(cfg.Driver)
		out = append(out, Status{
			ID:           id,
			Name:         name,
			Driver:       driver,
			Description:  "用户自定义本地 CLI Harness",
			Builtin:      false,
			Custom:       true,
			Detected:     detected,
			Enabled:      enabled,
			Available:    enabled && detected,
			ResolvedPath: resolved,
			Command:      cmdStr,
			Model:        strings.TrimSpace(cfg.Model),
			ExtraArgs:    cleanArgs(cfg.ExtraArgs),
			WorkDir:      strings.TrimSpace(cfg.WorkDir),
			TimeoutSec:   clampTimeout(cfg.TimeoutSec),
			DefaultRef:   "harness:" + id,
		})
	}
	return out
}

// Find looks up one harness status by ID.
func Find(configs []Config, id string) (Status, bool) {
	want := strings.ToLower(strings.TrimSpace(id))
	if want == "" {
		return Status{}, false
	}
	for _, st := range Discover(configs) {
		if st.ID == want {
			return st, true
		}
	}
	return Status{}, false
}

// ParseRef parses "harness:<id>" or "harness:<id>:<submodel>".
func ParseRef(ref string) (id string, subModel string, ok bool) {
	ref = strings.TrimSpace(ref)
	if !strings.HasPrefix(strings.ToLower(ref), "harness:") {
		return "", "", false
	}
	rest := strings.TrimSpace(ref[len("harness:"):])
	if rest == "" {
		return "", "", false
	}
	idPart, modPart, hasColon := strings.Cut(rest, ":")
	id = strings.ToLower(strings.TrimSpace(idPart))
	if id == "" {
		return "", "", false
	}
	if hasColon {
		subModel = strings.TrimSpace(modPart)
	}
	return id, subModel, true
}

func cleanArgs(in []string) []string {
	var out []string
	for _, a := range in {
		if s := strings.TrimSpace(a); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func resolveBinary(customCmd string, candidates []string) string {
	customCmd = strings.TrimSpace(customCmd)
	if customCmd != "" {
		if p := lookupExecutable(customCmd); p != "" {
			return p
		}
		return ""
	}
	for _, name := range candidates {
		if p := lookupExecutable(name); p != "" {
			return p
		}
	}
	return ""
}

func lookupExecutable(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	// Explicit path (absolute or containing separator).
	if filepath.IsAbs(name) || strings.ContainsAny(name, `/\`) {
		if st, err := os.Stat(name); err == nil && !st.IsDir() {
			if abs, err := filepath.Abs(name); err == nil {
				return abs
			}
			return name
		}
		if runtime.GOOS == "windows" && filepath.Ext(name) == "" {
			for _, ext := range []string{".exe", ".cmd", ".bat"} {
				cand := name + ext
				if st, err := os.Stat(cand); err == nil && !st.IsDir() {
					return cand
				}
			}
		}
		return ""
	}
	if p, err := exec.LookPath(name); err == nil && p != "" {
		return p
	}
	// GUI-launched desktop apps (especially macOS .app bundles) often inherit a
	// minimal PATH. Check common user/package install directories as fallback.
	for _, dir := range fallbackBinDirs() {
		if dir == "" {
			continue
		}
		if runtime.GOOS == "windows" {
			for _, ext := range []string{".exe", ".cmd", ".bat", ""} {
				cand := filepath.Join(dir, name+ext)
				if st, err := os.Stat(cand); err == nil && !st.IsDir() {
					return cand
				}
			}
		} else {
			cand := filepath.Join(dir, name)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() && (st.Mode()&0o111) != 0 {
				return cand
			}
		}
	}
	return ""
}

func fallbackBinDirs() []string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		localApp := os.Getenv("LOCALAPPDATA")
		appData := os.Getenv("APPDATA")
		return []string{
			filepath.Join(localApp, "agy", "bin"),
			filepath.Join(appData, "npm"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".claude", "local"),
			filepath.Join(home, ".opencode", "bin"),
		}
	}
	return []string{
		filepath.Join(home, ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		filepath.Join(home, ".npm-global", "bin"),
		filepath.Join(home, ".claude", "local"),
		filepath.Join(home, ".opencode", "bin"),
	}
}

// Chat executes one non-interactive text/planning turn via the resolved local harness.
func Chat(ctx context.Context, st Status, req ChatRequest) (ChatResult, error) {
	if !st.Available || st.ResolvedPath == "" {
		if !st.Detected {
			return ChatResult{}, fmt.Errorf("未在本机检测到 %s，请先安装或在「设置 → 本地 Harness」中指定可执行路径", st.Name)
		}
		return ChatResult{}, fmt.Errorf("%s 当前未启用，请在「设置 → 本地 Harness」中开启", st.Name)
	}
	prompt := ComposePrompt(req.Messages, req.JSONMode)
	if strings.TrimSpace(prompt) == "" {
		return ChatResult{}, errors.New("消息内容不能为空")
	}

	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = strings.TrimSpace(st.Model)
	}

	timeout := time.Duration(clampTimeout(st.TimeoutSec)) * time.Second
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Prepare an isolated scratch directory by default so plan/read-only runs
	// cannot pollute or touch user project files unless explicitly configured.
	workDir := strings.TrimSpace(req.WorkDir)
	if workDir == "" {
		workDir = strings.TrimSpace(st.WorkDir)
	}
	var scratchDir string
	if workDir == "" {
		if d, err := os.MkdirTemp("", "handraw-harness-*"); err == nil {
			scratchDir = d
			workDir = d
			defer os.RemoveAll(scratchDir)
		}
	}

	var codexOutFile string
	if st.Driver == "codex" {
		if f, err := os.CreateTemp("", "handraw-codex-out-*.txt"); err == nil {
			codexOutFile = f.Name()
			_ = f.Close()
			defer os.Remove(codexOutFile)
		}
	}

	args, stdinPayload := BuildArgs(st.Driver, model, st.ExtraArgs, prompt, codexOutFile)

	start := time.Now()
	cmd := exec.CommandContext(runCtx, st.ResolvedPath, args...)
	configureCommand(cmd)
	if workDir != "" {
		if info, err := os.Stat(workDir); err == nil && info.IsDir() {
			cmd.Dir = workDir
		}
	}
	cmd.Env = append(os.Environ(),
		"NO_COLOR=1",
		"FORCE_COLOR=0",
		"CLICOLOR=0",
		"PYTHONIOENCODING=utf-8",
	)
	if stdinPayload != "" {
		cmd.Stdin = strings.NewReader(stdinPayload)
	}

	var stdout, stderr limitedBuffer
	stdout.limit = maxOutputBytes
	stderr.limit = maxOutputBytes
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	elapsed := time.Since(start).Milliseconds()

	if runCtx.Err() == context.DeadlineExceeded {
		return ChatResult{}, fmt.Errorf("%s 响应超时（已等待 %d 秒），可在「设置 → 本地 Harness」中调大超时或换其他引擎", st.Name, clampTimeout(st.TimeoutSec))
	}
	if runCtx.Err() == context.Canceled {
		return ChatResult{}, context.Canceled
	}

	outStr := stdout.String()
	errStr := strings.TrimSpace(stripANSI(stderr.String()))

	// Codex writes its clean final message to -o <tmpfile>.
	if st.Driver == "codex" && codexOutFile != "" {
		if b, rerr := os.ReadFile(codexOutFile); rerr == nil && len(bytes.TrimSpace(b)) > 0 {
			text := strings.TrimSpace(stripANSI(string(b)))
			if text != "" {
				return ChatResult{
					Text:      text,
					HarnessID: st.ID,
					Driver:    st.Driver,
					Model:     model,
					ElapsedMs: elapsed,
				}, nil
			}
		}
	}

	parsed, parseErr := ParseOutput(st.Driver, outStr)
	if err != nil {
		if parseErr != nil {
			return ChatResult{}, fmt.Errorf("%s 执行失败：%v", st.Name, parseErr)
		}
		detail := firstNonEmpty(errStr, truncateErr(stripANSI(outStr)), err.Error())
		return ChatResult{}, fmt.Errorf("%s 执行失败：%s", st.Name, detail)
	}
	if parseErr != nil {
		return ChatResult{}, fmt.Errorf("%s 返回错误：%v", st.Name, parseErr)
	}
	parsed = strings.TrimSpace(parsed)
	if parsed == "" {
		if errStr != "" {
			return ChatResult{}, fmt.Errorf("%s 未返回正文：%s", st.Name, truncateErr(errStr))
		}
		return ChatResult{}, fmt.Errorf("%s 返回内容为空", st.Name)
	}
	return ChatResult{
		Text:      parsed,
		HarnessID: st.ID,
		Driver:    st.Driver,
		Model:     model,
		ElapsedMs: elapsed,
	}, nil
}

// BuildArgs constructs CLI flags and optional stdin payload for each supported
// harness driver. Prompts are passed via stdin by default to avoid Windows .cmd
// length/escaping issues.
func BuildArgs(driver, model string, extraArgs []string, prompt, codexOutFile string) (args []string, stdinPayload string) {
	driver = NormalizeDriver(driver)
	stdinPayload = prompt
	switch driver {
	case "agy":
		args = []string{"--input-format=stream-json", "--output-format=stream-json", "--mode=plan"}
		if model != "" {
			args = append(args, "--model", model)
		}
		b, _ := json.Marshal(map[string]any{
			"event": "user",
			"message": map[string]any{
				"content": prompt,
			},
		})
		stdinPayload = string(b) + "\n"
	case "claude":
		args = []string{"-p", "--output-format", "json", "--permission-mode", "plan", "--no-session-persistence"}
		if model != "" {
			args = append(args, "--model", model)
		}
	case "codex":
		args = []string{"exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--color", "never"}
		if model != "" {
			args = append(args, "-m", model)
		}
		if codexOutFile != "" {
			args = append(args, "-o", codexOutFile)
		}
		// Extra flags go before the trailing "-" stdin sentinel.
		if len(extraArgs) > 0 {
			args = append(args, extraArgs...)
		}
		args = append(args, "-")
		return args, prompt
	case "opencode":
		args = []string{"run", "--format", "json"}
		if model != "" {
			args = append(args, "-m", model)
		}
	case "gemini":
		// Gemini CLI appends -p value after stdin when stdin is piped.
		args = []string{"-p", "", "--approval-mode", "plan", "--output-format", "json"}
		if model != "" {
			args = append(args, "-m", model)
		}
	default:
		// dsh / custom: pass user extraArgs; support optional {{prompt}} placeholder.
		for _, a := range extraArgs {
			if strings.Contains(a, "{{prompt}}") {
				args = append(args, strings.ReplaceAll(a, "{{prompt}}", prompt))
				stdinPayload = ""
			} else {
				args = append(args, a)
			}
		}
		if model != "" && !containsFlag(args, "--model") && !containsFlag(args, "-m") {
			args = append(args, "--model", model)
		}
		return args, stdinPayload
	}
	if len(extraArgs) > 0 {
		args = append(args, extraArgs...)
	}
	return args, stdinPayload
}

func containsFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag || strings.HasPrefix(a, flag+"=") {
			return true
		}
	}
	return false
}

// ComposePrompt serializes chat messages into one clear UTF-8 prompt suitable
// for non-interactive CLI harnesses.
func ComposePrompt(msgs []Message, jsonMode bool) string {
	var sysParts []string
	var convo []Message
	for _, m := range msgs {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		txt := extractMessageText(m)
		if txt == "" {
			continue
		}
		if role == "system" {
			sysParts = append(sysParts, txt)
		} else {
			convo = append(convo, Message{Role: role, Content: txt})
		}
	}
	if len(sysParts) == 0 && len(convo) == 0 {
		return ""
	}
	var sb strings.Builder
	if len(sysParts) > 0 {
		sb.WriteString("【系统指令】\n")
		sb.WriteString(strings.Join(sysParts, "\n\n"))
		sb.WriteString("\n\n")
	}
	if len(convo) == 1 && convo[0].Role == "user" {
		if len(sysParts) > 0 {
			sb.WriteString("【用户输入】\n")
		}
		sb.WriteString(asText(convo[0].Content))
	} else if len(convo) > 0 {
		sb.WriteString("【对话上下文】\n")
		for _, m := range convo {
			label := "用户"
			if m.Role == "assistant" {
				label = "助手"
			}
			sb.WriteString(label)
			sb.WriteString("：\n")
			sb.WriteString(asText(m.Content))
			sb.WriteString("\n\n")
		}
		sb.WriteString("请直接给出助手对最后一条用户消息的回复。")
	}
	if jsonMode {
		sb.WriteString("\n\n请严格仅输出合法的 JSON 对象，不要包含额外解释或多余前后缀。")
	}
	return strings.TrimSpace(sb.String())
}

func extractMessageText(m Message) string {
	switch v := m.Content.(type) {
	case string:
		return strings.TrimSpace(v)
	case []map[string]any:
		var parts []string
		for _, mp := range v {
			if t, ok := mp["text"].(string); ok && strings.TrimSpace(t) != "" {
				parts = append(parts, strings.TrimSpace(t))
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		var parts []string
		for _, item := range v {
			if mp, ok := item.(map[string]any); ok {
				if t, ok := mp["text"].(string); ok && strings.TrimSpace(t) != "" {
					parts = append(parts, strings.TrimSpace(t))
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		if v == nil {
			return ""
		}
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func asText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// ParseOutput extracts the final assistant text from JSON, NDJSON/JSONL, or
// plain stdout emitted by any supported harness driver.
func ParseOutput(driver, raw string) (string, error) {
	cleaned := strings.TrimSpace(stripANSI(raw))
	if cleaned == "" {
		return "", nil
	}

	// 1. Try single top-level JSON object (claude / agy / gemini / custom JSON).
	if strings.HasPrefix(cleaned, "{") {
		if text, isErr, errMsg, ok := parseSingleJSONObj([]byte(cleaned)); ok {
			if isErr {
				return "", errors.New(firstNonEmpty(errMsg, "CLI 返回错误"))
			}
			if text != "" {
				return text, nil
			}
		}
	}

	// 2. Try NDJSON / JSONL event streams (opencode --format json, codex --json, stream-json).
	lines := strings.Split(cleaned, "\n")
	var jsonLines []string
	var streamParts []string
	var lastResult string
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if !strings.HasPrefix(ln, "{") {
			continue
		}
		jsonLines = append(jsonLines, ln)
		var obj map[string]any
		if json.Unmarshal([]byte(ln), &obj) != nil {
			continue
		}
		if isErr, _ := obj["is_error"].(bool); isErr {
			msg := extractStringField(obj, "result", "error", "message")
			return "", errors.New(firstNonEmpty(msg, "CLI 返回错误"))
		}
		// Antigravity (agy) stream-json events use {"event":"result","result":{status,response,error}}
		// and {"event":"step_update","step_update":{step_type:"agent_response",text_delta:"..."}}.
		ev := strings.ToLower(extractStringField(obj, "event"))
		if ev == "result" {
			if resObj, ok := obj["result"].(map[string]any); ok {
				if strings.EqualFold(extractStringField(resObj, "status"), "error") {
					return "", errors.New(firstNonEmpty(extractStringField(resObj, "error", "message"), "CLI 返回错误"))
				}
				if r := extractStringField(resObj, "response", "result", "text", "content"); r != "" {
					lastResult = r
				}
			}
		} else if ev == "step_update" {
			if su, ok := obj["step_update"].(map[string]any); ok {
				if strings.EqualFold(extractStringField(su, "step_type"), "agent_response") {
					if d, okStr := su["text_delta"].(string); okStr && d != "" {
						streamParts = append(streamParts, d)
					}
				}
			}
		}
		typ := strings.ToLower(extractStringField(obj, "type"))
		switch typ {
		case "result":
			if r := extractStringField(obj, "result", "response", "text", "content"); r != "" {
				lastResult = r
			}
		case "text":
			if part, ok := obj["part"].(map[string]any); ok {
				if t := extractStringField(part, "text", "content"); t != "" {
					streamParts = append(streamParts, t)
				}
			} else if t := extractStringField(obj, "text", "content"); t != "" {
				streamParts = append(streamParts, t)
			}
		case "item.completed":
			if item, ok := obj["item"].(map[string]any); ok {
				if t := extractStringField(item, "text", "content", "message"); t != "" {
					lastResult = t
				}
			}
		case "message", "assistant":
			if t := extractMessageContent(obj); t != "" {
				lastResult = t
			}
		default:
			if r := extractStringField(obj, "result", "response"); r != "" {
				lastResult = r
			}
		}
	}
	if lastResult != "" {
		return lastResult, nil
	}
	if len(streamParts) > 0 {
		return strings.Join(streamParts, ""), nil
	}
	// If stdout contained non-JSON prefix logs followed by a final JSON object on its own line:
	for i := len(jsonLines) - 1; i >= 0; i-- {
		if text, isErr, errMsg, ok := parseSingleJSONObj([]byte(jsonLines[i])); ok {
			if isErr {
				return "", errors.New(firstNonEmpty(errMsg, "CLI 返回错误"))
			}
			if text != "" {
				return text, nil
			}
		}
	}

	// 3. Plain text fallback (e.g. --output-format text or custom CLIs).
	return cleaned, nil
}

func parseSingleJSONObj(b []byte) (text string, isErr bool, errMsg string, ok bool) {
	var obj map[string]any
	if err := json.Unmarshal(b, &obj); err != nil || obj == nil {
		return "", false, "", false
	}
	if v, exists := obj["is_error"].(bool); exists && v {
		return "", true, extractStringField(obj, "result", "error", "message"), true
	}
	if errObj, exists := obj["error"]; exists && errObj != nil {
		if s, okStr := errObj.(string); okStr && strings.TrimSpace(s) != "" {
			return "", true, strings.TrimSpace(s), true
		}
		if m, okMap := errObj.(map[string]any); okMap {
			if msg := extractStringField(m, "message", "error"); msg != "" {
				return "", true, msg, true
			}
		}
	}
	if t := extractStringField(obj, "result", "response", "text", "output", "content"); t != "" {
		return t, false, "", true
	}
	if t := extractMessageContent(obj); t != "" {
		return t, false, "", true
	}
	return "", false, "", false
}

func extractMessageContent(obj map[string]any) string {
	if msg, ok := obj["message"].(map[string]any); ok {
		if t := extractStringField(msg, "content", "text"); t != "" {
			return t
		}
		if arr, ok := msg["content"].([]any); ok {
			var parts []string
			for _, it := range arr {
				if mp, ok := it.(map[string]any); ok {
					if t := extractStringField(mp, "text", "content"); t != "" {
						parts = append(parts, t)
					}
				}
			}
			if len(parts) > 0 {
				return strings.Join(parts, "\n")
			}
		}
	}
	return ""
}

func extractStringField(obj map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := obj[k].(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)

func stripANSI(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func truncateErr(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > 360 {
		return string(r[:360]) + "…"
	}
	return s
}

type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.limit <= 0 {
		return b.buf.Write(p)
	}
	remain := b.limit - b.buf.Len()
	if remain > 0 {
		if len(p) > remain {
			_, _ = b.buf.Write(p[:remain])
		} else {
			_, _ = b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	return b.buf.String()
}
