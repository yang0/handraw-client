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
