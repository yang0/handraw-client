package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/skills"
)

func TestBuiltinHandrawSkillEndpointsAndHotUpdate(t *testing.T) {
	srv := New("test")
	srv.Skills = skills.New(t.TempDir())
	if err := srv.Skills.EnsureBuiltin(); err != nil {
		t.Fatalf("EnsureBuiltin: %v", err)
	}

	do := func(method, path string, body any) *httptest.ResponseRecorder {
		var rdr *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rdr = bytes.NewReader(b)
		} else {
			rdr = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, "http://127.0.0.1"+path, rdr)
		req.Header.Set("X-Handraw-Token", srv.Token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		return rec
	}

	// 1. GET /api/skills returns built-in handraw-skill
	rec := do(http.MethodGet, "/api/skills", nil)
	if rec.Code != 200 {
		t.Fatalf("GET /api/skills status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listResp struct {
		Items []skills.Skill `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("decode /api/skills: %v", err)
	}
	if len(listResp.Items) == 0 || listResp.Items[0].ID != skills.BuiltinHandrawSkillID || !listResp.Items[0].Builtin {
		t.Fatalf("expected builtin handraw-skill first, got %+v", listResp.Items)
	}

	// 2. DELETE /api/skills/handraw-skill is blocked with 400
	delRec := do(http.MethodDelete, "/api/skills/"+skills.BuiltinHandrawSkillID, nil)
	if delRec.Code != 400 {
		t.Fatalf("expected 400 deleting builtin skill, got %d body=%s", delRec.Code, delRec.Body.String())
	}

	// 3. Mock mirror for check-updates + hot-update + /update-skill slash command
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/version.json":
			_, _ = w.Write([]byte(`{"version":"2.2.0"}`))
		case "/SKILL.md":
			_, _ = w.Write([]byte("---\nname: handraw-skill\ndisplay_name: 手绘skill\ndescription: 官方手绘新版本\nversion: 2.2.0\n---\n\n# Handraw 2.2.0\n\n免重启生效测试。"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	origMirrors := skills.BuiltinHandrawMirrors
	skills.BuiltinHandrawMirrors = []struct {
		SkillURL   string
		VersionURL string
	}{{SkillURL: ts.URL + "/SKILL.md", VersionURL: ts.URL + "/version.json"}}
	defer func() { skills.BuiltinHandrawMirrors = origMirrors }()

	chkRec := do(http.MethodPost, "/api/skills/check-updates", nil)
	if chkRec.Code != 200 {
		t.Fatalf("check-updates status=%d body=%s", chkRec.Code, chkRec.Body.String())
	}
	if !strings.Contains(chkRec.Body.String(), `"updateAvailable":true`) || !strings.Contains(chkRec.Body.String(), `"latestVersion":"2.2.0"`) {
		t.Fatalf("unexpected check-updates response: %s", chkRec.Body.String())
	}

	updRec := do(http.MethodPost, "/api/skills/"+skills.BuiltinHandrawSkillID+"/update", nil)
	if updRec.Code != 200 {
		t.Fatalf("update status=%d body=%s", updRec.Code, updRec.Body.String())
	}
	var updResp struct {
		OK      bool         `json:"ok"`
		Updated bool         `json:"updated"`
		Version string       `json:"version"`
		Skill   skills.Skill `json:"skill"`
	}
	if err := json.Unmarshal(updRec.Body.Bytes(), &updResp); err != nil {
		t.Fatalf("decode update resp: %v", err)
	}
	if !updResp.OK || !updResp.Updated || updResp.Version != "2.2.0" || !strings.Contains(updResp.Skill.Body, "免重启生效测试") {
		t.Fatalf("unexpected update response: %+v", updResp)
	}

	// 4. Chat slash command /update-skill works immediately
	chatRec := do(http.MethodPost, "/api/chat/turn", map[string]any{
		"messages": []map[string]string{{"role": "user", "content": "/update-skill"}},
	})
	if chatRec.Code != 200 {
		t.Fatalf("chat /update-skill status=%d body=%s", chatRec.Code, chatRec.Body.String())
	}
	if !strings.Contains(chatRec.Body.String(), `"skillsChanged":true`) || !strings.Contains(chatRec.Body.String(), "2.2.0") {
		t.Fatalf("unexpected chat /update-skill body: %s", chatRec.Body.String())
	}
}
