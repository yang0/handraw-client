package galleries

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestRuiCPoseAtlasInstallCacheAndUninstall(t *testing.T) {
	var imgHits atomic.Int32
	fakeImg := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 'I', 'H', 'D', 'R', 1, 2, 3, 4}

	mockGitee := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/data/poses.json":
			_, _ = w.Write([]byte(`{
				"angles":[
					{"key":"front","names":{"zh":"正面","en":"Front"}},
					{"key":"high","names":{"zh":"俯视","en":"High angle"}},
					{"key":"low","names":{"zh":"仰视","en":"Low angle"}},
					{"key":"side","names":{"zh":"侧面","en":"Side"}},
					{"key":"diagonal","names":{"zh":"斜侧","en":"Three-quarter"}}
				],
				"series":[{"key":"full_std","names":{"zh":"全身单人・标准系"},"short":{"zh":"标准全身"}}],
				"poses":[{
					"id":"full_std_P001","series":"full_std","category":"站姿","no":"P001",
					"names":{"zh":"自然站姿","en":"Natural stance"},
					"variants":[
						{"angle":"low","thumb":"thumbs/p1_low.jpg","full":"img/p1_low.png"},
						{"angle":"front","thumb":"thumbs/p1_front.jpg","full":"img/p1_front.png"},
						{"angle":"side","thumb":"thumbs/p1_side.jpg","full":"img/p1_side.png"},
						{"angle":"diagonal","thumb":"thumbs/p1_diag.jpg","full":"img/p1_diag.png"},
						{"angle":"high","thumb":"thumbs/p1_high.jpg","full":"img/p1_high.png"}
					]
				}]
			}`))
		case "/data/costumes.json":
			_, _ = w.Write([]byte(`{
				"categories":[{"key":"spring","names":{"zh":"春"}}],
				"groups":[{"key":"dress","names":{"zh":"连衣裙"}}],
				"costumes":[{"id":"SPR-0001","cat":"spring","group":"dress","color":"ivory","main":"knit","tags":["ivory","knit"],"thumb":"costume/thumbs/SPR-0001.webp","image":"costume/img/SPR-0001.webp"}]
			}`))
		case "/data/faces.json":
			_, _ = w.Write([]byte(`{
				"sections":[{"key":"face","names":{"zh":"脸部"}}],
				"hairs":[{"key":"short","names":{"zh":"短发"}}],
				"images":[{"id":"abc123456","sec":"face","hair":"short","thumb":"portrait/thumbs/abc123456.webp","full":"portrait/img/abc123456.png","full_remote":""}]
			}`))
		case "/img/p1_high.png", "/thumbs/p1_high.jpg":
			imgHits.Add(1)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(fakeImg)
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockGitee.Close()

	prevBases := ruicMirrorRawBases
	ruicMirrorRawBases = map[string]string{
		RuiCMirrorGitee:  mockGitee.URL + "/",
		RuiCMirrorGitHub: mockGitee.URL + "/",
	}
	t.Cleanup(func() { ruicMirrorRawBases = prevBases })

	dir := t.TempDir()
	ctx := context.Background()

	// 1. Install all 3 packs using default Gitee mirror
	for _, id := range []string{"ruic-poses", "ruic-costumes", "ruic-faces"} {
		st, err := InstallExternalPack(ctx, dir, id, RuiCMirrorGitee)
		if err != nil {
			t.Fatalf("install %s failed: %v", id, err)
		}
		if !st.Installed || !st.LocalOnly || st.Mirror != RuiCMirrorGitee || st.ItemCount != 1 {
			t.Fatalf("unexpected pack status for %s: %+v", id, st)
		}
	}

	// 2. Load via Registry and verify 5-angle ordering & LocalOnly flag
	reg := New()
	list := reg.List(nil, dir)
	var poseMeta *Meta
	for i := range list {
		if list[i].ID == "ruic-poses" {
			poseMeta = &list[i]
		}
	}
	if poseMeta == nil || !poseMeta.LocalOnly || !poseMeta.MultiVariant || poseMeta.Count != 1 {
		t.Fatalf("unexpected ruic-poses meta: %+v", poseMeta)
	}

	it, ok := reg.Item(nil, "ruic-poses", "full_std_P001", dir)
	if !ok {
		t.Fatalf("expected full_std_P001 item")
	}
	wantOrder := []string{"front", "diagonal", "side", "high", "low"}
	if len(it.Variants) != 5 {
		t.Fatalf("expected 5 angle variants, got %d", len(it.Variants))
	}
	for i, w := range wantOrder {
		if it.Variants[i].Key != w {
			t.Fatalf("variant[%d] = %q, want %q", i, it.Variants[i].Key, w)
		}
	}

	// 3. On-demand cache for 'high' angle full image downloads once, then serves from disk
	target, ok := reg.ResolveImageTarget(nil, "ruic-poses", "full_std_P001", "high", false, dir)
	if !ok || target.CachePath == "" || len(target.RemoteURLs) == 0 {
		t.Fatalf("unexpected ResolveImageTarget: %+v ok=%v", target, ok)
	}
	p1, err := EnsureCachedImage(ctx, target)
	if err != nil || p1 == "" {
		t.Fatalf("EnsureCachedImage 1 failed: %v", err)
	}
	p2, err := EnsureCachedImage(ctx, target)
	if err != nil || p2 != p1 {
		t.Fatalf("EnsureCachedImage 2 failed: %v", err)
	}
	if imgHits.Load() != 1 {
		t.Fatalf("expected exactly 1 upstream download (second from disk cache), got %d", imgHits.Load())
	}

	// 4. Uninstall with purgeCache removes both JSON and cached image file
	if err := UninstallExternalPack(dir, "ruic-poses", true); err != nil {
		t.Fatalf("uninstall failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ruic-poses.json")); !os.IsNotExist(err) {
		t.Fatalf("expected ruic-poses.json removed")
	}
	if _, err := os.Stat(p1); !os.IsNotExist(err) {
		t.Fatalf("expected cached pose image %s purged", p1)
	}
}
