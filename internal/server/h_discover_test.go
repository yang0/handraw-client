package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
)

func TestSiteDiscoverMixAndCache(t *testing.T) {
	png := tinyPNG(t)
	var feedHits atomic.Int32
	var imageHits atomic.Int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("public discovery sent an authorization header to %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/works/feed":
			feedHits.Add(1)
			if r.URL.Query().Get("sort") != "newest" {
				t.Error("discovery must request newest works")
			}
			works := make([]map[string]any, 0, 70)
			for index := range 70 {
				works = append(works, map[string]any{"id": fmt.Sprintf("work_%d", index), "images": []string{"/generated/cover.png"}, "publishedAtMs": index + 1})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": works})
		case "/api/boot":
			feedHits.Add(1)
			fmt.Fprint(w, `{"topics":[{"id":"topic_text","title":"A forum post","summary":"Text without a cover","publishedAtMs":100}, {"id":"topic_work","workId":"work_69"}],"officialOverrides":[{"id":"FA-001","name":"Renamed style","publishedAtMs":99}]}`)
		case "/data/catalog.json":
			feedHits.Add(1)
			fmt.Fprint(w, `{"resources":[{"id":"FA-002","kind":"style","image":"/images/style.webp"}, {"id":"FA-001","kind":"style","image":"/images/style.webp"}, {"id":"SC-001","kind":"layout","image":"/images/layout.webp"}, {"id":"C-01","kind":"color","image":"/images/color.webp"}]}`)
		case "/generated/cover.png":
			imageHits.Add(1)
			if r.URL.Query().Get("w") != "480" {
				t.Error("discovery should fetch a thumbnail")
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	defer mock.Close()
	srv, _ := setupTestServer(t, mock.URL)
	handler := srv.Handler()
	getFeed := func() discoveryFeed {
		t.Helper()
		resp := doReq(t, handler, srv.Token, "GET", "/api/site/discover", nil)
		var feed discoveryFeed
		if resp.Code != 200 || json.Unmarshal(resp.Body.Bytes(), &feed) != nil {
			t.Fatalf("unexpected feed response: %d %s", resp.Code, resp.Body.String())
		}
		return feed
	}
	feed := getFeed()
	if len(feed.Items) != 50 || feed.Offline || feed.Items[0].ID != "work_69" || feed.SiteBase != mock.URL {
		t.Fatalf("expected latest mixed 50 cards; got %d cards, offline=%v", len(feed.Items), feed.Offline)
	}
	var nonWorkIDs []string
	for _, item := range feed.Items {
		if item.Kind != "work" {
			nonWorkIDs = append(nonWorkIDs, item.ID)
		}
	}
	if want := []string{"FA-001", "topic_text", "SC-001", "FA-002"}; !reflect.DeepEqual(nonWorkIDs, want) {
		t.Fatalf("non-work cards = %v, want %v", nonWorkIDs, want)
	}
	if feed.Items[3].Title != "Renamed style" || feed.Items[7].Image != "" || feed.Items[7].Href != mock.URL+"/forum/?id=topic_text&view=topic" {
		t.Fatalf("wrong style override or forum card: %+v / %+v", feed.Items[3], feed.Items[7])
	}
	if cached := getFeed(); !reflect.DeepEqual(feed.Items, cached.Items) || feedHits.Load() != 3 {
		t.Fatal("second visit did not reuse the locally cached feed")
	}

	const thumbURL = "/files/remote?url=%2Fgenerated%2Fcover.png&w=480"
	for _, want := range []string{"miss", "hit"} {
		resp := doReq(t, handler, srv.Token, "GET", thumbURL, nil)
		if resp.Code != 200 || resp.Header().Get("X-Handraw-Cache") != want {
			t.Fatalf("thumbnail %s: code=%d cache=%s", want, resp.Code, resp.Header().Get("X-Handraw-Cache"))
		}
	}
	mock.Close()
	feed.CachedAt = time.Now().Add(-2 * discoveryCacheTTL)
	if err := srv.DB.SetKV(discoveryCacheKey, feed); err != nil {
		t.Fatal(err)
	}
	if offline := getFeed(); !offline.Offline || !reflect.DeepEqual(feed.Items, offline.Items) {
		t.Fatal("expected the last successful discovery feed while offline")
	}
	files, err := filepath.Glob(filepath.Join(appdir.Cache(), "remote-img", "*", "*.img"))
	if err != nil || len(files) != 1 || imageHits.Load() != 1 {
		t.Fatalf("expected exactly one image download and disk file: %v %v", files, err)
	}
	old := time.Now().Add(-2 * remoteImgTTL)
	if err := os.Chtimes(files[0], old, old); err != nil {
		t.Fatal(err)
	}
	resp := doReq(t, handler, srv.Token, "GET", thumbURL, nil)
	if resp.Code != 200 || resp.Header().Get("X-Handraw-Cache") != "stale" {
		t.Fatalf("expired thumbnail missing offline: %d %s", resp.Code, resp.Body.String())
	}
}

func TestDiscoveryLinksMatchWebsite(t *testing.T) {
	for _, example := range []struct{ base, kind, id, want string }{
		{"https://handraw-style.com", "work", "work_123", "https://forum.handraw-style.com/t/work_123"},
		{"https://handraw-style.com", "style", "FA-001", "https://forum.handraw-style.com/t/FA-001"},
		{"https://handraw-style.com", "layout", "SC-001", "https://forum.handraw-style.com/t/SC-001"},
		{"https://handraw-style.com", "topic", "topic_123", "https://forum.handraw-style.com/?id=topic_123&view=topic"},
		{"http://studio.localhost:3080", "layout", "SC-001", "http://forum.localhost:3080/t/SC-001"},
	} {
		if got := discoveryLink(example.base, example.kind, example.id); got != example.want {
			t.Errorf("discoveryLink(%q, %q): got %s, want %s", example.kind, example.id, got, example.want)
		}
	}
}

func TestDiscoveryFoldsWorksByAuthorBeforeMixing(t *testing.T) {
	works := []discoverySourceItem{
		{ID: "alice_old", Author: "alice", AuthorName: "同名", PublishedAtMs: 1, Images: []json.RawMessage{json.RawMessage(`"/old.png"`)}},
		{ID: "alice_new", Author: " Alice ", AuthorName: "同名", PublishedAtMs: 5, Images: []json.RawMessage{json.RawMessage(`"/one.png"`), json.RawMessage(`"/two.png"`)}},
		{ID: "alice_middle", AuthorUsername: "ALICE", PublishedAtMs: 3, Image: "/middle.png"},
		{ID: "alice_new", Author: "alice", PublishedAtMs: 5, Image: "/duplicate.png"},
		{ID: "bob", Author: "bob", AuthorName: "同名", PublishedAtMs: 4, Image: "/bob.png"},
		{ID: "unknown_1", PublishedAtMs: 2, Image: "/unknown1.png"},
		{ID: "unknown_2", PublishedAtMs: 1, Image: "/unknown2.png"},
		{ID: "hidden", Author: "alice", Status: "deleted", Image: "/hidden.png"},
		{ID: "no_image", Author: "alice", PublishedAtMs: 6},
	}
	feed := buildDiscoveryCards("https://handraw-style.com", works, discoveryBoot{}, nil)
	if len(feed) != 4 {
		t.Fatalf("expected alice, bob and two independent unknown authors: %+v", feed)
	}
	alice := feed[0]
	if alice.ID != "alice_new" || alice.ExtraWorkCount != 2 || alice.AuthorKey != "Alice" || alice.Author != "同名" {
		t.Fatalf("wrong representative/count/identity: %+v", alice)
	}
	if alice.Image != "/one.png" || alice.MoreHref != "https://handraw-style.com/?author=Alice&view=works" {
		t.Fatalf("multi-image work was expanded or author destination is wrong: %+v", alice)
	}
	if feed[1].ID != "bob" || feed[1].ExtraWorkCount != 0 {
		t.Fatalf("distinct usernames with the same display name were folded together: %+v", feed[1])
	}
	for _, item := range feed[2:] {
		if item.ExtraWorkCount != 0 || item.MoreHref != "" {
			t.Fatalf("unidentified works were folded or given an invented account: %+v", item)
		}
	}
}

func TestDiscoveryAuthorFoldKeepsOtherAuthorsAndResources(t *testing.T) {
	works := make([]discoverySourceItem, 0, 80)
	for index := range 55 {
		works = append(works, discoverySourceItem{
			ID: fmt.Sprintf("prolific_%d", index), Author: "prolific", PublishedAtMs: int64(100 + index), Image: "/work.png",
		})
	}
	for index := range 25 {
		works = append(works, discoverySourceItem{
			ID: fmt.Sprintf("other_%d", index), Author: fmt.Sprintf("user_%d", index), PublishedAtMs: int64(index + 1), Image: "/work.png",
		})
	}
	resources := []discoverySourceItem{
		{ID: "FA-001", Kind: "style", Author: "prolific", Image: "/style.png"},
		{ID: "FA-002", Kind: "style", Author: "prolific", Image: "/style.png"},
	}
	feed := buildDiscoveryCards("https://handraw-style.com", works, discoveryBoot{
		Topics: []discoverySourceItem{{ID: "discussion", Title: "独立讨论", Author: "prolific"}},
	}, resources)
	if len(feed) != 29 || feed[0].ExtraWorkCount != 54 {
		t.Fatalf("folding must precede the 50-card limit: %d cards, representative=%+v", len(feed), feed[0])
	}
	counts := map[string]int{}
	for _, card := range feed {
		counts[card.Kind]++
	}
	if counts["work"] != 26 || counts["style"] != 2 || counts["topic"] != 1 {
		t.Fatalf("other authors or non-work content were lost: %v", counts)
	}
}

func TestDiscoveryFoldCountUsesWebsiteMaximum(t *testing.T) {
	feed := buildDiscoveryCards("https://handraw-style.com", []discoverySourceItem{
		{ID: "one", Author: "alice", ExtraWorkCount: 8, PublishedAtMs: 3, Image: "/1.png"},
		{ID: "two", Author: "alice", PublishedAtMs: 2, Image: "/2.png"},
		{ID: "three", Author: "alice", PublishedAtMs: 1, Image: "/3.png"},
	}, discoveryBoot{}, nil)
	if len(feed) != 1 || feed[0].ExtraWorkCount != 8 {
		t.Fatalf("upstream and local counts must not be added twice: %+v", feed)
	}
	var source discoverySourceItem
	if err := json.Unmarshal([]byte(`{"id":"legacy","author_username":"alice +bob","authorName":"作者","images":["/image.png"]}`), &source); err != nil {
		t.Fatal(err)
	}
	fallback := buildDiscoveryCards("https://handraw-style.com", []discoverySourceItem{source}, discoveryBoot{}, nil)
	if fallback[0].AuthorKey != "alice +bob" || fallback[0].MoreHref != "https://handraw-style.com/?author=alice+%2Bbob&view=works" {
		t.Fatalf("legacy author field or query escaping lost: %+v", fallback)
	}
}

func TestDiscoveryReplacesPreviousUnfoldedCache(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/works/feed":
			fmt.Fprint(w, `{"items":[{"id":"new","author":"alice","images":["/new.png"],"publishedAtMs":2},{"id":"old","author":"alice","images":["/old.png"],"publishedAtMs":1}]}`)
		case "/api/boot":
			fmt.Fprint(w, `{"topics":[]}`)
		case "/data/catalog.json":
			fmt.Fprint(w, `{"resources":[]}`)
		}
	}))
	defer mock.Close()
	srv, _ := setupTestServer(t, mock.URL)
	_ = srv.DB.SetKV("site_discovery_v1", discoveryFeed{
		SiteBase: mock.URL, CachedAt: time.Now(), Items: []discoveryCard{{ID: "stale_unfolded"}},
	})
	resp := doReq(t, srv.Handler(), srv.Token, "GET", "/api/site/discover", nil)
	var feed discoveryFeed
	if resp.Code != 200 || json.Unmarshal(resp.Body.Bytes(), &feed) != nil || len(feed.Items) != 1 || feed.Items[0].ID != "new" || feed.Items[0].ExtraWorkCount != 1 {
		t.Fatalf("old unfolded cache was not replaced: %d %s", resp.Code, resp.Body.String())
	}
}
