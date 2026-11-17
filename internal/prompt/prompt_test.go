package prompt

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/resources"
)

func skillRoot(t *testing.T) string {
	root := os.Getenv("HANDRAW_SKILL_DIR")
	if root == "" {
		root = `E:\handraw-style`
	}
	if _, err := os.Stat(filepath.Join(root, "skills", "handdraw-style-prompter", "references", "styles.json")); err != nil {
		t.Skip("skill checkout not available")
	}
	return root
}

// TestGolden checks the Skill's golden cases when the resource pack provides them.
func TestGolden(t *testing.T) {
	root := skillRoot(t)
	golden := filepath.Join(root, "tests", "fixtures", "prompt_golden.json")
	b, err := os.ReadFile(golden)
	if err != nil {
		t.Skip("no golden file yet")
	}
	var file struct {
		Cases []struct {
			Name     string `json:"name"`
			Input    struct {
				Style, Layout, Color, Theme, Ratio, Subject, Text, Model, Mode, Language *string
				Redraw                                                                   bool
			} `json:"input"`
			Expected struct {
				Zh       string `json:"zh"`
				En       string `json:"en"`
				Kind     string `json:"kind"`
				Language string `json:"language"`
			} `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	packDir := os.Getenv("HANDRAW_PACK_DIR")
	if packDir == "" {
		packDir = filepath.Join(root, "dist", "client-resources")
	}
	if _, err := os.Stat(filepath.Join(packDir, "manifest.json")); err != nil {
		packDir = root
	}
	p, err := resources.Load(packDir)
	if err != nil {
		t.Fatal(err)
	}
	rules := RulesFrom(p.Rules)
	s := func(v *string) string {
		if v == nil {
			return ""
		}
		return *v
	}
	if len(file.Cases) == 0 {
		t.Fatal("golden file has no cases")
	}
	for i, c := range file.Cases {
		in := Input{Style: s(c.Input.Style), Layout: s(c.Input.Layout), Color: s(c.Input.Color), Theme: s(c.Input.Theme),
			Ratio: s(c.Input.Ratio), Subject: s(c.Input.Subject), Text: s(c.Input.Text), Model: s(c.Input.Model),
			Mode: s(c.Input.Mode), Language: s(c.Input.Language), Redraw: c.Input.Redraw}
		if c.Expected.Kind == "layout" {
			for _, lang := range []string{"zh", "en"} {
				in2 := in
				in2.Language = lang
				res, err := Build(p, rules, in2)
				if err != nil {
					t.Errorf("case %d %s: %v", i, c.Name, err)
					continue
				}
				want := c.Expected.Zh
				if lang == "en" {
					want = c.Expected.En
				}
				if want != "" && res.Primary != want {
					t.Errorf("case %d %s %s:\n got  %q\n want %q", i, c.Name, lang, res.Primary, want)
				}
			}
			continue
		}
		res, err := Build(p, rules, in)
		if err != nil {
			t.Errorf("case %d %s: %v", i, c.Name, err)
			continue
		}
		if res.Zh != c.Expected.Zh {
			t.Errorf("case %d %s zh:\n got  %q\n want %q", i, c.Name, res.Zh, c.Expected.Zh)
		}
		if res.En != c.Expected.En {
			t.Errorf("case %d %s en:\n got  %q\n want %q", i, c.Name, res.En, c.Expected.En)
		}
	}
	t.Logf("checked %d golden cases against %s", len(file.Cases), packDir)
}

// TestAgainstPython runs the real prompt_style.py for a few inputs.
func TestAgainstPython(t *testing.T) {
	root := skillRoot(t)
	py, err := exec.LookPath("python")
	if err != nil {
		t.Skip("python not found")
	}
	p, err := resources.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	rules := RulesFrom(p.Rules)
	script := filepath.Join(root, "skills", "handdraw-style-prompter", "scripts", "prompt_style.py")
	cases := []Input{
		{Style: "FA-001", Theme: "猫咪在咖啡馆喝咖啡"},
		{Style: "FB-020", Color: "C-15", Theme: "秋日桂花野餐"},
		{Style: "FC-010", Color: "C-01+C-12", Theme: "城市夜跑", Ratio: "3:4"},
		{Layout: "SC-008", Style: "FB-020", Color: "C-15", Theme: "秋日桂花野餐"},
		{Layout: "IG-001", Theme: "Coffee brewing guide"},
		{Style: "FI-001", Theme: "Cyberpunk street on a rainy night", Redraw: true},
		{Style: "FE-048", Theme: "春节", Mode: "graphic-text"},
		{Color: "C-03", Theme: "海边日落"},
	}
	for _, in := range cases {
		args := []string{"-X", "utf8", script}
		if in.Style != "" {
			args = append(args, "--style", in.Style)
		}
		if in.Layout != "" {
			args = append(args, "--layout", in.Layout)
		}
		if in.Color != "" {
			args = append(args, "--color", in.Color)
		}
		if in.Ratio != "" {
			args = append(args, "--ratio", in.Ratio)
		}
		if in.Redraw {
			args = append(args, "--redraw")
		}
		if in.Mode != "" {
			args = append(args, "--mode", in.Mode)
		}
		args = append(args, "--theme", in.Theme)
		out, err := exec.Command(py, args...).Output()
		if err != nil {
			t.Fatalf("python %v: %v", args, err)
		}
		text := strings.ReplaceAll(string(out), "\r\n", "\n")
		res, err := Build(p, rules, in)
		if err != nil {
			t.Fatal(err)
		}
		// Python prints absolute local reference paths; ours are pack-relative.
		if res.ReferenceImage != "" {
			abs := filepath.Join(root, filepath.FromSlash(res.ReferenceImage))
			text = strings.ReplaceAll(text, abs, res.ReferenceImage)
		}
		if in.Layout != "" {
			if !strings.Contains(text, "\nPrompt:\n"+res.Primary+"\n") {
				t.Errorf("layout %v mismatch:\npython:\n%s\ngo:\n%s", in, text, res.Primary)
			}
			continue
		}
		if !strings.Contains(text, "中文提示词：\n"+res.Zh+"\n") {
			t.Errorf("zh %v mismatch:\npython:\n%s\ngo:\n%s", in, text, res.Zh)
		}
		if !strings.Contains(text, "English prompt:\n"+res.En+"\n") {
			t.Errorf("en %v mismatch:\npython:\n%s\ngo:\n%s", in, text, res.En)
		}
	}
}
