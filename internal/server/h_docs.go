package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/store"
)

type workflowTemplate struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Desc  string `json:"desc"`
	Nodes []any  `json:"nodes"`
	Edges []any  `json:"edges"`
}

func builtinTemplates() []workflowTemplate {
	return []workflowTemplate{
		{
			ID:   "tpl_char_scenes",
			Name: "固定角色多场景连载",
			Desc: "1 张角色参考图（锁定五官特征）× 4 个连载场景，批量保持 IP 角色一致性",
			Nodes: []any{
				map[string]any{
					"id": "ref_char", "type": "reference", "title": "主角参考图", "refMode": "bundle", "x": 36, "y": 36,
					"refs": []any{},
					"defaultRole": "角色长相",
					"defaultNote": "保持主角五官、发型与核心服饰特征一致",
				},
				map[string]any{
					"id": "params", "type": "parameters", "mode": "cartesian", "x": 36, "y": 290,
					"fieldOrder": []string{"prompt", "style1", "layout", "ratio"},
					"fields": map[string]any{
						"prompt": []string{
							"主角清晨在街角咖啡馆窗边手冲咖啡，阳光洒在木桌上",
							"主角午后在公园长椅上看书，微风吹起围巾",
							"主角傍晚骑着复古自行车穿过梧桐树影",
							"主角夜晚在暖黄台灯下画手账，窗外下着小雨",
						},
						"style1": []string{"FA-013"},
						"layout": []string{""},
						"ratio":  []string{"3:4"},
					},
				},
				map[string]any{"id": "output", "type": "output", "mode": "cartesian", "repeat": 1, "resolution": "2k", "x": 492, "y": 170},
			},
			Edges: []any{
				map[string]any{"id": "e1", "from": "ref_char", "to": "output"},
				map[string]any{"id": "e2", "from": "params", "to": "output"},
			},
		},
		{
			ID:   "tpl_multi_ref_fusion",
			Name: "多图元素融合创作",
			Desc: "参考图 A（角色长相）+ 参考图 B（构图姿势/服装）自动按图序合并注入，实现多参考图精准融合",
			Nodes: []any{
				map[string]any{
					"id": "ref_a", "type": "reference", "title": "参考图 A · 角色", "refMode": "bundle", "x": 36, "y": 36,
					"refs": []any{}, "defaultRole": "角色长相", "defaultNote": "保留人物脸型、神态与发型",
				},
				map[string]any{
					"id": "ref_b", "type": "reference", "title": "参考图 B · 姿势/穿搭", "refMode": "variants", "x": 36, "y": 280,
					"refs": []any{}, "defaultRole": "构图姿势", "defaultNote": "参考动作姿态与画面机位，不照搬背景",
				},
				map[string]any{
					"id": "params", "type": "parameters", "mode": "cartesian", "x": 36, "y": 520,
					"fieldOrder": []string{"prompt", "style1", "ratio"},
					"fields": map[string]any{
						"prompt": []string{"秋日复古书店门前的日常插画，自然温暖光影"},
						"style1": []string{"FA-013"},
						"ratio":  []string{"3:4"},
					},
				},
				map[string]any{"id": "comb", "type": "combine", "mode": "cartesian", "x": 460, "y": 240},
				map[string]any{"id": "output", "type": "output", "mode": "cartesian", "repeat": 1, "resolution": "2k", "x": 800, "y": 240},
			},
			Edges: []any{
				map[string]any{"id": "e1", "from": "ref_a", "to": "comb"},
				map[string]any{"id": "e2", "from": "ref_b", "to": "comb"},
				map[string]any{"id": "e3", "from": "params", "to": "comb"},
				map[string]any{"id": "e4", "from": "comb", "to": "output"},
			},
		},
		{
			ID:   "tpl_style_matrix",
			Name: "多画风横评对比矩阵",
			Desc: "2 个主题 × 3 种画风笛卡尔积对比不同视觉方案，快速筛选最佳风格",
			Nodes: []any{
				map[string]any{
					"id": "params", "type": "parameters", "mode": "cartesian", "x": 36, "y": 48,
					"fieldOrder": []string{"prompt", "style1", "ratio"},
					"fields": map[string]any{
						"prompt": []string{"雨夜街角亮着暖灯的小书店", "周末公园草地上打盹的橘猫"},
						"style1": []string{"FA-013", "FB-001", "FE-001"},
						"ratio":  []string{"3:4"},
					},
				},
				map[string]any{"id": "output", "type": "output", "mode": "cartesian", "repeat": 1, "resolution": "1k", "x": 492, "y": 130},
			},
			Edges: []any{
				map[string]any{"id": "e1", "from": "params", "to": "output"},
			},
		},
		{
			ID:   "tpl_xhs_6",
			Name: "小红书 6 图干货套图",
			Desc: "统一画风与 3:4 图型 × 6 节分镜主题，一键批量生成小红书图文卡",
			Nodes: []any{
				map[string]any{
					"id": "params", "type": "parameters", "mode": "cartesian", "x": 36, "y": 48,
					"fieldOrder": []string{"prompt", "style1", "layout", "ratio", "mode"},
					"fields": map[string]any{
						"prompt": []string{
							"封面：晨间手冲咖啡指南",
							"1. 挑选新鲜浅烘豆",
							"2. 磨豆粗细度对比",
							"3. 92度水温控制",
							"4. 三段式注水节奏",
							"5. 常见萃取翻车避坑",
						},
						"style1": []string{"FA-001"},
						"layout": []string{"SC-008"},
						"ratio":  []string{"3:4"},
						"mode":   []string{"graphic-text"},
					},
				},
				map[string]any{"id": "output", "type": "output", "mode": "cartesian", "repeat": 1, "resolution": "2k", "x": 492, "y": 140},
			},
			Edges: []any{
				map[string]any{"id": "e1", "from": "params", "to": "output"},
			},
		},
	}
}

