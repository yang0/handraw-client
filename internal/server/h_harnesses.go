package server

import (
	"context"
	"net/http"
	"strings"

	"github.com/yang0/handraw-client/internal/harnesses"
	"github.com/yang0/handraw-client/internal/providers"
	"github.com/yang0/handraw-client/internal/settings"
)

type harnessSceneSpec struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

var harnessScenes = []harnessSceneSpec{
	{Key: "articleEdit", Label: "文章撰稿与改稿", Description: "「文章配图」右侧 AI 写作助手写稿、润色、局部改写与诊断"},
	{Key: "articlePlan", Label: "文章配图规划", Description: "读取正文并自动规划封面与正文插图位、提示词"},
	{Key: "chat", Label: "聊天工作台", Description: "「聊天」页面的对话与创意规划引擎"},
	{Key: "studioPlan", Label: "生图与系列规划", Description: "生图工作台多图规划、主题扩写与系列图分镜拆解"},
	{Key: "canvas", Label: "画布助手", Description: "自由画布中按一句话自动搭建节点工作流"},
}

func isKnownHarnessScene(k string) bool {
	for _, sc := range harnessScenes {
		if sc.Key == k {
			return true
		}
	}
	return false
}

func (s *Server) callHarnessText(ctx context.Context, route aiRoute, msgs []providers.ChatMessage, jsonMode bool) (harnesses.ChatResult, error) {
	hMsgs := make([]harnesses.Message, 0, len(msgs))
	for _, m := range msgs {
		hMsgs = append(hMsgs, harnesses.Message{Role: m.Role, Content: m.Content})
	}
	return harnesses.Chat(ctx, route.Harness, harnesses.ChatRequest{
		Messages: hMsgs,
		JSONMode: jsonMode,
		Model:    route.HarnessSubModel,
	})
}

func (s *Server) harnessesList(w http.ResponseWriter, r *http.Request) (any, error) {
	if q := strings.TrimSpace(r.URL.Query().Get("rescan")); q == "1" || strings.EqualFold(q, "true") {
		harnesses.Rescan()
	}
	st := settings.Get()
	return map[string]any{
		"items":            harnesses.Discover(st.Harnesses),
		"sceneModels":      st.SceneModels,
		"scenes":           harnessScenes,
		"defaultTextModel": st.DefaultTextModel,
	}, nil
}

func (s *Server) harnessesRescan(w http.ResponseWriter, r *http.Request) (any, error) {
	harnesses.Rescan()
	st := settings.Get()
	items := harnesses.Discover(st.Harnesses)
	detected := 0
	for _, it := range items {
		if it.Detected {
			detected++
		}
	}
	return map[string]any{
		"ok":               true,
		"detectedCount":    detected,
		"items":            items,
		"sceneModels":      st.SceneModels,
		"scenes":           harnessScenes,
		"defaultTextModel": st.DefaultTextModel,
	}, nil
}

