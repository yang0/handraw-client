package server

import (
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/skills"
)

func (s *Server) skillsManager() *skills.Manager {
	if s.Skills == nil {
		s.Skills = skills.New(appdir.Skills())
		_ = s.Skills.EnsureBuiltin()
	}
	return s.Skills
}

func (s *Server) skillList(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.skillsManager()
	items, err := mgr.List()
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []skills.Skill{}
	}
	return map[string]any{
		"items": items,
		"dir":   mgr.Dir(),
	}, nil
}

func (s *Server) skillInstall(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.skillsManager()
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(20 << 20); err != nil {
			return nil, bad(err.Error())
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			return nil, bad("请选择要上传的 SKILL.md 或 .zip 文件")
		}
		defer f.Close()
		raw, err := io.ReadAll(io.LimitReader(f, 16<<20))
		if err != nil {
			return nil, err
		}
		sk, err := mgr.InstallFromBytes(hdr.Filename, raw, "upload:"+hdr.Filename)
		if err != nil {
			return nil, bad(err.Error())
		}
		s.Emit("skills", map[string]any{"updated": true, "id": sk.ID})
		return map[string]any{"skill": sk}, nil
	}

	var body struct {
		Source      string `json:"source"`
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Content     string `json:"content"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	var (
		sk  skills.Skill
		err error
	)
	if strings.TrimSpace(body.Source) != "" {
		sk, err = mgr.InstallFromSource(r.Context(), body.Source)
	} else {
		sk, err = mgr.InstallInline(body.ID, body.Name, body.Description, body.Content, "inline")
	}
	if err != nil {
		return nil, bad(err.Error())
	}
	s.Emit("skills", map[string]any{"updated": true, "id": sk.ID})
	return map[string]any{"skill": sk}, nil
}

func (s *Server) skillPatch(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Enabled *bool   `json:"enabled"`
		Content *string `json:"content"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	mgr := s.skillsManager()
	var (
		sk  skills.Skill
		err error
	)
	if body.Content != nil {
		sk, err = mgr.UpdateContent(id, *body.Content)
		if err != nil {
			return nil, bad(err.Error())
		}
	}
	if body.Enabled != nil {
		sk, err = mgr.SetEnabled(id, *body.Enabled)
		if err != nil {
			return nil, bad(err.Error())
		}
	}
	if body.Content == nil && body.Enabled == nil {
		sk, err = mgr.Get(id)
		if err != nil {
			return nil, notFound(err.Error())
		}
	}
	s.Emit("skills", map[string]any{"updated": true, "id": sk.ID})
	return map[string]any{"skill": sk}, nil
}

func (s *Server) skillRemove(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if err := s.skillsManager().Remove(id); err != nil {
		return nil, bad(err.Error())
	}
	s.Emit("skills", map[string]any{"updated": true, "removed": id})
	return okv, nil
}

func (s *Server) skillCheckUpdates(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.skillsManager()
	results := mgr.CheckAllUpdates(r.Context())
	if results == nil {
		results = []skills.UpdateCheckResult{}
	}
	s.Emit("skills", map[string]any{"checked": true})
	return map[string]any{"items": results}, nil
}

func (s *Server) skillUpdate(w http.ResponseWriter, r *http.Request) (any, error) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		id = skills.BuiltinHandrawSkillID
	}
	mgr := s.skillsManager()
	prev, _ := mgr.Get(id)
	sk, changed, err := mgr.Update(r.Context(), id)
	if err != nil {
		return nil, bad(err.Error())
	}
	s.Emit("skills", map[string]any{
		"updated": true,
		"changed": changed,
		"id":      sk.ID,
		"version": sk.Version,
	})
	return map[string]any{
		"ok":              true,
		"updated":         changed,
		"skill":           sk,
		"previousVersion": prev.Version,
		"version":         sk.Version,
	}, nil
}

func (s *Server) skillDiscover(w http.ResponseWriter, r *http.Request) (any, error) {
	mgr := s.skillsManager()
	extraDir := strings.TrimSpace(r.URL.Query().Get("extraDir"))
	homeOverride := strings.TrimSpace(os.Getenv("HANDRAW_SKILL_DISCOVER_HOME"))
	res := mgr.DiscoverHarnessSkills(homeOverride, extraDir)
	return res, nil
}

func (s *Server) skillImportLocal(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Items []struct {
			Dir        string `json:"dir"`
			ClientID   string `json:"clientId"`
			ClientName string `json:"clientName"`
		} `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if len(body.Items) == 0 {
		return nil, bad("请先勾选要导入的 Skill")
	}
	mgr := s.skillsManager()
	imported := make([]skills.Skill, 0, len(body.Items))
	failed := make([]map[string]string, 0)
	for _, it := range body.Items {
		dir := strings.TrimSpace(it.Dir)
		if dir == "" {
			continue
		}
		cid := strings.TrimSpace(it.ClientID)
		if cid == "" {
			cid = "local"
		}
		sourceTag := "harness:" + cid + ":" + dir
		sk, err := mgr.InstallFromLocalWithSource(dir, sourceTag)
		if err != nil {
			failed = append(failed, map[string]string{"dir": dir, "error": err.Error()})
			continue
		}
		imported = append(imported, sk)
	}
	if len(imported) > 0 {
		s.Emit("skills", map[string]any{"updated": true, "importedCount": len(imported)})
	}
	all, _ := mgr.List()
	if all == nil {
		all = []skills.Skill{}
	}
	return map[string]any{
		"ok":       len(imported) > 0 || len(failed) == 0,
		"imported": imported,
		"failed":   failed,
		"items":    all,
	}, nil
}
