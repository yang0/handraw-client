package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

// publishStateKind stores the community publish state of a personal resource
// next to it, without touching the resource document itself (a pull from the
// website replaces that document).
const publishStateKind = "resource_publish"

func (s *Server) publishedState(docID string) json.RawMessage {
	if d, err := s.DB.GetDoc(publishStateKind, docID); err == nil && len(d.Data) > 2 {
		return d.Data
	}
	return nil
}

// minePublish publishes a personal style/layout to the website community
// (handraw-web docs/sharing-v2.md §2.1). Free resources go live at once; paid
// ones wait for the community jury. The UI sends a square WebP cover and 2–9
// WebP examples.
func (s *Server) minePublish(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	kind := normMineKind(r.PathValue("kind"))
	if kind != "style" && kind != "layout" {
		return nil, bad("只能发布画风或图型")
	}
	docID := r.PathValue("id")
	var body struct {
		Price       int      `json:"price"`
		Description string   `json:"description"`
		Cover       string   `json:"cover"`
		Images      []string `json:"images"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	body.Description = strings.TrimSpace(body.Description)
	if n := len([]rune(body.Description)); n < 8 || n > 300 {
		return nil, bad("简介需要 8 到 300 字，说清这个画风/图型适合什么")
	}
	if !strings.HasPrefix(body.Cover, "data:image/") {
		return nil, bad("请选择一张封面图")
	}
	if len(body.Images) < 2 || len(body.Images) > 9 {
		return nil, bad("请再选择 2 到 9 张示例图（加封面共至少 3 张）")
	}
	if prev := s.publishedState(docID); prev != nil {
		return map[string]any{"ok": true, "published": prev, "idempotent": true}, nil
	}
	doc, err := s.DB.GetDoc(kind, docID)
	if err != nil {
		return nil, bad("找不到这个自建资源")
	}
	// Publishing needs the latest definition on the website first.
	if doc.Dirty || doc.RemoteID == "" {
		if _, err := s.syncResourcesInternal(r.Context()); err != nil {
			return nil, err
		}
		if doc, err = s.DB.GetDoc(kind, docID); err != nil || doc.RemoteID == "" || doc.Dirty {
			return nil, bad("资源还没同步到网站（可能存在版本冲突），请先在「我的」里点同步后再发布")
		}
	}
	raw, err := s.Site.Send(r.Context(), "POST", "/api/v1/me/resources/"+doc.RemoteID+"/publish", map[string]any{
		"price": body.Price, "description": body.Description, "cover": body.Cover, "images": body.Images,
	})
	if err != nil {
		var ae *site.APIError
		if errors.As(err, &ae) && ae.Status == 403 {
			return nil, &apiError{Status: 403, Code: "scope_required", Msg: "当前登录授权不包含发布权限，请在设置里退出后重新登录手绘风账号"}
		}
		return nil, err
	}
	var res struct {
		Published json.RawMessage `json:"published"`
	}
	if json.Unmarshal(raw, &res) != nil || len(res.Published) < 3 {
		return nil, errors.New("网站没有返回发布结果，请稍后在网站上确认")
	}
	_ = s.DB.PutDoc(&store.Doc{Kind: publishStateKind, ID: docID, Name: doc.Name, Data: res.Published})
	s.Emit("resource_published", map[string]any{"id": docID})
	return map[string]any{"ok": true, "published": res.Published, "siteBase": s.Site.Base()}, nil
}
