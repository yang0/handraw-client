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
			ID: "tpl_xhs_6", Name: "小红书 6 图干货套图", Desc: "1 个配方 × 6 个分节主题自动展开生成 6 张 3:4 图文卡",
			Nodes: []any{
				map[string]any{"id": "n1", "type": "recipe", "x": 80, "y": 140, "data": map[string]any{"style": "FA-001", "layout": "SC-008", "ratio": "3:4", "label": "小红书 3:4 干货图"}},
				map[string]any{"id": "n2", "type": "themes", "x": 80, "y": 320, "data": map[string]any{"label": "6 张分节主题", "items": []string{"封面：晨间手冲咖啡指南", "1. 挑选新鲜浅烘豆", "2. 磨豆粗细度对比", "3. 92度水温控制", "4. 三段式注水节奏", "5. 常见萃取翻车避坑"}}},
				map[string]any{"id": "n3", "type": "generate", "x": 420, "y": 210, "data": map[string]any{"label": "批量生成 6 张", "count": 1}},
				map[string]any{"id": "n4", "type": "export", "x": 740, "y": 210, "data": map[string]any{"label": "小红书格式导出", "format": "xiaohongshu"}},
			},
			Edges: []any{
				map[string]any{"id": "e1", "from": "n1", "to": "n3"},
				map[string]any{"id": "e2", "from": "n2", "to": "n3"},
				map[string]any{"id": "e3", "from": "n3", "to": "n4"},
			},
		},
		{
			ID: "tpl_ip_sheet", Name: "IP 角色三视图与表情包", Desc: "锁定角色描述，展开正面/侧面/背面及三款表情动作",
			Nodes: []any{
				map[string]any{"id": "n1", "type": "recipe", "x": 80, "y": 140, "data": map[string]any{"style": "FA-013", "layout": "IP-001", "ratio": "3:4", "label": "IP 设定配方"}},
				map[string]any{"id": "n2", "type": "themes", "x": 80, "y": 320, "data": map[string]any{"label": "角色视角", "items": []string{"戴圆眼镜的橘猫店员 · 正面全身三视图", "戴圆眼镜的橘猫店员 · 侧面与背面细节", "戴圆眼镜的橘猫店员 · 开心/困倦/惊讶表情"}}},
				map[string]any{"id": "n3", "type": "generate", "x": 420, "y": 210, "data": map[string]any{"label": "生成角色设定集", "count": 1}},
			},
			Edges: []any{
				map[string]any{"id": "e1", "from": "n1", "to": "n3"},
				map[string]any{"id": "e2", "from": "n2", "to": "n3"},
			},
		},
		{
			ID: "tpl_style_matrix", Name: "多画风横评矩阵", Desc: "2 个主题 × 3 种画风笛卡尔积对比不同视觉方案",
			Nodes: []any{
				map[string]any{"id": "n1", "type": "themes", "x": 80, "y": 120, "data": map[string]any{"label": "主题列表", "items": []string{"雨夜街角亮着暖灯的小书店", "周末公园草地上打盹的柴犬"}}},
				map[string]any{"id": "n2", "type": "styles", "x": 80, "y": 320, "data": map[string]any{"label": "候选画风", "items": []string{"FA-013", "FB-001", "FE-001"}}},
				map[string]any{"id": "n3", "type": "generate", "x": 420, "y": 210, "data": map[string]any{"label": "交叉生成 6 张对比", "count": 1}},
			},
			Edges: []any{
				map[string]any{"id": "e1", "from": "n1", "to": "n3"},
				map[string]any{"id": "e2", "from": "n2", "to": "n3"},
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