func (s *Server) docList(w http.ResponseWriter, r *http.Request) (any, error) {
	kind := r.PathValue("kind")
	docs, err := s.DB.ListDocs(kind, false)
	if err != nil {
		return nil, err
	}
	if kind == "template" {
		return map[string]any{"items": docs, "builtin": builtinTemplates()}, nil
	}
	return map[string]any{"items": docs}, nil
}

func (s *Server) docGet(w http.ResponseWriter, r *http.Request) (any, error) {
	kind, id := r.PathValue("kind"), r.PathValue("id")
	if kind == "template" {
		for _, t := range builtinTemplates() {
			if t.ID == id {
				b, _ := json.Marshal(t)
				return map[string]any{"doc": store.Doc{Kind: "template", ID: t.ID, Name: t.Name, Data: b}}, nil
			}
		}
	}
	doc, err := s.DB.GetDoc(kind, id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"doc": doc}, nil
}

func (s *Server) docPut(w http.ResponseWriter, r *http.Request) (any, error) {
	kind, id := r.PathValue("kind"), r.PathValue("id")
	if id == "" || id == "new" {
		id = jobs.NewID(kind)
	}
	var body struct {
		Name string          `json:"name"`
		Data json.RawMessage `json:"data"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	doc := store.Doc{Kind: kind, ID: id, Name: body.Name, Data: body.Data, Dirty: true}
	if old, err := s.DB.GetDoc(kind, id); err == nil {
		doc.CreatedAt = old.CreatedAt
		doc.RemoteID = old.RemoteID
		doc.RemoteRev = old.RemoteRev
	}
	if err := s.DB.PutDoc(&doc); err != nil {
		return nil, err
	}
	return map[string]any{"doc": doc}, nil
}

func (s *Server) docDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	kind, id := r.PathValue("kind"), r.PathValue("id")
	if doc, err := s.DB.GetDoc(kind, id); err == nil && doc.RemoteID != "" {
		doc.Deleted = true
		doc.Dirty = true
		_ = s.DB.PutDoc(&doc)
	} else {
		_ = s.DB.DeleteDocHard(kind, id)
	}
	return okv, nil
}

func (s *Server) canvasSync(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, bad("请先登录账号再同步画布")
	}
	var body struct {
		ID string `json:"id"`
	}
	_ = decode(r, &body)

	// Push local dirty canvases first, then pull remote summary/details.
	docs, _ := s.DB.ListDocs("canvas", false)
	var conflicts []map[string]any
	pushed := 0
	for _, d := range docs {
		if body.ID != "" && d.ID != body.ID {
			continue
		}
		if !d.Dirty && d.RemoteID != "" {
			continue
		}
		payload := map[string]any{
			"id":       d.RemoteID,
			"title":    firstStr(d.Name, "未命名画布"),
			"graph":    d.Data,
			"revision": d.RemoteRev,
		}
		endpoint := "/api/studio/canvases"
		if d.RemoteID != "" {
			endpoint += "/" + url.PathEscape(d.RemoteID)
		}
		raw, err := s.Site.Send(r.Context(), "POST", endpoint, payload)
		if err != nil {
			if strings.Contains(err.Error(), "409") {
				conflicts = append(conflicts, map[string]any{"id": d.ID, "name": d.Name, "error": err.Error()})
				continue
			}
			return map[string]any{"ok": false, "pushed": pushed, "error": err.Error(), "conflicts": conflicts}, nil
		}
		var resp struct {
			Canvas struct {
				ID       string `json:"id"`
				Revision int    `json:"revision"`
			} `json:"canvas"`
			ID       string `json:"id"`
			Revision int    `json:"revision"`
		}
		if json.Unmarshal(raw, &resp) == nil {
			rid := firstStr(resp.Canvas.ID, resp.ID, d.ID)
			rev := resp.Canvas.Revision
			if rev == 0 {
				rev = resp.Revision
			}
			d.RemoteID = rid
			d.RemoteRev = rev
			d.Dirty = false
			_ = s.DB.PutDoc(&d)
			pushed++
		}
	}
	remoteRaw, err := s.Site.Get(r.Context(), "/api/studio/canvases")
	if err != nil {
		return map[string]any{"ok": true, "pushed": pushed, "conflicts": conflicts, "pullError": err.Error()}, nil
	}
	return map[string]any{"ok": true, "pushed": pushed, "conflicts": conflicts, "remote": remoteRaw}, nil
}
