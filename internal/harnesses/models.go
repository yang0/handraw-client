package harnesses

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ModelOption represents one selectable sub-model inside a local AI harness CLI.
type ModelOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

const modelListTTL = 15 * time.Minute

type cachedModelsEntry struct {
	models []ModelOption
	at     time.Time
}

var (
	modelCacheMu sync.RWMutex
	modelCache   = map[string]cachedModelsEntry{}
)

// PresetModels returns fast, zero-IO curated model options for a harness driver.
func PresetModels(driver string) []ModelOption {
	switch NormalizeDriver(driver) {
	case "agy":
		return []ModelOption{
			{ID: "gemini-3.8-flash-low", Label: "Gemini 3.8 Flash (Low · 极速)"},
			{ID: "gemini-3.8-flash-medium", Label: "Gemini 3.8 Flash (Medium)"},
			{ID: "gemini-4-carbon-medium", Label: "Gemini 4 Carbon (Medium)"},
			{ID: "gemini-4-neon-medium", Label: "Gemini 4 Neon (Medium)"},
			{ID: "gemini-4-neon-high", Label: "Gemini 4 Neon (High)"},
			{ID: "claude-sonnet-4-6", Label: "Claude Sonnet 4.6 (Thinking)"},
			{ID: "claude-opus-4-6-thinking", Label: "Claude Opus 4.6 (Thinking)"},
		}
	case "claude":
		return []ModelOption{
			{ID: "sonnet", Label: "Claude Sonnet（均衡推荐）"},
			{ID: "haiku", Label: "Claude Haiku（极速响应）"},
			{ID: "opus", Label: "Claude Opus（深度推理）"},
		}
	case "codex":
		return []ModelOption{
			{ID: "gpt-5.4", Label: "GPT-5.4"},
			{ID: "gpt-5.3-codex", Label: "GPT-5.3 Codex"},
			{ID: "gpt-5.2-codex", Label: "GPT-5.2 Codex"},
			{ID: "o3", Label: "o3"},
		}
	case "gemini":
		return []ModelOption{
			{ID: "gemini-2.5-flash", Label: "Gemini 2.5 Flash（快速）"},
			{ID: "gemini-2.5-pro", Label: "Gemini 2.5 Pro（深度）"},
		}
	case "opencode":
		return []ModelOption{
			{ID: "opencode/claude-sonnet-4-6", Label: "Claude Sonnet 4.6"},
			{ID: "opencode/claude-haiku-4-5", Label: "Claude Haiku 4.5"},
			{ID: "opencode/gemini-3.8-flash", Label: "Gemini 3.8 Flash"},
			{ID: "opencode/deepseek-v4.1-flash", Label: "DeepSeek V4.1 Flash"},
		}
	case "qwen":
		return []ModelOption{
			{ID: "qwen3-coder-plus", Label: "Qwen3 Coder Plus"},
			{ID: "qwen-max", Label: "Qwen Max"},
		}
	case "kimi":
		return []ModelOption{
			{ID: "kimi-k2", Label: "Kimi K2"},
		}
	default:
		return nil
	}
}

func mergeModelOptions(configured string, primary, fallback []ModelOption) []ModelOption {
	seen := map[string]bool{}
	var out []ModelOption
	add := func(m ModelOption) {
		id := strings.TrimSpace(m.ID)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		lbl := strings.TrimSpace(m.Label)
		if lbl == "" {
			lbl = id
		}
		out = append(out, ModelOption{ID: id, Label: lbl})
	}
	if cfg := strings.TrimSpace(configured); cfg != "" {
		foundLabel := cfg
		for _, m := range primary {
			if m.ID == cfg && m.Label != "" {
				foundLabel = m.Label
				break
			}
		}
		add(ModelOption{ID: cfg, Label: foundLabel})
	}
	for _, m := range primary {
		add(m)
	}
	if len(primary) == 0 {
		for _, m := range fallback {
			add(m)
		}
	}
	return out
}

