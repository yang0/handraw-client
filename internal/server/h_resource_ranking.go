package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Shared 推荐 order for styles / layouts (#168, handraw-web#548).
//
// The website computes one order from buyer reviews, generation success rate
// and recent engagement, and uses it for its own channel and pickers. The
// client proxies the same endpoint so its picker matches the website.
const (
	resourceRankingCacheKey = "resource_ranking_v1:"
	resourceRankingTTL      = 5 * time.Minute
	resourceRankingStaleTTL = 24 * time.Hour
)

type resourceRanking struct {
	OK      bool                       `json:"ok"`
	Kind    string                     `json:"kind"`
	Day     string                     `json:"day,omitempty"`
	Order   []string                   `json:"order"`
	Quality map[string]json.RawMessage `json:"quality,omitempty"`
	Stale   bool                       `json:"stale,omitempty"`
}

func normalizeRankingKind(raw string) string {
	if strings.EqualFold(strings.TrimSpace(raw), "layout") {
		return "layout"
	}
	return "style"
}

func (s *Server) resourceRanking(ctx context.Context, kind string, force bool) resourceRanking {
	kind = normalizeRankingKind(kind)
	empty := resourceRanking{OK: true, Kind: kind, Order: []string{}}
	if s.Site == nil {
		return empty
	}
	cacheKey := resourceRankingCacheKey + s.Site.Base() + ":" + kind
	if !force {
		if raw, ok := s.getMarketCache(cacheKey, resourceRankingTTL); ok {
			var cached resourceRanking
			if json.Unmarshal(raw, &cached) == nil {
				return cached
			}
		}
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	var resp resourceRanking
	// The ranking is public and viewer-independent: never send credentials.
	err := s.Site.Public(fetchCtx, http.MethodGet, "/api/v1/resources/ranking?kind="+url.QueryEscape(kind), nil, &resp)
	if err != nil || !resp.OK || len(resp.Order) == 0 {
		if raw, ok := s.getMarketCache(cacheKey, resourceRankingStaleTTL); ok {
			var stale resourceRanking
			if json.Unmarshal(raw, &stale) == nil {
				stale.Stale = true
				return stale
			}
		}
		return empty
	}
	resp.Kind = kind
	if b, err := json.Marshal(resp); err == nil {
		s.setMarketCache(cacheKey, b)
	}
	return resp
}

func (s *Server) resRanking(w http.ResponseWriter, r *http.Request) (any, error) {
	q := r.URL.Query()
	return s.resourceRanking(r.Context(), q.Get("kind"), q.Get("refresh") == "1"), nil
}
