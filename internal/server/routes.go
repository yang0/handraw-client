package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/store"
)

func dataRoot() string { return appdir.Root() }

func (s *Server) routes() {
	m := http.NewServeMux()
	s.mux = m

	// boot + events
	m.HandleFunc("GET /api/boot", s.h(s.boot))
	m.HandleFunc("GET /api/events", s.events.serve)

	// resources (local pack + my own)
	m.HandleFunc("GET /api/resources/summary", s.h(s.resSummary))
	m.HandleFunc("GET /api/resources/styles", s.h(s.resStyles))
	m.HandleFunc("GET /api/resources/styles/{id}", s.h(s.resStyle))
	m.HandleFunc("GET /api/resources/styles/{id}/similar", s.h(s.resSimilar))
	m.HandleFunc("GET /api/resources/layouts", s.h(s.resLayouts))
	m.HandleFunc("GET /api/resources/colors", s.h(s.resColors))
	m.HandleFunc("GET /api/resources/tones", s.h(s.resTones))
	m.HandleFunc("GET /api/resources/assets", s.h(s.resAssets))
	m.HandleFunc("GET /api/resources/random", s.h(s.resRandom))
	m.HandleFunc("GET /files/pack/", s.filePack)
	m.HandleFunc("GET /files/local", s.fileLocal)
	m.HandleFunc("GET /files/remote", s.fileRemote)
	m.HandleFunc("GET /files/plugin/{id}/", s.filePlugin)

	// my styles / layouts / recipes
	m.HandleFunc("GET /api/mine/{kind}", s.h(s.mineList))
	m.HandleFunc("POST /api/mine/{kind}", s.h(s.minePut))
	m.HandleFunc("DELETE /api/mine/{kind}/{id}", s.h(s.mineDelete))
	m.HandleFunc("POST /api/mine/sync", s.h(s.mineSync))
	m.HandleFunc("POST /api/mine/{kind}/{id}/publish", s.h(s.minePublish))
	m.HandleFunc("POST /api/mine/analyze", s.h(s.mineAnalyze))
	m.HandleFunc("POST /api/mine/upload", s.h(s.uploadImage))

	// create
	m.HandleFunc("POST /api/prompt", s.h(s.buildPrompt))
	m.HandleFunc("POST /api/prompt/expand", s.h(s.expandTheme))
	m.HandleFunc("GET /api/models", s.h(s.models))
	m.HandleFunc("POST /api/quote", s.h(s.quote))
	m.HandleFunc("POST /api/generate", s.h(s.generate))
	m.HandleFunc("POST /api/series/plan", s.h(s.seriesPlan))
	m.HandleFunc("POST /api/article/plan", s.h(s.articlePlan))
	m.HandleFunc("POST /api/article/import", s.h(s.articleImport))
	m.HandleFunc("POST /api/article/export", s.h(s.articleExport))
	m.HandleFunc("POST /api/canvas/assistant", s.h(s.canvasAssistant))
	m.HandleFunc("POST /api/images/import", s.h(s.uploadImage))

	// docs: articles, canvases (+ sync)
	m.HandleFunc("GET /api/docs/{kind}", s.h(s.docList))
	m.HandleFunc("GET /api/docs/{kind}/{id}", s.h(s.docGet))
	m.HandleFunc("PUT /api/docs/{kind}/{id}", s.h(s.docPut))
	m.HandleFunc("DELETE /api/docs/{kind}/{id}", s.h(s.docDelete))
	m.HandleFunc("POST /api/canvas/sync", s.h(s.canvasSync))

	// works
	m.HandleFunc("GET /api/works", s.h(s.works))
	m.HandleFunc("GET /api/works/{id}", s.h(s.work))
	m.HandleFunc("PATCH /api/works/{id}", s.h(s.workPatch))
	m.HandleFunc("DELETE /api/works/{id}", s.h(s.workDelete))
	m.HandleFunc("POST /api/works/{id}/publish", s.h(s.workPublish))
	m.HandleFunc("POST /api/works/{id}/export", s.h(s.workExport))
	m.HandleFunc("POST /api/works/{id}/reveal", s.h(s.workReveal))
	m.HandleFunc("POST /api/images/{id}/retry", s.h(s.imageRetry))
	m.HandleFunc("POST /api/images/{id}/cancel", s.h(s.imageCancel))
	m.HandleFunc("POST /api/images/{id}/copy", s.h(s.imageCopy))
	m.HandleFunc("GET /api/queue", s.h(s.queue))

	// account + site
	m.HandleFunc("GET /api/account", s.h(s.account))
	m.HandleFunc("POST /api/account/login", s.h(s.loginStart))
	m.HandleFunc("GET /api/account/login", s.h(s.loginStatus))
	m.HandleFunc("POST /api/account/logout", s.h(s.logout))
	m.HandleFunc("GET /api/account/balance", s.h(s.balance))
	m.HandleFunc("GET /api/account/level", s.h(s.accountLevel))
	m.HandleFunc("GET /api/site/collections", s.h(s.siteCollections))
	m.HandleFunc("GET /api/site/history", s.h(s.siteHistory))
	m.HandleFunc("GET /api/site/discover", s.h(s.siteDiscover))
	m.HandleFunc("POST /api/site/history/{id}/download", s.h(s.siteHistoryDownload))
	m.HandleFunc("POST /api/open", s.h(s.open))

	// settings, providers, plugins, updates
	m.HandleFunc("GET /api/settings", s.h(s.getSettings))
	m.HandleFunc("PATCH /api/settings", s.h(s.patchSettings))
	m.HandleFunc("POST /api/providers", s.h(s.providerPut))
	m.HandleFunc("DELETE /api/providers/{id}", s.h(s.providerDelete))
	m.HandleFunc("POST /api/providers/{id}/models", s.h(s.providerModels))
	m.HandleFunc("POST /api/providers/{id}/test", s.h(s.providerTest))
	m.HandleFunc("GET /api/plugins", s.h(s.pluginList))
	m.HandleFunc("PATCH /api/plugins/{id}", s.h(s.pluginPatch))
	m.HandleFunc("POST /api/plugins/install", s.h(s.pluginInstall))
	m.HandleFunc("DELETE /api/plugins/{id}", s.h(s.pluginRemove))
	m.HandleFunc("POST /api/plugins/{id}/call", s.h(s.pluginCall))
	m.HandleFunc("GET /api/update", s.h(s.updateStatus))
	m.HandleFunc("POST /api/update/check", s.h(s.updateCheck))
	m.HandleFunc("POST /api/update/download", s.h(s.updateDownload))
	m.HandleFunc("POST /api/update/apply", s.h(s.updateApply))
	m.HandleFunc("POST /api/update/resources", s.h(s.updateResources))
	m.HandleFunc("POST /api/quick/hide", s.h(func(w http.ResponseWriter, r *http.Request) (any, error) { s.Host.HideQuick(); return okv, nil }))
	m.HandleFunc("POST /api/window/main", s.h(func(w http.ResponseWriter, r *http.Request) (any, error) { s.Host.ShowMain(); return okv, nil }))

	// UI
	m.HandleFunc("/", s.ui)
}

