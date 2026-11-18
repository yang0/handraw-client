package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	discoveryLimit    = 50
	discoveryCacheKey = "site_discovery_v1"
	discoveryCacheTTL = 5 * time.Minute
)

type discoverySourceItem struct {
	ID                 string
	Kind               string
	Status             string
	Title              string
	Name               string
	Author             string
	AuthorName         string
	Category           string
	WorkID             string
	ResourceDiscussion struct{ Kind string }
	Summary            string
	Image              string
	CoverURL           string
	Images             []json.RawMessage
	AspectRatio        float64
	PublishedAtMs      int64
}

type discoveryBoot struct {
	Topics             []discoverySourceItem
	OfficialOverrides  []discoverySourceItem
	OfficialResources  []discoverySourceItem
	CommunityResources []discoverySourceItem
	ExclusiveResources []discoverySourceItem
}

type discoveryCard struct {
	ID            string  `json:"id"`
	Kind          string  `json:"kind"`
	Title         string  `json:"title"`
	Href          string  `json:"href"`
	Image         string  `json:"image,omitempty"`
	AspectRatio   float64 `json:"aspectRatio,omitempty"`
	Author        string  `json:"author,omitempty"`
	Summary       string  `json:"summary,omitempty"`
	PublishedAtMs int64   `json:"publishedAtMs,omitempty"`
}

type discoveryFeed struct {
	SiteBase string          `json:"siteBase"`
	CachedAt time.Time       `json:"cachedAt"`
	Offline  bool            `json:"offline,omitempty"`
	Items    []discoveryCard `json:"items"`
}

func (s *Server) siteDiscover(_ http.ResponseWriter, r *http.Request) (any, error) {
	base := s.Site.Base()
	var cached discoveryFeed
	_ = s.DB.GetKV(discoveryCacheKey, &cached)
	hasCache := cached.SiteBase == base && cached.Items != nil
	if hasCache && time.Since(cached.CachedAt) < discoveryCacheTTL {
		return cached, nil
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var works struct{ Items []discoverySourceItem }
	var boot discoveryBoot
	var catalog struct{ Resources []discoverySourceItem }
	results := make(chan error, 3)
	for path, dest := range map[string]any{
		"/api/works/feed?sort=newest&limit=100": &works,
		"/api/boot?surface=discover":            &boot,
		"/data/catalog.json":                    &catalog,
	} {
		go func() { results <- s.Site.Public(ctx, http.MethodGet, path, nil, dest) }()
	}
	failed := false
	for range cap(results) {
		if err := <-results; err != nil {
			failed = true
			cancel()
		}
	}
	if failed || works.Items == nil || boot.Topics == nil || catalog.Resources == nil {
		if hasCache {
			cached.Offline = true
			return cached, nil
		}
		return discoveryFeed{SiteBase: base, Offline: true, Items: []discoveryCard{}}, nil
	}
	feed := discoveryFeed{SiteBase: base, CachedAt: time.Now(), Items: buildDiscoveryCards(base, works.Items, boot, catalog.Resources)}
	_ = s.DB.SetKV(discoveryCacheKey, feed)
	return feed, nil
}

func buildDiscoveryCards(base string, works []discoverySourceItem, boot discoveryBoot, catalog []discoverySourceItem) []discoveryCard {
	buckets := map[string][]discoveryCard{}
	seen := map[string]bool{}
	add := func(kind string, item discoverySourceItem) {
		key := kind + ":" + item.ID
		if item.ID == "" || (item.Status != "" && item.Status != "published") || seen[key] {
			return
		}
		image := discoveryImage(item)
		if image == "" && kind != "topic" {
			return
		}
		seen[key] = true
		buckets[kind] = append(buckets[kind], discoveryCard{
			ID: item.ID, Kind: kind, Title: firstDiscoveryText(item.Title, item.Name, item.ID),
			Href: discoveryLink(base, kind, item.ID), Image: image, AspectRatio: item.AspectRatio,
			Author: firstDiscoveryText(item.AuthorName, item.Author), Summary: item.Summary, PublishedAtMs: item.PublishedAtMs,
		})
	}
	for _, item := range works {
		add("work", item)
	}
	for _, item := range boot.Topics {
		if item.Category != "showcase" && item.WorkID == "" && item.ResourceDiscussion.Kind != "work" {
			add("topic", item)
		}
	}
	overrides := make(map[string]discoverySourceItem, len(boot.OfficialOverrides))
	for _, item := range boot.OfficialOverrides {
		overrides[item.ID] = item
	}
	for _, items := range [][]discoverySourceItem{boot.ExclusiveResources, boot.CommunityResources, boot.OfficialResources, catalog} {
		for _, item := range items {
			if item.Kind != "style" && item.Kind != "layout" {
				continue
			}
			if override, ok := overrides[item.ID]; ok {
				item.Name = firstDiscoveryText(override.Name, item.Name)
				item.Image = firstDiscoveryText(override.Image, item.Image)
				if override.PublishedAtMs > 0 {
					item.PublishedAtMs = override.PublishedAtMs
				}
				if override.Status != "" {
					item.Status = override.Status
				}
			}
			add(item.Kind, item)
		}
	}
	for _, bucket := range buckets {
		sort.SliceStable(bucket, func(left, right int) bool {
			return bucket[left].PublishedAtMs > bucket[right].PublishedAtMs
		})
	}

	pattern := []string{"work", "work", "work", "style", "work", "work", "work", "topic", "work", "work", "work", "layout", "work", "work", "work", "topic"}
	items := make([]discoveryCard, 0, discoveryLimit)
	for len(items) < discoveryLimit {
		count := len(items)
		for _, kind := range pattern {
			if bucket := buckets[kind]; len(bucket) > 0 {
				items = append(items, bucket[0])
				buckets[kind] = bucket[1:]
				if len(items) == discoveryLimit {
					break
				}
			}
		}
		if len(items) == count {
			break
		}
	}
	return items
}

func discoveryImage(item discoverySourceItem) string {
	if cover := firstDiscoveryText(item.CoverURL, item.Image); cover != "" {
		return cover
	}
	for _, raw := range item.Images {
		var ref string
		if json.Unmarshal(raw, &ref) == nil && ref != "" {
			return ref
		}
		var img struct{ URL, ImageURL string }
		if json.Unmarshal(raw, &img) == nil {
			if ref = firstDiscoveryText(img.URL, img.ImageURL); ref != "" {
				return ref
			}
		}
	}
	return ""
}

func firstDiscoveryText(options ...string) string {
	for _, option := range options {
		if value := strings.TrimSpace(option); value != "" {
			return value
		}
	}
	return ""
}

func discoveryLink(base, kind, id string) string {
	root, err := url.Parse(base)
	if err != nil {
		return base
	}
	domain, port := strings.ToLower(root.Hostname()), root.Port()
	forumPath := "/forum/"
	for _, siteDomain := range []string{"handraw-style.com", "localhost"} {
		if (domain == siteDomain && siteDomain != "localhost") || strings.HasSuffix(domain, "."+siteDomain) {
			root.Host = "forum." + siteDomain
			if port != "" {
				root.Host = net.JoinHostPort(root.Host, port)
			}
			forumPath = "/"
			break
		}
	}
	root.RawQuery, root.Fragment = "", ""
	if kind == "topic" {
		root.Path, root.RawPath = forumPath, ""
		root.RawQuery = url.Values{"view": {"topic"}, "id": {id}}.Encode()
	} else {
		root.Path, root.RawPath = "/t/"+id, "/t/"+url.PathEscape(id)
	}
	return root.String()
}
