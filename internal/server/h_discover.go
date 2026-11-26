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
	discoveryCacheKey = "site_discovery_v3"
	discoveryCacheTTL = 5 * time.Minute
)

type discoveryQuality struct {
	R float64 `json:"r"`
}

type discoverySourceItem struct {
	ID                 string
	Kind               string
	Status             string
	Title              string
	Name               string
	Author             string
	AuthorUsername     string `json:"author_username"`
	AuthorName         string
	ExtraWorkCount     int
	Category           string
	WorkID             string
	TopicID            string
	ResourceDiscussion struct{ Kind string }
	Summary            string
	Image              string
	ImageURL           string
	CoverURL           string
	Images             []json.RawMessage
	Width              int
	Height             int
	AspectRatio        float64
	PublishedAtMs      int64
	CreatedAtMs        int64
	Price              int
	UnlockCount        int
	ForkCount          int
	FavoriteCount      int
	CommentCount       int
	Tags               []string
	Quality            *discoveryQuality
}

type discoveryResourceRanking struct {
	Style  []string `json:"style"`
	Layout []string `json:"layout"`
}

type discoveryBoot struct {
	Topics             []discoverySourceItem
	Inspirations       []discoverySourceItem
	OfficialOverrides  []discoverySourceItem
	OfficialResources  []discoverySourceItem
	CommunityResources []discoverySourceItem
	ExclusiveResources []discoverySourceItem
	ResourceRanking    discoveryResourceRanking
}

