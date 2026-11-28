package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/site"
)

const (
	communityCatalogCacheKey = "community_resources_v2"
	communityCatalogTTL      = 2 * time.Minute
)

type communityRemoteItem struct {
	ID            string `json:"id"`
	Code          string `json:"code"`
	Kind          string `json:"kind"`
	SourceType    string `json:"sourceType"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Image         string `json:"image"`
	Author        string `json:"author"`
	AuthorName    string `json:"authorName"`
	UnlockCost    int    `json:"unlockCost"`
	Unlocked      bool   `json:"unlocked"`
	IsMine        bool   `json:"isMine"`
	PromptHidden  bool   `json:"promptHidden"`
	SiteModelOnly bool   `json:"siteModelOnly"`
	// Owner-only: the personal resource this item was published from (#170).
	PersonalResourceID string `json:"personalResourceId"`
}

type communityCatalogSnapshot struct {
	Styles  []resources.Style  `json:"styles"`
	Layouts []resources.Layout `json:"layouts"`
}

type protectedResourceMeta struct {
	Code       string
	Kind       string
	Name       string
	Image      string
	UnlockCost int
	Unlocked   bool
	IsMine     bool
	Known      bool
}

func communityThumbProxyURL(rawImage string) string {
	img := strings.TrimSpace(rawImage)
	if img == "" {
		return ""
	}
	if strings.HasPrefix(img, "/files/remote") || strings.HasPrefix(img, "data:") {
		return img
	}
	return "/files/remote?url=" + url.QueryEscape(img) + "&w=480"
}

func looksLikeProtectedCode(code string) bool {
	u := strings.ToUpper(strings.TrimSpace(code))
	if u == "" {
		return false
	}
	for _, prefix := range []string{"CS-", "CL-", "FX-", "LX-", "USR-"} {
		if strings.HasPrefix(u, prefix) {
			return true
		}
	}
	return false
}

func (s *Server) invalidateCommunityCache() {
	s.cacheMu.Lock()
	for k := range s.cache {
		if strings.HasPrefix(k, communityCatalogCacheKey) {
			delete(s.cache, k)
		}
	}
	s.cacheMu.Unlock()
}

func (s *Server) communityCatalog(ctx context.Context, force bool) communityCatalogSnapshot {
	if s.Site == nil {
		return communityCatalogSnapshot{}
	}
	cacheKey := communityCatalogCacheKey + ":" + s.Site.Base() + ":" + s.Site.TokenFingerprint()
	if !force {
		if raw, ok := s.getMarketCache(cacheKey, communityCatalogTTL); ok {
			var snap communityCatalogSnapshot
			if json.Unmarshal(raw, &snap) == nil {
				return snap
			}
		}
	}

	fetchCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	var resp struct {
		OK    bool                  `json:"ok"`
		Items []communityRemoteItem `json:"items"`
	}
	var err error
	loggedIn := s.Site.LoggedIn()
	if loggedIn {
		err = s.Site.Do(fetchCtx, http.MethodGet, "/api/v1/community/resources", nil, &resp)
	} else {
		err = s.Site.Public(fetchCtx, http.MethodGet, "/api/v1/community/resources", nil, &resp)
	}
	unauthFallback := false
	if err != nil {
		// Fallback to public /api/boot?surface=catalog if /api/v1/community/resources fails.
		// Never attach a desktop hwt_ token to /api/boot because /api/boot is web-session-only
		// and rejects hwt_ tokens with 403 token_scope_denied (#187).
		// Never cache this unauthenticated fallback under a logged-in key (#207).
		unauthFallback = loggedIn
		var boot struct {
			CommunityResources []communityRemoteItem `json:"communityResources"`
			ExclusiveResources []communityRemoteItem `json:"exclusiveResources"`
			UnlockedIds        []string              `json:"unlockedIds"`
			User               struct {
				Username string `json:"username"`
			} `json:"user"`
		}
		err = s.Site.Public(fetchCtx, http.MethodGet, "/api/boot?surface=catalog", nil, &boot)
		if err != nil {
			if raw, ok := s.getMarketCache(cacheKey, 24*time.Hour); ok {
				var stale communityCatalogSnapshot
				if json.Unmarshal(raw, &stale) == nil {
					return stale
				}
			}
			return communityCatalogSnapshot{}
		}
		unlockedMap := map[string]bool{}
		for _, id := range boot.UnlockedIds {
			unlockedMap[strings.ToUpper(strings.TrimSpace(id))] = true
		}
		for _, it := range append(boot.CommunityResources, boot.ExclusiveResources...) {
			code := strings.ToUpper(strings.TrimSpace(firstStr(it.Code, it.ID)))
			if it.SourceType == "" {
				it.SourceType = "community"
			}
			if boot.User.Username != "" && strings.EqualFold(it.Author, boot.User.Username) {
				it.IsMine = true
			}
			if it.IsMine || unlockedMap[code] {
				it.Unlocked = true
			}
			if it.SourceType == "community" && it.UnlockCost < 1 {
				it.UnlockCost = 1
			}
			it.PromptHidden = true
			it.SiteModelOnly = true
			resp.Items = append(resp.Items, it)
		}
	}

	snap := communityCatalogSnapshot{
		Styles:  make([]resources.Style, 0),
		Layouts: make([]resources.Layout, 0),
	}
	for _, it := range resp.Items {
		code := strings.TrimSpace(firstStr(it.Code, it.ID))
		if code == "" {
			continue
		}
		src := firstStr(strings.TrimSpace(it.SourceType), "community")
		cost := it.UnlockCost
		if src == "community" && cost < 1 {
			cost = 1
		}
		imgURL := communityThumbProxyURL(it.Image)
		if it.Kind == "layout" {
			snap.Layouts = append(snap.Layouts, resources.Layout{
				ID:                 code,
				Category:           "community",
				Name:               firstStr(it.Name, code),
				Image:              imgURL,
				RemoteImageURL:     strings.TrimSpace(it.Image),
				Description:        strings.TrimSpace(it.Description),
				PromptZh:           "", // NEVER store or expose community prompts (#162)
				PromptEn:           "",
				Author:             strings.TrimSpace(it.Author),
				AuthorName:         firstStr(strings.TrimSpace(it.AuthorName), strings.TrimSpace(it.Author)),
				Source:             src,
				UnlockCost:         cost,
				Unlocked:           it.Unlocked || it.IsMine,
				IsMine:             it.IsMine,
				PromptHidden:       true,
				SiteModelOnly:      true,
				PersonalResourceID: strings.TrimSpace(it.PersonalResourceID),
			})
		} else {
			snap.Styles = append(snap.Styles, resources.Style{
				Number:             code,
				Group:              "USR 社区共享画风 / Community",
				GroupCode:          "USR",
				GroupZh:            "社区共享",
				GroupEn:            "Community",
				GenerationName:     firstStr(it.Name, code),
				NameZh:             firstStr(it.Name, code),
				Description:        strings.TrimSpace(it.Description),
				Traits:             "", // NEVER store or expose community prompts (#162)
				TraitsEn:           "",
				Image:              imgURL,
				RemoteImageURL:     strings.TrimSpace(it.Image),
				Author:             strings.TrimSpace(it.Author),
				AuthorName:         firstStr(strings.TrimSpace(it.AuthorName), strings.TrimSpace(it.Author)),
				Source:             src,
				UnlockCost:         cost,
				Unlocked:           it.Unlocked || it.IsMine,
				IsMine:             it.IsMine,
				PromptHidden:       true,
				SiteModelOnly:      true,
				PersonalResourceID: strings.TrimSpace(it.PersonalResourceID),
			})
		}
	}
	if !unauthFallback {
		if b, err := json.Marshal(snap); err == nil {
			s.setMarketCache(cacheKey, b)
		}
	}
	return snap
}

func (s *Server) findCommunityStyle(ctx context.Context, id string) (resources.Style, bool) {
	return s.findCommunityStyleWithRefresh(ctx, id, false)
}

func (s *Server) findCommunityStyleWithRefresh(ctx context.Context, id string, force bool) (resources.Style, bool) {
	want := strings.ToUpper(strings.TrimSpace(id))
	if want == "" {
		return resources.Style{}, false
	}
	snap := s.communityCatalog(ctx, force)
	for _, st := range snap.Styles {
		if strings.EqualFold(st.Number, want) {
			return st, true
		}
	}
	return resources.Style{}, false
}

func (s *Server) findCommunityLayout(ctx context.Context, id string) (resources.Layout, bool) {
	return s.findCommunityLayoutWithRefresh(ctx, id, false)
}

func (s *Server) findCommunityLayoutWithRefresh(ctx context.Context, id string, force bool) (resources.Layout, bool) {
	want := strings.ToUpper(strings.TrimSpace(id))
	if want == "" {
		return resources.Layout{}, false
	}
	snap := s.communityCatalog(ctx, force)
	for _, l := range snap.Layouts {
		if strings.EqualFold(l.ID, want) {
			return l, true
		}
	}
	return resources.Layout{}, false
}

// inspectProtectedResource checks if a style/layout code belongs to a community
// or exclusive resource whose prompt is hidden and restricted to website models (#162).
func (s *Server) inspectProtectedResource(ctx context.Context, kind, id string) (bool, protectedResourceMeta) {
	return s.inspectProtectedResourceWithRefresh(ctx, kind, id, false)
}

func (s *Server) inspectProtectedResourceFresh(ctx context.Context, kind, id string) (bool, protectedResourceMeta) {
	return s.inspectProtectedResourceWithRefresh(ctx, kind, id, true)
}

func (s *Server) inspectProtectedResourceWithRefresh(ctx context.Context, kind, id string, force bool) (bool, protectedResourceMeta) {
	clean := strings.TrimSpace(id)
	if clean == "" {
		return false, protectedResourceMeta{}
	}
	if kind == "layout" {
		if l, ok := s.findCommunityLayoutWithRefresh(ctx, clean, force); ok {
			return true, protectedResourceMeta{
				Code:       l.ID,
				Kind:       "layout",
				Name:       l.Name,
				Image:      l.Image,
				UnlockCost: l.UnlockCost,
				Unlocked:   l.Unlocked,
				IsMine:     l.IsMine,
				Known:      true,
			}
		}
	} else {
		if st, ok := s.findCommunityStyleWithRefresh(ctx, clean, force); ok {
			return true, protectedResourceMeta{
				Code:       st.Number,
				Kind:       "style",
				Name:       firstStr(st.NameZh, st.GenerationName, st.Number),
				Image:      st.Image,
				UnlockCost: st.UnlockCost,
				Unlocked:   st.Unlocked,
				IsMine:     st.IsMine,
				Known:      true,
			}
		}
	}
	// Fail-closed on known community/exclusive code prefixes even if offline or uncached.
	if looksLikeProtectedCode(clean) {
		return true, protectedResourceMeta{
			Code:  strings.ToUpper(clean),
			Kind:  kind,
			Name:  strings.ToUpper(clean),
			Known: false,
		}
	}
	return false, protectedResourceMeta{}
}

func (s *Server) resCommunity(w http.ResponseWriter, r *http.Request) (any, error) {
	force := r.URL.Query().Get("refresh") == "1"
	snap := s.communityCatalog(r.Context(), force)
	return map[string]any{
		"styles":  snap.Styles,
		"layouts": snap.Layouts,
		"total":   len(snap.Styles) + len(snap.Layouts),
	}, nil
}

func (s *Server) resCommunityUnlock(w http.ResponseWriter, r *http.Request) (any, error) {
	if s.Site == nil || !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		return nil, bad("缺少资源编号")
	}
	raw, err := s.Site.Send(r.Context(), http.MethodPost, "/api/v1/community/resources/"+url.PathEscape(code)+"/unlock", map[string]any{})
	if err != nil {
		// Fallback to /api/unlocks if older server version
		var ae *site.APIError
		if err != nil && (!isNotFoundAPIError(err, &ae)) {
			return nil, err
		}
		raw, err = s.Site.Send(r.Context(), http.MethodPost, "/api/unlocks", map[string]any{
			"targetType": "asset",
			"targetId":   code,
		})
		if err != nil {
			return nil, err
		}
	}
	s.invalidateCommunityCache()
	s.Emit("economy_changed", map[string]any{"targetId": code})
	s.Emit("resources_changed", map[string]any{"code": code})
	var out map[string]any
	if json.Unmarshal(raw, &out) == nil && out != nil {
		delete(out, "unlockedContent")
		out["promptHidden"] = true
		out["siteModelOnly"] = true
		return out, nil
	}
	return map[string]any{"ok": true, "targetId": code, "promptHidden": true, "siteModelOnly": true}, nil
}

func isNotFoundAPIError(err error, out **site.APIError) bool {
	ae, ok := err.(*site.APIError)
	if ok {
		*out = ae
		return ae.Status == 404
	}
	return false
}