// CachedOrPresetModels returns immediately without spawning subprocesses, used by Discover().
func CachedOrPresetModels(st Status) []ModelOption {
	key := st.ID + "|" + st.ResolvedPath
	modelCacheMu.RLock()
	ent, ok := modelCache[key]
	modelCacheMu.RUnlock()
	if ok && len(ent.models) > 0 {
		return mergeModelOptions(st.Model, ent.models, nil)
	}
	return mergeModelOptions(st.Model, nil, PresetModels(st.Driver))
}

// ListModels queries the harness CLI/config for real selectable models (with TTL cache + preset fallback).
func ListModels(ctx context.Context, st Status, forceRefresh bool) []ModelOption {
	key := st.ID + "|" + st.ResolvedPath
	if !forceRefresh {
		modelCacheMu.RLock()
		ent, ok := modelCache[key]
		modelCacheMu.RUnlock()
		if ok && time.Since(ent.at) < modelListTTL && len(ent.models) > 0 {
			return mergeModelOptions(st.Model, ent.models, nil)
		}
	}

	driver := NormalizeDriver(st.Driver)
	var live []ModelOption
	if st.Available && st.ResolvedPath != "" {
		switch driver {
		case "agy":
			live = probeAgyModels(ctx, st.ResolvedPath)
		case "opencode":
			live = probeOpenCodeModels(ctx, st.ResolvedPath)
		case "codex":
			live = probeCodexModels()
		}
	}
	if len(live) > 0 {
		modelCacheMu.Lock()
		modelCache[key] = cachedModelsEntry{models: live, at: time.Now()}
		modelCacheMu.Unlock()
	}
	return mergeModelOptions(st.Model, live, PresetModels(driver))
}

func runQuickProbe(ctx context.Context, bin string, args ...string) string {
	pCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(pCtx, bin, args...)
	configureCommand(cmd)
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "FORCE_COLOR=0", "CLICOLOR=0")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	_ = cmd.Run()
	return stripANSI(stdout.String())
}

// ParseAgyModelsOutput parses tab-separated `agy models` output (`id\tDisplay Name`).
func ParseAgyModelsOutput(raw string) []ModelOption {
	var out []ModelOption
	for _, ln := range strings.Split(raw, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "Fetching ") || strings.HasPrefix(ln, "Usage:") {
			continue
		}
		if id, lbl, ok := strings.Cut(ln, "\t"); ok {
			id = strings.TrimSpace(id)
			lbl = strings.TrimSpace(lbl)
			if id != "" && !strings.ContainsAny(id, " \t") {
				out = append(out, ModelOption{ID: id, Label: firstNonEmpty(lbl, id)})
			}
			continue
		}
		fields := strings.Fields(ln)
		if len(fields) >= 1 && strings.Contains(fields[0], "-") {
			lbl := strings.TrimSpace(strings.TrimPrefix(ln, fields[0]))
			out = append(out, ModelOption{ID: fields[0], Label: firstNonEmpty(lbl, fields[0])})
		}
	}
	return out
}

func probeAgyModels(ctx context.Context, bin string) []ModelOption {
	return ParseAgyModelsOutput(runQuickProbe(ctx, bin, "models"))
}

func probeOpenCodeModels(ctx context.Context, bin string) []ModelOption {
	raw := runQuickProbe(ctx, bin, "models")
	var out []ModelOption
	for _, ln := range strings.Split(raw, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || !strings.Contains(ln, "/") || strings.ContainsAny(ln, " \t") {
			continue
		}
		out = append(out, ModelOption{ID: ln, Label: ln})
		if len(out) >= 40 {
			break
		}
	}
	return out
}

var tomlModelRe = regexp.MustCompile(`(?m)^\s*model\s*=\s*["']([^"'\r\n]+)["']`)

func probeCodexModels() []ModelOption {
	presets := PresetModels("codex")
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		codexHome = homeJoin(".codex")
	}
	if codexHome == "" {
		return presets
	}
	b, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		return presets
	}
	m := tomlModelRe.FindSubmatch(b)
	if len(m) < 2 {
		return presets
	}
	cfgModel := strings.TrimSpace(string(m[1]))
	if cfgModel == "" {
		return presets
	}
	return mergeModelOptions(cfgModel, nil, presets)
}
