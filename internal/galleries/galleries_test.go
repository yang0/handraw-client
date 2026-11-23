package galleries

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yang0/handraw-client/internal/resources"
)

func TestRegistryBuiltinDeclarativeAndPluginGalleries(t *testing.T) {
	tmp := t.TempDir()

	// Create a declarative "hairstyles" gallery in <pack>/references/galleries/hairstyles.json
	galDir := filepath.Join(tmp, "references", "galleries")
	imgDir := filepath.Join(tmp, "images", "hairstyles")
	if err := os.MkdirAll(galDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	imgFile := filepath.Join(imgDir, "HS-001.png")
	if err := os.WriteFile(imgFile, []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	hairJSON := `{
		"id": "hairstyles",
		"name": "发型",
		"nameEn": "Hairstyles",
		"promptRole": "subject-attribute",
		"items": [
			{
				"id": "HS-001",
				"name": "法式微卷短发",
				"category": "short",
				"categoryName": "短发",
				"traits": "齐下巴法式微卷短发，空气刘海",
				"image": "images/hairstyles/HS-001.png"
			}
		]
	}`
	if err := os.WriteFile(filepath.Join(galDir, "hairstyles.json"), []byte(hairJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	pack := &resources.Pack{
		Dir:       tmp,
		ImageRoot: tmp,
		Styles: []resources.Style{
			{Number: "FA-001", NameZh: "水彩社论", GroupCode: "FA", GroupZh: "社论幽默", Traits: "暖调水彩"},
		},
	}

	reg := New()
	changed := 0
	reg.OnChange = func() { changed++ }

	// Plugin dynamically registers a "poses" gallery
	poseDir := filepath.Join(tmp, "plugin-pose")
	if err := os.MkdirAll(poseDir, 0o755); err != nil {
		t.Fatal(err)
	}
	poseImg := filepath.Join(poseDir, "ps01.png")
	if err := os.WriteFile(poseImg, []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(Registration{
		ID:         "poses",
		Name:       "姿势",
		NameEn:     "Poses",
		Owner:      "dsh-plugin-pose-studio",
		PromptRole: "pose",
		ImageRoot:  poseDir,
		Items: []Item{
			{ID: "PS-001", Name: "侧身回眸", Category: "standing", CategoryName: "站姿", Traits: "侧身站立微微回眸", Image: "ps01.png"},
		},
	}); err != nil {
		t.Fatalf("Register poses failed: %v", err)
	}
	if changed != 1 {
		t.Fatalf("expected OnChange=1, got %d", changed)
	}

	// Cannot override core builtin kind
	if err := reg.Register(Registration{ID: "styles", Name: "evil"}); err == nil {
		t.Fatal("expected overriding builtin styles to fail")
	}

	list := reg.List(pack)
	found := map[string]Meta{}
	for _, m := range list {
		found[m.ID] = m
	}
	if _, ok := found["styles"]; !ok {
		t.Fatal("missing builtin styles gallery")
	}
	if hs, ok := found["hairstyles"]; !ok || hs.Count != 1 || hs.Name != "发型" {
		t.Fatalf("unexpected hairstyles meta: %+v", hs)
	}
	if ps, ok := found["poses"]; !ok || ps.Count != 1 || ps.Source != "plugin:dsh-plugin-pose-studio" {
		t.Fatalf("unexpected poses meta: %+v", ps)
	}

	// Search items across newly added hairstyles gallery
	items, total, ok := reg.Items(pack, "hairstyles", Query{Q: "微卷"})
	if !ok || total != 1 || len(items) != 1 || items[0].ID != "HS-001" {
		t.Fatalf("unexpected search result: ok=%v total=%d items=%+v", ok, total, items)
	}
	if items[0].ImageURL != "/api/galleries/hairstyles/items/HS-001/image" {
		t.Fatalf("unexpected ImageURL: %q", items[0].ImageURL)
	}
	if p, ok := reg.ResolveImage(pack, "hairstyles", "HS-001"); !ok || p != imgFile {
		t.Fatalf("ResolveImage hairstyles failed: ok=%v path=%q", ok, p)
	}
	if p, ok := reg.ResolveImage(pack, "poses", "PS-001"); !ok || p != poseImg {
		t.Fatalf("ResolveImage poses failed: ok=%v path=%q", ok, p)
	}

	// Unregister plugin owner cleanly removes poses gallery
	if n := reg.UnregisterByOwner("dsh-plugin-pose-studio"); n != 1 {
		t.Fatalf("expected 1 unregistered, got %d", n)
	}
	if _, _, ok := reg.Items(pack, "poses", Query{}); ok {
		t.Fatal("poses gallery should be gone after UnregisterByOwner")
	}
}
