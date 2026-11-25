package server

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/yang0/handraw-client/internal/site"
)

func (s *Server) extensionSubmissionCreate(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	var body struct {
		Channel     string   `json:"channel"`
		Name        string   `json:"name"`
		Slug        string   `json:"slug,omitempty"`
		RepoURL     string   `json:"repoUrl"`
		HomepageURL string   `json:"homepageUrl,omitempty"`
		Description string   `json:"description"`
		AuthorName  string   `json:"authorName,omitempty"`
		Version     string   `json:"version,omitempty"`
		Category    string   `json:"category,omitempty"`
		Tags        []string `json:"tags,omitempty"`
		Contact     string   `json:"contact,omitempty"`
		Notes       string   `json:"notes,omitempty"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	payload := map[string]any{
		"channel":      strings.TrimSpace(body.Channel),
		"name":         strings.TrimSpace(body.Name),
		"slug":         strings.TrimSpace(body.Slug),
		"repoUrl":      strings.TrimSpace(body.RepoURL),
		"homepageUrl":  strings.TrimSpace(body.HomepageURL),
		"description":  strings.TrimSpace(body.Description),
		"authorName":   strings.TrimSpace(body.AuthorName),
		"version":      strings.TrimSpace(body.Version),
		"category":     strings.TrimSpace(body.Category),
		"tags":         body.Tags,
		"contact":      strings.TrimSpace(body.Contact),
		"notes":        strings.TrimSpace(body.Notes),
		"sourceClient": "desktop",
	}
	var resp map[string]any
	if err := s.Site.Do(r.Context(), http.MethodPost, "/api/extensions/submissions", payload, &resp); err != nil {
		return nil, err
	}
	if resp == nil {
		resp = map[string]any{"ok": true}
	}
	resp["siteBase"] = s.Site.Base()
	return resp, nil
}

func (s *Server) extensionSubmissionMine(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return map[string]any{
			"ok":       true,
			"loggedIn": false,
			"items":    []any{},
			"siteBase": s.Site.Base(),
		}, nil
	}
	qs := url.Values{}
	if ch := strings.TrimSpace(r.URL.Query().Get("channel")); ch != "" {
		qs.Set("channel", ch)
	}
	if lim := strings.TrimSpace(r.URL.Query().Get("limit")); lim != "" {
		qs.Set("limit", lim)
	}
	path := "/api/extensions/submissions/mine"
	if enc := qs.Encode(); enc != "" {
		path += "?" + enc
	}
	var resp map[string]any
	if err := s.Site.Do(r.Context(), http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	if resp == nil {
		resp = map[string]any{"ok": true, "items": []any{}}
	}
	resp["loggedIn"] = true
	resp["siteBase"] = s.Site.Base()
	return resp, nil
}
