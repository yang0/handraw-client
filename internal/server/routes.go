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

	// extensible galleries (built-in + pack/personal JSON + plugin-contributed + market) (#48, #122)
	m.HandleFunc("GET /api/galleries", s.h(s.galleryList))
	m.HandleFunc("GET /api/galleries/market", s.h(s.galleryMarketList))
	m.HandleFunc("POST /api/galleries/market/sources", s.h(s.galleryMarketAddSource))
	m.HandleFunc("DELETE /api/galleries/market/sources/{id}", s.h(s.galleryMarketRemoveSource))
	m.HandleFunc("POST /api/galleries/market/install", s.h(s.galleryPacksInstall))
	m.HandleFunc("POST /api/galleries/market/{id}/uninstall", s.h(s.galleryPackUninstall))
	m.HandleFunc("GET /api/galleries/packs", s.h(s.galleryPacksList))
	m.HandleFunc("POST /api/galleries/packs/install", s.h(s.galleryPacksInstall))
	m.HandleFunc("POST /api/galleries/packs/{id}/uninstall", s.h(s.galleryPackUninstall))
	m.HandleFunc("GET /api/galleries/{kind}/items", s.h(s.galleryItems))
	m.HandleFunc("GET /api/galleries/{kind}/items/{id}", s.h(s.galleryItem))
	m.HandleFunc("GET /api/galleries/{kind}/items/{id}/image", s.galleryItemImage)
	m.HandleFunc("POST /api/galleries/{kind}/items/{id}/materialize", s.h(s.galleryItemMaterialize))
	m.HandleFunc("GET /api/host/models", s.h(s.hostModelsList))
	m.HandleFunc("POST /api/host/models/chat", s.h(s.hostModelsChat))
	m.HandleFunc("GET /api/host/skills", s.h(s.hostSkillsList))
	m.HandleFunc("GET /api/host/skills/{id}", s.h(s.hostSkillGet))
	m.HandleFunc("POST /api/host/pick-directory", s.h(s.hostPickDirectory))
	m.HandleFunc("POST /api/host/galleries/register", s.h(s.hostGalleryRegister))
	m.HandleFunc("DELETE /api/host/galleries/{kind}", s.h(s.hostGalleryUnregister))

	m.HandleFunc("GET /files/pack/", s.filePack)
	m.HandleFunc("GET /files/local", s.fileLocal)
	m.HandleFunc("GET /files/vault-asset", s.fileVaultAsset)
	m.HandleFunc("GET /files/remote", s.fileRemote)
	m.HandleFunc("GET /files/plugin/{id}/", s.filePlugin)
	m.HandleFunc("GET /files/dsh-client/{id}", s.dshClientFile)
	m.HandleFunc("GET /files/market-icon", s.marketIcon)

	// my styles / layouts / recipes / custom asset categories
	m.HandleFunc("GET /api/mine/asset-categories", s.h(s.mineAssetCategoriesList))
	m.HandleFunc("POST /api/mine/asset-categories", s.h(s.mineAssetCategorySave))
	m.HandleFunc("DELETE /api/mine/asset-categories/{key}", s.h(s.mineAssetCategoryDelete))
	m.HandleFunc("GET /api/mine/{kind}", s.h(s.mineList))
	m.HandleFunc("POST /api/mine/{kind}", s.h(s.minePut))
	m.HandleFunc("DELETE /api/mine/{kind}/{id}", s.h(s.mineDelete))
	m.HandleFunc("POST /api/mine/sync", s.h(s.mineSync))
	m.HandleFunc("POST /api/mine/recipes/sync", s.h(s.mineRecipesSync))
	m.HandleFunc("POST /api/mine/{kind}/{id}/publish", s.h(s.minePublish))
	m.HandleFunc("POST /api/mine/analyze", s.h(s.mineAnalyze))
	m.HandleFunc("POST /api/mine/upload", s.h(s.uploadImage))

	// chat + skills (#58, #60, #69)
	m.HandleFunc("GET /api/skills", s.h(s.skillList))
	m.HandleFunc("GET /api/skills/discover", s.h(s.skillDiscover))
	m.HandleFunc("POST /api/skills/import-local", s.h(s.skillImportLocal))
	m.HandleFunc("POST /api/skills/install", s.h(s.skillInstall))
	m.HandleFunc("POST /api/skills/check-updates", s.h(s.skillCheckUpdates))
	m.HandleFunc("POST /api/skills/{id}/update", s.h(s.skillUpdate))
	m.HandleFunc("PATCH /api/skills/{id}", s.h(s.skillPatch))
	m.HandleFunc("DELETE /api/skills/{id}", s.h(s.skillRemove))
	m.HandleFunc("POST /api/chat/turn", s.h(s.chatTurn))

	// create
	m.HandleFunc("POST /api/prompt", s.h(s.buildPrompt))
	m.HandleFunc("POST /api/prompt/expand", s.h(s.expandTheme))
	m.HandleFunc("GET /api/models", s.h(s.models))
	m.HandleFunc("POST /api/quote", s.h(s.quote))
	m.HandleFunc("POST /api/generate", s.h(s.generate))
	m.HandleFunc("POST /api/studio/chat-plan", s.h(s.studioChatPlan))
	m.HandleFunc("POST /api/series/plan", s.h(s.seriesPlan))
	m.HandleFunc("POST /api/article/plan", s.h(s.articlePlan))
	m.HandleFunc("POST /api/article/edit", s.h(s.articleEdit))
	m.HandleFunc("POST /api/article/import", s.h(s.articleImport))
	m.HandleFunc("POST /api/article/export", s.h(s.articleExport))
	m.HandleFunc("GET /api/article/vault/tree", s.h(s.articleVaultTree))
	m.HandleFunc("POST /api/article/vault/root", s.h(s.articleVaultSetRoot))
	m.HandleFunc("POST /api/article/vault/vaults", s.h(s.articleVaultAdd))
	m.HandleFunc("DELETE /api/article/vault/vaults", s.h(s.articleVaultRemove))
	m.HandleFunc("GET /api/article/vault/file", s.h(s.articleVaultReadFile))
	m.HandleFunc("PUT /api/article/vault/file", s.h(s.articleVaultWriteFile))
	m.HandleFunc("DELETE /api/article/vault/file", s.h(s.articleVaultDeleteFile))
	m.HandleFunc("POST /api/article/vault/mkdir", s.h(s.articleVaultMkdir))
	m.HandleFunc("POST /api/article/vault/rename", s.h(s.articleVaultRename))
	m.HandleFunc("POST /api/article/vault/duplicate", s.h(s.articleVaultDuplicate))
	m.HandleFunc("DELETE /api/article/vault/dir", s.h(s.articleVaultDeleteDir))
	m.HandleFunc("POST /api/article/vault/reveal", s.h(s.articleVaultReveal))
	m.HandleFunc("GET /api/article/vault/links", s.h(s.articleVaultLinks))
	m.HandleFunc("POST /api/article/vault/links/linkify", s.h(s.articleVaultLinkify))
	m.HandleFunc("GET /api/article/vault/table", s.h(s.articleVaultTable))
	m.HandleFunc("PATCH /api/article/vault/frontmatter", s.h(s.articleVaultPatchFrontmatter))
	m.HandleFunc("GET /api/article/vault/canvas", s.h(s.articleVaultReadCanvas))
	m.HandleFunc("PUT /api/article/vault/canvas", s.h(s.articleVaultWriteCanvas))
	m.HandleFunc("DELETE /api/article/vault/canvas", s.h(s.articleVaultDeleteCanvas))

	// article Obsidian plugin compatibility runtime & installer (#115)
	m.HandleFunc("GET /api/article/obsidian/plugins", s.h(s.articleObsidianPlugins))
	m.HandleFunc("GET /api/article/obsidian/discover", s.h(s.articleObsidianDiscover))
	m.HandleFunc("GET /api/article/obsidian/market", s.h(s.articleObsidianMarket))
	m.HandleFunc("POST /api/article/obsidian/install", s.h(s.articleObsidianInstall))
	m.HandleFunc("POST /api/article/obsidian/import-batch", s.h(s.articleObsidianImportBatch))
	m.HandleFunc("PATCH /api/article/obsidian/plugins/{id}", s.h(s.articleObsidianPatch))
	m.HandleFunc("DELETE /api/article/obsidian/plugins/{id}", s.h(s.articleObsidianDelete))
	m.HandleFunc("GET /api/article/obsidian/plugins/{id}/bundle", s.h(s.articleObsidianBundle))
	m.HandleFunc("GET /api/article/obsidian/plugins/{id}/data", s.h(s.articleObsidianReadData))
	m.HandleFunc("PUT /api/article/obsidian/plugins/{id}/data", s.h(s.articleObsidianWriteData))
	m.HandleFunc("GET /api/article/obsidian/secrets", s.h(s.articleObsidianSecretGet))
	m.HandleFunc("PUT /api/article/obsidian/secrets", s.h(s.articleObsidianSecretSet))
	m.HandleFunc("GET /api/article/obsidian/vault/list", s.h(s.articleObsidianVaultList))
	m.HandleFunc("GET /api/article/obsidian/vault/raw", s.h(s.articleObsidianVaultRawRead))
	m.HandleFunc("PUT /api/article/obsidian/vault/raw", s.h(s.articleObsidianVaultRawWrite))
	m.HandleFunc("DELETE /api/article/obsidian/vault/raw", s.h(s.articleObsidianVaultRawDelete))
	m.HandleFunc("POST /api/article/obsidian/request", s.h(s.articleObsidianRequestProxy))
	m.HandleFunc("POST /api/article/obsidian/desktop/fs", s.h(s.articleObsidianDesktopFS))
	m.HandleFunc("POST /api/article/obsidian/desktop/spawn", s.h(s.articleObsidianDesktopSpawn))

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

	// inspirations vault, AI organize, custom folders, prompt unlock & Chrome clipper (#73, #88, #99)
	m.HandleFunc("GET /api/inspirations", s.h(s.inspirationsList))
	m.HandleFunc("POST /api/inspirations", s.h(s.inspirationsCreate))
	m.HandleFunc("POST /api/inspirations/fetch-url", s.h(s.inspirationsFetchURL))
	m.HandleFunc("POST /api/inspirations/folders", s.h(s.inspirationsFolderCreate))
	m.HandleFunc("PATCH /api/inspirations/folders", s.h(s.inspirationsFolderRename))
	m.HandleFunc("DELETE /api/inspirations/folders", s.h(s.inspirationsFolderDelete))
	m.HandleFunc("POST /api/inspirations/batch-folder", s.h(s.inspirationsBatchFolder))
	m.HandleFunc("PATCH /api/inspirations/{id}", s.h(s.inspirationsPatch))
	m.HandleFunc("DELETE /api/inspirations/{id}", s.h(s.inspirationsDelete))
	m.HandleFunc("GET /api/inspirations/clip/ping", s.h(s.inspirationsClipPing))
	m.HandleFunc("POST /api/inspirations/clip", s.h(s.inspirationsClip))
	m.HandleFunc("POST /api/inspirations/{id}/organize", s.h(s.inspirationsOrganize))
	m.HandleFunc("POST /api/inspirations/{id}/publish", s.h(s.inspirationsPublish))
	m.HandleFunc("POST /api/inspirations/materialize-refs", s.h(s.inspirationsMaterializeRefs))
	m.HandleFunc("POST /api/settings/clip-token/rotate", s.h(s.clipTokenRotate))

	// account + site
	m.HandleFunc("GET /api/account", s.h(s.account))
	m.HandleFunc("POST /api/account/login", s.h(s.loginStart))
	m.HandleFunc("GET /api/account/login", s.h(s.loginStatus))
	m.HandleFunc("POST /api/account/login/cancel", s.h(s.loginCancel))
	m.HandleFunc("POST /api/account/logout", s.h(s.logout))
	m.HandleFunc("GET /api/account/balance", s.h(s.balance))
	m.HandleFunc("GET /api/account/level", s.h(s.accountLevel))
	m.HandleFunc("GET /api/site/collections", s.h(s.siteCollections))
	m.HandleFunc("POST /api/site/collections/toggle", s.h(s.siteCollectionsToggle))
	m.HandleFunc("GET /api/site/history", s.h(s.siteHistory))
	m.HandleFunc("GET /api/site/discover", s.h(s.siteDiscover))
	m.HandleFunc("GET /api/site/works/{id}", s.h(s.siteWorkDetail))
	m.HandleFunc("POST /api/site/works/{id}/unlock", s.h(s.siteWorkUnlock))
	m.HandleFunc("GET /api/site/inspirations", s.h(s.siteInspirationsFeed))
	m.HandleFunc("GET /api/site/inspirations/{id}", s.h(s.siteInspirationDetail))
	m.HandleFunc("POST /api/site/inspirations/{id}/unlock", s.h(s.siteInspirationUnlock))
	m.HandleFunc("GET /api/site/inspirations/{id}/comments", s.h(s.siteInspirationCommentsList))
	m.HandleFunc("POST /api/site/inspirations/{id}/comments", s.h(s.siteInspirationCommentCreate))
	m.HandleFunc("GET /api/site/creator-earnings", s.h(s.siteCreatorEarnings))
	m.HandleFunc("POST /api/site/history/{id}/download", s.h(s.siteHistoryDownload))
	m.HandleFunc("POST /api/open", s.h(s.open))

	// settings, providers, harnesses, plugins, updates
	m.HandleFunc("GET /api/settings", s.h(s.getSettings))
	m.HandleFunc("PATCH /api/settings", s.h(s.patchSettings))
	m.HandleFunc("POST /api/settings/works-dir/inspect", s.h(s.inspectWorksDir))
	m.HandleFunc("POST /api/settings/works-dir/switch", s.h(s.switchWorksDir))
	m.HandleFunc("GET /api/harnesses", s.h(s.harnessesList))
	m.HandleFunc("PUT /api/harnesses/{id}", s.h(s.harnessPut))
	m.HandleFunc("DELETE /api/harnesses/{id}", s.h(s.harnessDelete))
	m.HandleFunc("POST /api/harnesses/{id}/test", s.h(s.harnessTest))
	m.HandleFunc("POST /api/providers", s.h(s.providerPut))
	m.HandleFunc("DELETE /api/providers/{id}", s.h(s.providerDelete))
	m.HandleFunc("POST /api/providers/{id}/models", s.h(s.providerModels))
	m.HandleFunc("POST /api/providers/{id}/test", s.h(s.providerTest))
	m.HandleFunc("GET /api/plugins", s.h(s.pluginList))
	m.HandleFunc("GET /api/plugins/updates", s.h(s.pluginUpdatesSummary))
	m.HandleFunc("POST /api/plugins/check", s.h(s.pluginCheckUpdates))
	m.HandleFunc("POST /api/plugins/update", s.h(s.pluginUpdateAll))
	m.HandleFunc("POST /api/plugins/{id}/update", s.h(s.pluginUpdateOne))
	m.HandleFunc("GET /api/plugins/dsh/discover", s.h(s.pluginDSHDiscover))
	m.HandleFunc("GET /api/plugins/dsh/status", s.h(s.pluginDSHStatus))
	m.HandleFunc("GET /api/plugins/market", s.h(s.pluginMarketList))
	m.HandleFunc("POST /api/plugins/market/sources", s.h(s.pluginMarketAddSource))
	m.HandleFunc("DELETE /api/plugins/market/sources/{id}", s.h(s.pluginMarketRemoveSource))
	m.HandleFunc("POST /api/plugins/market/install", s.h(s.pluginMarketInstall))
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
	if p == "index.html" || p == "quick.html" || p == "dsh-host.html" {
		// The page needs the API token; a cookie scoped to this origin carries it.
		http.SetCookie(w, &http.Cookie{Name: "hw", Value: s.Token, Path: "/", HttpOnly: false, SameSite: http.SameSiteStrictMode})
		w.Header().Set("Cache-Control", "no-store")
	} else if p == "obsidian-host.html" {
		// Sandboxed Obsidian plugin host: intentionally does NOT receive the API token cookie.
		w.Header().Set("Cache-Control", "no-store")
	} else if p == "js/obsidian-shim.js" {
		// Opaque-origin sandbox iframe loads this ES module via CORS.
		w.Header().Set("Access-Control-Allow-Origin", "*")
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
