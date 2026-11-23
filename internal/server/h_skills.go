package server

import (
	"io"
	"net/http"
	"strings"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/skills"
)

func (s *Server) skillsManager() *skills.Manager {
	if s.Skills == nil {
		s.Skills = skills.New(appdir.Skills())
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