type discoveryCard struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	Title          string   `json:"title"`
	Href           string   `json:"href"`
	Image          string   `json:"image,omitempty"`
	AspectRatio    float64  `json:"aspectRatio,omitempty"`
	Author         string   `json:"author,omitempty"`
	AuthorKey      string   `json:"authorKey,omitempty"`
	ExtraWorkCount int      `json:"extraWorkCount,omitempty"`
	MoreHref       string   `json:"moreHref,omitempty"`
	Summary        string   `json:"summary,omitempty"`
	PublishedAtMs  int64    `json:"publishedAtMs,omitempty"`
	Price          int      `json:"price,omitempty"`
	UnlockCount    int      `json:"unlockCount,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	rankScore      float64
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
		ratio := item.AspectRatio
		if ratio <= 0 && item.Width > 0 && item.Height > 0 {
			ratio = float64(item.Width) / float64(item.Height)
		}
		pubMs := item.PublishedAtMs
		if pubMs <= 0 {
			pubMs = item.CreatedAtMs
		}
		var score float64
		if kind == "inspiration" {
			// Match Web mixed-feed.js inspiration recommendation score (#556).
			qScore := 0.0
			if item.Quality != nil && item.Quality.R > 0 {
				qScore = item.Quality.R * 100
			}
			eng := float64(item.UnlockCount*4 + item.ForkCount*3 + item.FavoriteCount*2 + item.CommentCount*2)
			score = qScore + eng
		}
		buckets[kind] = append(buckets[kind], discoveryCard{
			ID: item.ID, Kind: kind, Title: firstDiscoveryText(item.Title, item.Name, item.ID),
			Href: discoveryLink(base, kind, item.ID), Image: image, AspectRatio: ratio,
			Author:    firstDiscoveryText(item.AuthorName, item.Author, item.AuthorUsername),
			AuthorKey: firstDiscoveryText(item.Author, item.AuthorUsername), ExtraWorkCount: max(0, item.ExtraWorkCount),
			Summary: item.Summary, PublishedAtMs: pubMs,
			Price: item.Price, UnlockCount: item.UnlockCount, Tags: item.Tags,
			rankScore: score,
		})
	}
	for _, item := range works {
		add("work", item)
	}
	inspTopicIDs := map[string]bool{}
	for _, item := range boot.Inspirations {
		if tid := strings.TrimSpace(item.TopicID); tid != "" {
			inspTopicIDs[tid] = true
		}
		add("inspiration", item)
	}
	hasInspirations := len(buckets["inspiration"]) > 0
	for _, item := range boot.Topics {
		if item.Category == "showcase" || item.WorkID != "" || item.ResourceDiscussion.Kind == "work" {
			continue
		}
		if hasInspirations && (item.ResourceDiscussion.Kind == "inspiration" || inspTopicIDs[item.ID]) {
			continue
		}
		add("topic", item)
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

	sortByRecency := func(bucket []discoveryCard) {
		sort.SliceStable(bucket, func(left, right int) bool {
			return bucket[left].PublishedAtMs > bucket[right].PublishedAtMs
		})
	}
	sortByServerRank := func(bucket []discoveryCard, order []string) {
		if len(order) == 0 {
			sortByRecency(bucket)
			return
		}
		rankIdx := make(map[string]int, len(order))
		for i, id := range order {
			if _, exists := rankIdx[id]; !exists {
				rankIdx[id] = i
			}
		}
		sort.SliceStable(bucket, func(left, right int) bool {
			li, lok := rankIdx[bucket[left].ID]
			ri, rok := rankIdx[bucket[right].ID]
			if lok && rok {
				return li < ri
			}
			if lok != rok {
				return lok
			}
			return bucket[left].PublishedAtMs > bucket[right].PublishedAtMs
		})
	}

	sortByRecency(buckets["work"])
	sortByRecency(buckets["topic"])
	sort.SliceStable(buckets["inspiration"], func(left, right int) bool {
		if buckets["inspiration"][left].rankScore != buckets["inspiration"][right].rankScore {
			return buckets["inspiration"][left].rankScore > buckets["inspiration"][right].rankScore
		}
		return buckets["inspiration"][left].PublishedAtMs > buckets["inspiration"][right].PublishedAtMs
	})
	sortByServerRank(buckets["style"], boot.ResourceRanking.Style)
	sortByServerRank(buckets["layout"], boot.ResourceRanking.Layout)
	buckets["work"] = collapseDiscoveryWorks(base, buckets["work"])

	// 20-card mixed cadence aligned with Web mixed-feed.js (#556 / #175).
	pattern := []string{
		"work", "inspiration", "style", "work", "work", "inspiration", "layout", "topic",
		"work", "work", "inspiration", "work", "style", "work", "inspiration", "topic",
		"work", "work", "layout", "inspiration",
	}
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

// The home feed shows one representative work per author. Group after sorting
// and before mixing/limiting, so one prolific author cannot fill the homepage.
func collapseDiscoveryWorks(base string, works []discoveryCard) []discoveryCard {
	result := make([]discoveryCard, 0, len(works))
	type authorGroup struct{ index, extra int }
	groups := map[string]authorGroup{}
	for _, work := range works {
		key := strings.ToLower(firstDiscoveryText(work.AuthorKey, work.Author, work.ID))
		if group, exists := groups[key]; exists {
			group.extra++
			result[group.index].ExtraWorkCount = max(result[group.index].ExtraWorkCount, group.extra)
			groups[key] = group
			continue
		}
		groups[key] = authorGroup{index: len(result)}
		if work.AuthorKey != "" {
			work.MoreHref = discoveryAuthorLink(base, work.AuthorKey)
		}
		result = append(result, work)
	}
	return result
}

func discoveryAuthorLink(base, author string) string {
	root, err := url.Parse(base)
	if err != nil {
		return ""
	}
	root.Path, root.RawPath, root.Fragment = "/", "", ""
	root.RawQuery = url.Values{"view": {"works"}, "author": {author}}.Encode()
	return root.String()
}

func discoveryImage(item discoverySourceItem) string {
	if cover := firstDiscoveryText(item.CoverURL, item.ImageURL, item.Image); cover != "" {
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
	switch kind {
	case "inspiration":
		// Main site inspiration vault detail link.
		if orig, err := url.Parse(base); err == nil {
			orig.Path, orig.RawPath, orig.Fragment = "/", "", ""
			orig.RawQuery = url.Values{"view": {"inspirations"}, "id": {id}}.Encode()
			return orig.String()
		}
	case "topic":
		root.Path, root.RawPath = forumPath, ""
		root.RawQuery = url.Values{"view": {"topic"}, "id": {id}}.Encode()
	default:
		root.Path, root.RawPath = "/t/"+id, "/t/"+url.PathEscape(id)
	}
	return root.String()
}
