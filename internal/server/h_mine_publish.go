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

// minePublish publishes a personal style/layout to the website community (#162).
// Community styles & layouts must be paid (>= 1 point, custom 1..500) and hide
// their feature prompts on the server. Cover & description are optional when
// already synced on the resource.
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
	if body.Price < 1 {
		return nil, bad("画风和图型不允许免费分享，最低 1 积分")
	}
	if body.Price > 500 {
		return nil, bad("画风和图型定价最高 500 积分")
	}
	body.Description = strings.TrimSpace(body.Description)
	if body.Description != "" {
		if n := len([]rune(body.Description)); n < 8 || n > 300 {
			return nil, bad("若填写公开简介，需要 8 到 300 字（请勿填写特征提示词）")
		}
	}
	if body.Cover != "" && !strings.HasPrefix(body.Cover, "data:image/") {
		return nil, bad("封面图格式无效")
	}
	if len(body.Images) > 9 {
		return nil, bad("示例图最多 9 张")
	}
	if prev := s.publishedState(docID); prev != nil {
		return map[string]any{"ok": true, "published": prev, "idempotent": true}, nil
	}
	doc, err := s.DB.GetDoc(kind, docID)
	if err != nil {
		return nil, bad("找不到这个自建资源")
	}
	// Publishing needs the latest definition & cover on the website first.
	if doc.Dirty || doc.RemoteID == "" {
		if _, err := s.syncResourcesInternal(r.Context()); err != nil {
			return nil, err
		}
		if doc, err = s.DB.GetDoc(kind, docID); err != nil || doc.RemoteID == "" || doc.Dirty {
			return nil, bad("资源还没同步到网站（可能存在版本冲突），请先在「我的」里点同步后再发布")
		}
	}
	payload := map[string]any{"price": body.Price}
	if body.Description != "" {
		payload["description"] = body.Description
	}
	if body.Cover != "" {
		payload["cover"] = body.Cover
	}
	if len(body.Images) > 0 {
		payload["images"] = body.Images
	}
	raw, err := s.Site.Send(r.Context(), "POST", "/api/v1/me/resources/"+doc.RemoteID+"/publish", payload)
	if err != nil {
		var ae *site.APIError
		if errors.As(err, &ae) && ae.Status == 403 && ae.Code != "price_above_level_cap" {
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
	s.invalidateCommunityCache()
	s.Emit("resource_published", map[string]any{"id": docID})
	return map[string]any{"ok": true, "published": res.Published, "siteBase": s.Site.Base()}, nil
}
