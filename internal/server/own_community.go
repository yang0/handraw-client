package server

import (
	"context"
	"encoding/json"
	"strings"
)

// ownCommunityAliases maps community codes (upper-case) that were published
// from the user's own personal styles/layouts to the local resource code
// (MY-S-* / MY-L-*). Pickers show one card per resource, and the owner keeps
// full prompt access through the local copy (#170).
//
// Matching, strongest first: the publish state stored next to the local doc,
// the website's owner-only personalResourceId, then an isMine community item
// whose name matches exactly one local resource of the same kind.
type ownAliases struct {
	styles  map[string]string
	layouts map[string]string
}

func (a ownAliases) lookup(kind, code string) (string, bool) {
	m := a.styles
	if kind == "layout" {
		m = a.layouts
	}
	v, ok := m[strings.ToUpper(strings.TrimSpace(code))]
	return v, ok && v != ""
}

type ownLocalRes struct {
	docID, remoteID, code, name string
}

func (s *Server) ownCommunityAliases(snap communityCatalogSnapshot) ownAliases {
	out := ownAliases{styles: map[string]string{}, layouts: map[string]string{}}
	if s.DB == nil {
		return out
	}
	load := func(kind string) []ownLocalRes {
		docs, err := s.DB.ListDocs(kind, false)
		if err != nil {
			return nil
		}
		var list []ownLocalRes
		for _, d := range docs {
			var v struct {
				Number         string `json:"number"`
				ID             string `json:"id"`
				Name           string `json:"name"`
				NameZh         string `json:"nameZh"`
				GenerationName string `json:"generation_name"`
			}
			if json.Unmarshal(d.Data, &v) != nil {
				continue
			}
			code := v.Number
			if kind == "layout" {
				code = v.ID
			}
			if strings.TrimSpace(code) == "" {
				continue
			}
			list = append(list, ownLocalRes{docID: d.ID, remoteID: d.RemoteID, code: code,
				name: firstStr(d.Name, v.NameZh, v.GenerationName, v.Name)})
		}
		return list
	}
	type remote struct {
		code, name, personalID string
		mine                   bool
	}
	build := func(kind string, locals []ownLocalRes, remotes []remote, dst map[string]string) {
		for _, l := range locals {
			if raw := s.publishedState(l.docID); raw != nil {
				var pub struct {
					Code string `json:"code"`
				}
				if json.Unmarshal(raw, &pub) == nil && strings.TrimSpace(pub.Code) != "" {
					dst[strings.ToUpper(strings.TrimSpace(pub.Code))] = l.code
				}
			}
		}
		byRemote := map[string]string{}
		byName := map[string][]string{}
		for _, l := range locals {
			if l.remoteID != "" {
				byRemote[l.remoteID] = l.code
			}
			if n := strings.ToLower(strings.TrimSpace(l.name)); n != "" {
				byName[n] = append(byName[n], l.code)
			}
		}
		for _, r := range remotes {
			key := strings.ToUpper(strings.TrimSpace(r.code))
			if key == "" || dst[key] != "" || !r.mine {
				continue
			}
			if c := byRemote[strings.TrimSpace(r.personalID)]; r.personalID != "" && c != "" {
				dst[key] = c
				continue
			}
			if c := byName[strings.ToLower(strings.TrimSpace(r.name))]; len(c) == 1 {
				dst[key] = c[0]
			}
		}
	}
	var rs []remote
	for _, st := range snap.Styles {
		rs = append(rs, remote{st.Number, firstStr(st.NameZh, st.GenerationName), st.PersonalResourceID, st.IsMine})
	}
	build("style", load("style"), rs, out.styles)
	var rl []remote
	for _, l := range snap.Layouts {
		rl = append(rl, remote{l.ID, l.Name, l.PersonalResourceID, l.IsMine})
	}
	build("layout", load("layout"), rl, out.layouts)
	return out
}

// resolveOwnCode rewrites a community code that belongs to one of the user's
// own resources to its local code, so generation uses the local definition.
func (s *Server) resolveOwnCode(ctx context.Context, kind, code string) string {
	if strings.TrimSpace(code) == "" || s.Site == nil {
		return code
	}
	p := s.Pack()
	if p != nil {
		if kind == "layout" {
			if _, ok := p.Layout(code); ok {
				return code
			}
		} else if _, ok := p.Style(code); ok {
			return code
		}
	}
	if local, ok := s.ownCommunityAliases(s.communityCatalog(ctx, false)).lookup(kind, code); ok {
		return local
	}
	return code
}
