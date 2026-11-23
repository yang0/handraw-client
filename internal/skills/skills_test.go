package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillManagerInstallToggleAndRemove(t *testing.T) {
	mgr := New(t.TempDir())

	// 1. Inline install (without frontmatter -> auto-wrapped)
	sk1, err := mgr.InstallInline("", "小红书标题助手", "帮用户写出高点击率标题", "# 小红书标题助手\n\n每次给 5 个标题候选。", "chat")
	if err != nil {
		t.Fatalf("InstallInline failed: %v", err)
	}
	if !sk1.Enabled || sk1.Name != "小红书标题助手" || !strings.Contains(sk1.Body, "5 个标题") {
		t.Fatalf("unexpected skill: %+v", sk1)
	}

	// 2. Local directory install
	srcDir := filepath.Join(t.TempDir(), "my-comic-skill")
	_ = os.MkdirAll(srcDir, 0o755)
	_ = os.WriteFile(filepath.Join(srcDir, "SKILL.md"), []byte("---\nname: comic-planner\ndescription: 四格漫画分镜助手\n---\n\n拆成四格故事，每格写清动作与台词。"), 0o644)
	sk2, err := mgr.InstallFromSource(context.Background(), srcDir)
	if err != nil {
		t.Fatalf("InstallFromSource dir failed: %v", err)
	}
	if sk2.ID != "comic-planner" || sk2.Description != "四格漫画分镜助手" {
		t.Fatalf("unexpected dir skill: %+v", sk2)
	}

	// 3. ZIP bytes install
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	f, _ := zw.Create("zip-skill/SKILL.md")
	_, _ = f.Write([]byte("---\nname: poster-critic\ndescription: 海报构图审校\n---\n\n检查视觉层级与留白。"))
	_ = zw.Close()
	sk3, err := mgr.InstallFromBytes("poster-critic.zip", zbuf.Bytes(), "upload")
	if err != nil {
		t.Fatalf("InstallFromBytes zip failed: %v", err)
	}
	if sk3.ID != "poster-critic" {
		t.Fatalf("unexpected zip skill: %+v", sk3)
	}

	// 4. Remote HTTP SKILL.md install
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("---\nname: remote-note\ndescription: 远程笔记助手\n---\n\n提炼三点核心观点。"))
	}))
	defer srv.Close()
	sk4, err := mgr.InstallFromSource(context.Background(), srv.URL+"/SKILL.md")
	if err != nil {
		t.Fatalf("InstallFromSource url failed: %v", err)
	}
	if sk4.ID != "remote-note" {
		t.Fatalf("unexpected remote skill: %+v", sk4)
	}

	// 5. List, disable, remove
	list, err := mgr.List()
	if err != nil || len(list) != 4 {
		t.Fatalf("expected 4 skills, got %d err=%v", len(list), err)
	}
	disabled, err := mgr.SetEnabled(sk2.ID, false)
	if err != nil || disabled.Enabled {
		t.Fatalf("SetEnabled(false) failed: %+v err=%v", disabled, err)
	}
	if err := mgr.Remove(sk4.ID); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}
	list2, _ := mgr.List()
	if len(list2) != 3 {
		t.Fatalf("expected 3 skills after remove, got %d", len(list2))
	}
}

func TestBuiltinHandrawSkillAndDynamicUpdate(t *testing.T) {
	mgr := New(t.TempDir())
	if err := mgr.EnsureBuiltin(); err != nil {
		t.Fatalf("EnsureBuiltin failed: %v", err)
	}

	sk, err := mgr.Get(BuiltinHandrawSkillID)
	if err != nil {
		t.Fatalf("Get builtin skill failed: %v", err)
	}
	if !sk.Builtin || !sk.Enabled || !sk.Updatable {
		t.Fatalf("unexpected builtin flags: %+v", sk)
	}
	if sk.Name != "手绘skill" {
		t.Fatalf("expected display_name 手绘skill, got %q", sk.Name)
	}
	if sk.Version == "" || !strings.Contains(sk.Body, "Hand-drawn Style Prompter") {
		t.Fatalf("unexpected bundled content/version: ver=%q len=%d", sk.Version, len(sk.Body))
	}

	// Custom skill installed later must still sort after built-in skill.
	if _, err := mgr.InstallInline("custom-a", "自定义测试", "desc", "# custom", "inline"); err != nil {
		t.Fatalf("InstallInline failed: %v", err)
	}
	list, err := mgr.List()
	if err != nil || len(list) != 2 || list[0].ID != BuiltinHandrawSkillID {
		t.Fatalf("expected builtin skill first in list, got %+v err=%v", list, err)
	}

	// SetEnabled must preserve Builtin and Version metadata.
	disabled, err := mgr.SetEnabled(BuiltinHandrawSkillID, false)
	if err != nil || disabled.Enabled || !disabled.Builtin || disabled.Version != sk.Version {
		t.Fatalf("SetEnabled lost metadata: %+v err=%v", disabled, err)
	}
	if _, err := mgr.SetEnabled(BuiltinHandrawSkillID, true); err != nil {
		t.Fatalf("SetEnabled(true) failed: %v", err)
	}

	// Delete protection for built-in skill.
	if err := mgr.Remove(BuiltinHandrawSkillID); err == nil {
		t.Fatalf("expected Remove(builtin) to fail")
	}

	// Mock remote mirrors (mirror 1 returns 500 to verify fallback to mirror 2).
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/fail/version.json", "/fail/SKILL.md":
			http.Error(w, "upstream down", http.StatusInternalServerError)
		case "/ok/version.json":
			_, _ = w.Write([]byte(`{"version":"2.1.0"}`))
		case "/ok/SKILL.md":
			_, _ = w.Write([]byte("---\nname: handraw-skill\ndisplay_name: 手绘skill\ndescription: 新版手绘技能说明\nversion: 2.1.0\n---\n\n# Hand-drawn Style Prompter v2.1.0\n\n动态热更新内容生效。"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	origMirrors := BuiltinHandrawMirrors
	BuiltinHandrawMirrors = []struct {
		SkillURL   string
		VersionURL string
	}{
		{SkillURL: ts.URL + "/fail/SKILL.md", VersionURL: ts.URL + "/fail/version.json"},
		{SkillURL: ts.URL + "/ok/SKILL.md", VersionURL: ts.URL + "/ok/version.json"},
	}
	defer func() { BuiltinHandrawMirrors = origMirrors }()

	chk, err := mgr.CheckUpdate(context.Background(), BuiltinHandrawSkillID)
	if err != nil {
		t.Fatalf("CheckUpdate failed: %v", err)
	}
	if !chk.UpdateAvailable || chk.LatestVersion != "2.1.0" {
		t.Fatalf("expected UpdateAvailable=true latest=2.1.0, got %+v", chk)
	}

	updated, changed, err := mgr.Update(context.Background(), BuiltinHandrawSkillID)
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if !changed || updated.Version != "2.1.0" || updated.UpdateAvailable {
		t.Fatalf("unexpected updated skill: changed=%v sk=%+v", changed, updated)
	}
	if !strings.Contains(updated.Body, "动态热更新内容生效") {
		t.Fatalf("expected hot-updated body, got %q", updated.Body)
	}

	// Second update against same remote should report changed=false.
	_, changed2, err := mgr.Update(context.Background(), BuiltinHandrawSkillID)
	if err != nil || changed2 {
		t.Fatalf("expected idempotent second update, changed=%v err=%v", changed2, err)
	}
}
