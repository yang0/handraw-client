package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/yang0/handraw-client/internal/site"
)

// accountLevel passes through the website's creator level for the signed-in
// user. Older sites without levels answer {available:false} instead of an
// error, so the settings page keeps working.
func (s *Server) accountLevel(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return map[string]any{"loggedIn": false, "available": false}, nil
	}
	raw, err := s.Site.Level(r.Context())
	if err != nil {
		var ae *site.APIError
		if errors.As(err, &ae) && (ae.Status == 404 || ae.Status == 403) {
			return map[string]any{"loggedIn": true, "available": false}, nil
		}
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{"loggedIn": true, "available": false}, nil
	}
	out["loggedIn"] = true
	out["available"] = true
	out["siteBase"] = s.Site.Base()
	return out, nil
}