func (s *Server) harnessPut(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.ToLower(strings.TrimSpace(r.PathValue("id")))
	var body struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		Driver     string   `json:"driver"`
		Enabled    *bool    `json:"enabled"`
		Command    string   `json:"command"`
		Model      string   `json:"model"`
		ExtraArgs  []string `json:"extraArgs"`
		WorkDir    string   `json:"workDir"`
		TimeoutSec int      `json:"timeoutSec"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if id == "" {
		id = strings.ToLower(strings.TrimSpace(body.ID))
	}
	if !harnesses.ValidID(id) {
		return nil, bad("Harness ID 无效（仅支持小写字母、数字、短横线、下划线）")
	}

	isBuiltin := false
	builtinDriver := ""
	for _, sp := range harnesses.BuiltinSpecs() {
		if sp.ID == id {
			isBuiltin = true
			builtinDriver = sp.Driver
			break
		}
	}

	if !isBuiltin && strings.TrimSpace(body.Command) == "" {
		return nil, bad("自定义 Harness 必须填写可执行命令或路径")
	}

	driver := builtinDriver
	if strings.TrimSpace(body.Driver) != "" || !isBuiltin {
		driver = harnesses.NormalizeDriver(firstStr(body.Driver, builtinDriver, "custom"))
	}

	cfg := harnesses.Config{
		ID:         id,
		Name:       strings.TrimSpace(body.Name),
		Driver:     driver,
		Enabled:    body.Enabled,
		Command:    strings.TrimSpace(body.Command),
		Model:      strings.TrimSpace(body.Model),
		ExtraArgs:  body.ExtraArgs,
		WorkDir:    strings.TrimSpace(body.WorkDir),
		TimeoutSec: body.TimeoutSec,
		Custom:     !isBuiltin,
	}

	updated, err := settings.Update(func(st *settings.Settings) error {
		replaced := false
		for i := range st.Harnesses {
			if strings.EqualFold(st.Harnesses[i].ID, id) {
				st.Harnesses[i] = cfg
				replaced = true
				break
			}
		}
		if !replaced {
			st.Harnesses = append(st.Harnesses, cfg)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	stOne, _ := harnesses.Find(updated.Harnesses, id)
	return map[string]any{
		"ok":      true,
		"harness": stOne,
		"items":   harnesses.Discover(updated.Harnesses),
	}, nil
}

func (s *Server) harnessDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.ToLower(strings.TrimSpace(r.PathValue("id")))
	if id == "" {
		return nil, bad("缺少 Harness ID")
	}
	isBuiltin := false
	for _, sp := range harnesses.BuiltinSpecs() {
		if sp.ID == id {
			isBuiltin = true
			break
		}
	}
	updated, err := settings.Update(func(st *settings.Settings) error {
		next := make([]harnesses.Config, 0, len(st.Harnesses))
		for _, c := range st.Harnesses {
			if !strings.EqualFold(c.ID, id) {
				next = append(next, c)
			}
		}
		st.Harnesses = next
		if !isBuiltin {
			prefix := "harness:" + id
			if strings.EqualFold(st.DefaultTextModel, prefix) || strings.HasPrefix(strings.ToLower(st.DefaultTextModel), prefix+":") {
				st.DefaultTextModel = ""
			}
			for k, v := range st.SceneModels {
				if strings.EqualFold(v, prefix) || strings.HasPrefix(strings.ToLower(v), prefix+":") {
					delete(st.SceneModels, k)
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":          true,
		"reset":       isBuiltin,
		"items":       harnesses.Discover(updated.Harnesses),
		"sceneModels": updated.SceneModels,
	}, nil
}

func (s *Server) harnessTest(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.ToLower(strings.TrimSpace(r.PathValue("id")))
	if id == "" {
		return nil, bad("缺少 Harness ID")
	}
	var body struct {
		Command    string   `json:"command"`
		Driver     string   `json:"driver"`
		Model      string   `json:"model"`
		ExtraArgs  []string `json:"extraArgs"`
		WorkDir    string   `json:"workDir"`
		TimeoutSec int      `json:"timeoutSec"`
		Prompt     string   `json:"prompt"`
	}
	_ = decode(r, &body)

	stSettings := settings.Get()
	configs := append([]harnesses.Config{}, stSettings.Harnesses...)
	if strings.TrimSpace(body.Command) != "" || strings.TrimSpace(body.Model) != "" || len(body.ExtraArgs) > 0 || strings.TrimSpace(body.WorkDir) != "" || body.TimeoutSec > 0 {
		enabled := true
		override := harnesses.Config{
			ID:         id,
			Driver:     body.Driver,
			Enabled:    &enabled,
			Command:    body.Command,
			Model:      body.Model,
			ExtraArgs:  body.ExtraArgs,
			WorkDir:    body.WorkDir,
			TimeoutSec: body.TimeoutSec,
		}
		merged := false
		for i := range configs {
			if strings.EqualFold(configs[i].ID, id) {
				if override.Command != "" {
					configs[i].Command = override.Command
				}
				if override.Driver != "" {
					configs[i].Driver = override.Driver
				}
				if override.Model != "" {
					configs[i].Model = override.Model
				}
				if len(override.ExtraArgs) > 0 {
					configs[i].ExtraArgs = override.ExtraArgs
				}
				if override.WorkDir != "" {
					configs[i].WorkDir = override.WorkDir
				}
				if override.TimeoutSec > 0 {
					configs[i].TimeoutSec = override.TimeoutSec
				}
				configs[i].Enabled = &enabled
				merged = true
				break
			}
		}
		if !merged {
			configs = append(configs, override)
		}
	}

	hst, ok := harnesses.Find(configs, id)
	if !ok {
		return map[string]any{"ok": false, "error": "找不到指定的本地 Harness：" + id}, nil
	}
	// Allow testing even when currently toggled off in settings.
	hst.Enabled = true
	hst.Available = hst.Detected

	testPrompt := firstStr(strings.TrimSpace(body.Prompt), "请仅回复两个字母：OK")
	res, err := harnesses.Chat(r.Context(), hst, harnesses.ChatRequest{
		Messages: []harnesses.Message{{Role: "user", Content: testPrompt}},
	})
	if err != nil {
		return map[string]any{
			"ok":           false,
			"error":        err.Error(),
			"resolvedPath": hst.ResolvedPath,
			"driver":       hst.Driver,
		}, nil
	}
	return map[string]any{
		"ok":           true,
		"text":         res.Text,
		"elapsedMs":    res.ElapsedMs,
		"resolvedPath": hst.ResolvedPath,
		"driver":       res.Driver,
		"model":        res.Model,
	}, nil
}
