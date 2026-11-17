package profile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLibraryPreservesUnknownFields(t *testing.T) {
	dir := t.TempDir()
	SetHome(dir)
	defer SetHome("")

	libDir := filepath.Join(dir, "personal-library")
	_ = os.MkdirAll(libDir, 0o755)
	seed := `{
  "schema_version": 1,
  "custom_top": "keep-me",
  "resources": [
    {
      "id": "mine:11111111-1111-4111-8111-111111111111",
      "kind": "style",
      "name": "旧画风",
      "prompt_zh": "旧定义",
      "prompt_en": "old def",
      "license": "private",
      "version": "1.0.0",
      "section": "owned",
      "future_skill_field": {"k": 42}
    }
  ]
}`
	if err := os.WriteFile(filepath.Join(libDir, "library.json"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	err := UpsertLibrary(PersonalResource{
		ID:       "mine:11111111-1111-4111-8111-111111111111",
		Kind:     "style",
		Name:     "新画风名",
		PromptZh: "水彩淡彩笔触",
		PromptEn: "watercolor wash linework",
		License:  "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	items, top, err := ReadLibrary()
	if err != nil {
		t.Fatal(err)
	}
	if string(top["custom_top"]) != `"keep-me"` {
		t.Fatalf("lost top extra: %s", top["custom_top"])
	}
	if len(items) != 1 || items[0].Name != "新画风名" {
		t.Fatalf("unexpected items: %+v", items)
	}
	if string(items[0].Extra["future_skill_field"]) != `{"k": 42}` {
		var check map[string]int
		if json.Unmarshal(items[0].Extra["future_skill_field"], &check) != nil || check["k"] != 42 {
			t.Fatalf("lost item extra: %+v", items[0].Extra)
		}
	}
}

func TestRecipeFingerprintAndSave(t *testing.T) {
	dir := t.TempDir()
	SetHome(dir)
	defer SetHome("")

	r := Recipe{
		ID:       "rcp_local_test01",
		Name:     "测试配方",
		StyleIDs: []string{"fa-013"},
		LayoutID: "sc-001",
		Colors:   []string{"c-15"},
		Ratio:    "2.35:1",
		Mode:     "graphic-text",
	}
	fp := r.ComputeInputFingerprint()
	if len(fp) != 32 {
		t.Fatalf("bad fingerprint %q", fp)
	}
	if err := SaveRecipe(&r); err != nil {
		t.Fatal(err)
	}
	list, err := ListRecipes()
	if err != nil || len(list) != 1 || list[0].ID != r.ID {
		t.Fatalf("list recipes failed: %+v %v", list, err)
	}
}
