package skills

import (
	"os"
	"path/filepath"
	"testing"
)

func writeMockSkill(t *testing.T, dir, name, desc, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	md := "---\nname: " + name + "\ndescription: " + desc + "\nversion: 1.2.0\n---\n\n" + body + "\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(md), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}
}

func TestDiscoverHarnessSkillsAndSelectiveImport(t *testing.T) {
	fakeHome := t.TempDir()
	// Clear env overrides that could point outside fakeHome during test.
	for _, k := range []string{
		"XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME",
		"WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "COPILOT_HOME",
		"GROK_HOME", "HERMES_HOME", "PI_CODING_AGENT_DIR", "KIMI_CODE_HOME",
	} {
		t.Setenv(k, "")
	}

	writeMockSkill(t, filepath.Join(fakeHome, ".gemini", "config", "skills", "less-ai-tone"),
		"less-ai-tone", "去除文章中的 AI 味", "删除套话，改用自然口语。")
	writeMockSkill(t, filepath.Join(fakeHome, ".gemini", "config", "plugins", "dbs", "skills", "dbs-plain-writing"),
		"dbs-plain-writing", "清晰平铺直叙说明文", "按事实与功能顺序写清。")
	writeMockSkill(t, filepath.Join(fakeHome, ".claude", "skills", "wechat-editor"),
		"wechat-editor", "公众号排版编辑", "优化段落节奏和标题钩子。")
	writeMockSkill(t, filepath.Join(fakeHome, ".codex", "skills", "code-review"),
		"code-review", "代码审查规范", "检查边界条件与并发安全。")

	mgr := New(t.TempDir())
	res := mgr.DiscoverHarnessSkills(fakeHome, "")
	if res.TotalSkills != 4 {
		t.Fatalf("expected 4 discovered skills, got %d (%+v)", res.TotalSkills, res)
	}
	clientMap := map[string]DiscoveredClient{}
	for _, c := range res.Clients {
		clientMap[c.ID] = c
	}
	if clientMap["antigravity"].SkillCount != 2 {
		t.Fatalf("expected 2 antigravity skills (direct + plugin subdir), got %+v", clientMap["antigravity"])
	}
	if clientMap["claude"].SkillCount != 1 || clientMap["codex"].SkillCount != 1 {
		t.Fatalf("expected 1 claude and 1 codex skill, got claude=%+v codex=%+v", clientMap["claude"], clientMap["codex"])
	}

	// Import one skill and verify re-discovery marks it as already installed.
	target := clientMap["antigravity"].Skills[0]
	sk, err := mgr.InstallFromLocalWithSource(target.Dir, "harness:antigravity:"+target.Dir)
	if err != nil {
		t.Fatalf("InstallFromLocalWithSource failed: %v", err)
	}
	if sk.Version != "1.2.0" || sk.Source != "harness:antigravity:"+target.Dir {
		t.Fatalf("unexpected imported skill metadata: %+v", sk)
	}

	res2 := mgr.DiscoverHarnessSkills(fakeHome, "")
	foundInstalled := false
	for _, c := range res2.Clients {
		for _, d := range c.Skills {
			if d.Dir == target.Dir && d.Installed && d.InstalledID == sk.ID {
				foundInstalled = true
			}
		}
	}
	if !foundInstalled {
		t.Fatalf("expected re-discovery to flag %s as installed", target.ID)
	}
}