func (s *Server) ui(w http.ResponseWriter, r *http.Request) {
	if s.Web == nil {
		http.NotFound(w, r)
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" || p == "." {
		p = "index.html"
	}
	if _, err := fs.Stat(s.Web, p); err != nil {
		p = "index.html"
	}
	if p == "index.html" || p == "quick.html" {
		// The page needs the API token; a cookie scoped to this origin carries it.
		http.SetCookie(w, &http.Cookie{Name: "hw", Value: s.Token, Path: "/", HttpOnly: false, SameSite: http.SameSiteStrictMode})
		w.Header().Set("Cache-Control", "no-store")
	}
	http.ServeFileFS(w, r, s.Web, p)
}

func (s *Server) boot(w http.ResponseWriter, r *http.Request) (any, error) {
	p := s.Pack()
	out := map[string]any{"version": s.Version, "token": s.Token, "stats": s.DB.Stats(), "dataDir": dataRoot()}
	if p != nil {
		out["pack"] = map[string]any{"version": p.Version, "styles": len(p.Styles), "layouts": len(p.Layouts), "colors": len(p.Colors), "tones": len(p.Tones)}
	}
	out["plugins"] = s.Plugins.States()
	return out, nil
}

// customResources returns the user's own styles and layouts as resources.
func (s *Server) customResources() ([]resources.Style, []resources.Layout) {
	var styles []resources.Style
	var layouts []resources.Layout
	if s.DB == nil {
		return nil, nil
	}
	if docs, err := s.DB.ListDocs("style", false); err == nil {
		for _, d := range docs {
			var st resources.Style
			if json.Unmarshal(d.Data, &st) == nil && st.Number != "" {
				st.Source = "mine"
				styles = append(styles, st)
			}
		}
	}
	if docs, err := s.DB.ListDocs("layout", false); err == nil {
		for _, d := range docs {
			var l resources.Layout
			if json.Unmarshal(d.Data, &l) == nil && l.ID != "" {
				l.Source = "mine"
				layouts = append(layouts, l)
			}
		}
	}
	return styles, layouts
}

var _ = store.Now
