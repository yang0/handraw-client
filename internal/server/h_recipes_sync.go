package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/profile"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
)

var recipeSyncMu sync.Mutex

type remoteRecipeWire struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	StyleIDs   []string `json:"styleIds"`
	LayoutID   string   `json:"layoutId"`
	Colors     []string `json:"colors"`
	Tones      []string `json:"tones"`
	Moods      []string `json:"moods"`
	Whitespace string   `json:"whitespace"`
	Ratio      string   `json:"ratio"`
	Mode       string   `json:"mode"`
	Notes      string   `json:"notes"`
	Revision   int      `json:"revision"`
	DeletedAt  string   `json:"deletedAt"`
	CreatedAt  string   `json:"createdAt"`
	UpdatedAt  string   `json:"updatedAt"`
}

func (rw remoteRecipeWire) toProfileRecipe() profile.Recipe {
	return profile.Recipe{
		SchemaVersion: 1,
		ID:            rw.ID,
		Name:          rw.Name,
		Kind:          "single",
		StyleIDs:      nonNilSlice(rw.StyleIDs),
		LayoutID:      rw.LayoutID,
		Colors:        nonNilSlice(rw.Colors),
		Tones:         nonNilSlice(rw.Tones),
		Moods:         nonNilSlice(rw.Moods),
		Whitespace:    rw.Whitespace,
		Ratio:         firstStr(rw.Ratio, "3:4"),
		Mode:          firstStr(rw.Mode, "graphic-text"),
		References:    []string{},
		Notes:         rw.Notes,
		Remote: &profile.RecipeRemote{
			ID:       rw.ID,
			Revision: rw.Revision,
		},
		SyncStatus: "synced",
		CreatedAt:  rw.CreatedAt,
		UpdatedAt:  rw.UpdatedAt,
	}
}

func nonNilSlice(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

func (s *Server) mineRecipesSync(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	return s.syncRecipesInternal(r.Context())
}

// migrateLegacyLocalRecipes upgrades any legacy ~/.handraw-style/recipes/rcp_local_*.json
// files to canonical UUIDs and registers them as dirty docs ready for cloud sync.
func (s *Server) migrateLegacyLocalRecipes() {
	list, err := profile.ListRecipes()
	if err != nil {
		return
	}
	for _, rec := range list {
		if strings.HasPrefix(rec.ID, "rcp_builtin_") || rec.Builtin {
			continue
		}
		if _, parseErr := uuid.Parse(rec.ID); parseErr == nil {
			// Ensure UUID file is also tracked in SQLite docs if missing.
			if _, dbErr := s.DB.GetDoc("recipe", rec.ID); dbErr != nil {
				rec.References = []string{}
				b, _ := json.Marshal(rec)
				remoteID := ""
				remoteRev := 0
				if rec.Remote != nil {
					remoteID = rec.Remote.ID
					remoteRev = rec.Remote.Revision
				}
				_ = s.DB.PutDoc(&store.Doc{
					Kind:      "recipe",
					ID:        rec.ID,
					Name:      rec.Name,
					Data:      b,
					RemoteID:  remoteID,
					RemoteRev: remoteRev,
					Dirty:     remoteID == "",
				})
			}
			continue
		}
		// Legacy non-UUID ID (e.g. rcp_local_xxx): assign a fresh UUID and replace file.
		oldID := rec.ID
		rec.ID = uuid.NewString()
		rec.Builtin = false
		rec.References = []string{}
		if strings.TrimSpace(rec.Name) == "" {
			rec.Name = "我的配方"
		}
		if saveErr := profile.SaveRecipe(&rec); saveErr == nil {
			_ = profile.DeleteRecipe(oldID)
			_ = s.DB.DeleteDocHard("recipe", oldID)
			b, _ := json.Marshal(rec)
			_ = s.DB.PutDoc(&store.Doc{
				Kind:  "recipe",
				ID:    rec.ID,
				Name:  rec.Name,
				Data:  b,
				Dirty: true,
			})
		}
	}
}

func (s *Server) syncRecipesInternal(ctx context.Context) (map[string]any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	recipeSyncMu.Lock()
	defer recipeSyncMu.Unlock()

	me, err := s.Site.Me(ctx)
	if err != nil {
		return nil, err
	}
	username, _ := me["username"].(string)
	syncState := profile.ReadSyncState(username)
	if syncState.Cursors == nil {
		syncState.Cursors = map[string]any{}
	}

	s.migrateLegacyLocalRecipes()

	pushed, pulled, conflictForks := 0, 0, 0

	// 1. Push dirty local recipes and soft-delete tombstones.
	docs, _ := s.DB.ListDocs("recipe", true)
	for _, d := range docs {
		if !d.Dirty {
			continue
		}
		if _, parseErr := uuid.Parse(d.ID); parseErr != nil {
			continue
		}
		if d.Deleted {
			if d.RemoteID != "" {
				q := ""
				if d.RemoteRev > 0 {
					q = fmt.Sprintf("?baseRevision=%d", d.RemoteRev)
				}
				_, err := s.Site.Send(ctx, "DELETE", "/api/v1/me/recipes/"+d.ID+q, nil)
				if err == nil || isNotFoundOrConflictDeleted(err) {
					_ = s.DB.DeleteDocHard("recipe", d.ID)
					_ = profile.DeleteRecipe(d.ID)
					pushed++
				}
			} else {
				_ = s.DB.DeleteDocHard("recipe", d.ID)
				_ = profile.DeleteRecipe(d.ID)
			}
			continue
		}

		var rec profile.Recipe
		if json.Unmarshal(d.Data, &rec) != nil || strings.TrimSpace(rec.Name) == "" {
			continue
		}
		payload := map[string]any{
			"id":         d.ID,
			"name":       strings.TrimSpace(rec.Name),
			"styleIds":   nonNilSlice(rec.StyleIDs),
			"layoutId":   strings.TrimSpace(rec.LayoutID),
			"colors":     nonNilSlice(rec.Colors),
			"tones":      nonNilSlice(rec.Tones),
			"moods":      nonNilSlice(rec.Moods),
			"whitespace": strings.TrimSpace(rec.Whitespace),
			"ratio":      firstStr(strings.TrimSpace(rec.Ratio), "3:4"),
			"mode":       firstStr(strings.TrimSpace(rec.Mode), "graphic-text"),
			"notes":      strings.TrimSpace(rec.Notes),
		}
		if d.RemoteRev > 0 {
			payload["baseRevision"] = d.RemoteRev
		}

		raw, err := s.Site.Send(ctx, "PUT", "/api/v1/me/recipes/"+d.ID, payload)
		if err != nil {
			var ae *site.APIError
			if errors.As(err, &ae) && ae.Status == 409 {
				// Conflict safety: preserve cloud version under d.ID and fork local edits as a new UUID copy.
				if s.resolveRecipeConflictFork(ctx, d, rec, string(ae.Raw)) {
					conflictForks++
					pushed++
				}
			}
			continue
		}

		var resp struct {
			Recipe remoteRecipeWire `json:"recipe"`
		}
		if json.Unmarshal(raw, &resp) == nil && resp.Recipe.ID != "" {
			saved := resp.Recipe.toProfileRecipe()
			_ = profile.SaveRecipe(&saved)
			b, _ := json.Marshal(saved)
			d.Name = saved.Name
			d.Data = b
			d.RemoteID = saved.ID
			d.RemoteRev = resp.Recipe.Revision
			d.Dirty = false
			_ = s.DB.PutDoc(&d)
			pushed++
		}
	}

	// 2. Pull incremental remote changes (including soft-delete tombstones).
	since, _ := syncState.Cursors["recipes"].(string)
	if since == "" {
		since = "0"
	}
	for pageNum := 0; pageNum < 20; pageNum++ {
		raw, err := s.Site.Get(ctx, "/api/v1/me/recipes?limit=100&includeDeleted=1&since="+url.QueryEscape(since))
		if err != nil {
			break
		}
		var page struct {
			Items      []remoteRecipeWire `json:"items"`
			NextCursor string             `json:"nextCursor"`
			HasMore    bool               `json:"hasMore"`
		}
		if json.Unmarshal(raw, &page) != nil {
			break
		}
		for _, it := range page.Items {
			if it.ID == "" {
				continue
			}
			if it.DeletedAt != "" {
				if localDoc, gErr := s.DB.GetDoc("recipe", it.ID); gErr == nil {
					if !localDoc.Dirty || it.Revision >= localDoc.RemoteRev {
						_ = s.DB.DeleteDocHard("recipe", it.ID)
						_ = profile.DeleteRecipe(it.ID)
						pulled++
					}
				} else {
					_ = profile.DeleteRecipe(it.ID)
				}
				continue
			}
			localDoc, gErr := s.DB.GetDoc("recipe", it.ID)
			if gErr == nil && localDoc.Dirty && localDoc.RemoteRev == it.Revision {
				// Local edits are still pending push on top of this same revision; keep local.
				continue
			}
			rec := it.toProfileRecipe()
			_ = profile.SaveRecipe(&rec)
			b, _ := json.Marshal(rec)
			_ = s.DB.PutDoc(&store.Doc{
				Kind:      "recipe",
				ID:        rec.ID,
				Name:      rec.Name,
				Data:      b,
				RemoteID:  rec.ID,
				RemoteRev: it.Revision,
				Dirty:     false,
			})
			pulled++
		}
		if page.NextCursor != "" && page.NextCursor != since {
			since = page.NextCursor
			syncState.Cursors["recipes"] = since
		}
		if !page.HasMore {
			break
		}
	}
	_ = profile.WriteSyncState(username, syncState)

	if pushed > 0 || pulled > 0 || conflictForks > 0 {
		s.Emit("recipes", map[string]any{"pushed": pushed, "pulled": pulled, "conflictForks": conflictForks})
	}
	return map[string]any{
		"ok":            true,
		"pushed":        pushed,
		"pulled":        pulled,
		"conflictForks": conflictForks,
	}, nil
}

func (s *Server) resolveRecipeConflictFork(ctx context.Context, d store.Doc, localRec profile.Recipe, errBody string) bool {
	var parsed struct {
		Current *remoteRecipeWire `json:"current"`
	}
	_ = json.Unmarshal([]byte(errBody), &parsed)
	if parsed.Current != nil && parsed.Current.ID != "" {
		if parsed.Current.DeletedAt != "" {
			_ = s.DB.DeleteDocHard("recipe", d.ID)
			_ = profile.DeleteRecipe(d.ID)
		} else {
			cloudRec := parsed.Current.toProfileRecipe()
			_ = profile.SaveRecipe(&cloudRec)
			cb, _ := json.Marshal(cloudRec)
			_ = s.DB.PutDoc(&store.Doc{
				Kind:      "recipe",
				ID:        cloudRec.ID,
				Name:      cloudRec.Name,
				Data:      cb,
				RemoteID:  cloudRec.ID,
				RemoteRev: parsed.Current.Revision,
				Dirty:     false,
			})
		}
	}

	// Fork local modifications under a brand new UUID so user never loses work.
	forkName := strings.TrimSpace(localRec.Name)
	const suffix = " (本地冲突副本)"
	if !strings.HasSuffix(forkName, suffix) {
		runes := []rune(forkName)
		maxBase := 60 - len([]rune(suffix))
		if len(runes) > maxBase {
			forkName = string(runes[:maxBase])
		}
		forkName += suffix
	}
	fork := localRec
	fork.ID = uuid.NewString()
	fork.Name = forkName
	fork.Remote = nil
	fork.References = []string{}
	_ = profile.SaveRecipe(&fork)
	fb, _ := json.Marshal(fork)
	forkDoc := store.Doc{
		Kind:  "recipe",
		ID:    fork.ID,
		Name:  fork.Name,
		Data:  fb,
		Dirty: true,
	}
	_ = s.DB.PutDoc(&forkDoc)

	// Push the forked copy immediately if possible.
	raw, err := s.Site.Send(ctx, "PUT", "/api/v1/me/recipes/"+fork.ID, map[string]any{
		"id":         fork.ID,
		"name":       fork.Name,
		"styleIds":   nonNilSlice(fork.StyleIDs),
		"layoutId":   strings.TrimSpace(fork.LayoutID),
		"colors":     nonNilSlice(fork.Colors),
		"tones":      nonNilSlice(fork.Tones),
		"moods":      nonNilSlice(fork.Moods),
		"whitespace": strings.TrimSpace(fork.Whitespace),
		"ratio":      firstStr(strings.TrimSpace(fork.Ratio), "3:4"),
		"mode":       firstStr(strings.TrimSpace(fork.Mode), "graphic-text"),
		"notes":      strings.TrimSpace(fork.Notes),
	})
	if err == nil {
		var resp struct {
			Recipe remoteRecipeWire `json:"recipe"`
		}
		if json.Unmarshal(raw, &resp) == nil && resp.Recipe.ID != "" {
			saved := resp.Recipe.toProfileRecipe()
			_ = profile.SaveRecipe(&saved)
			sb, _ := json.Marshal(saved)
			forkDoc.Data = sb
			forkDoc.RemoteID = saved.ID
			forkDoc.RemoteRev = resp.Recipe.Revision
			forkDoc.Dirty = false
			_ = s.DB.PutDoc(&forkDoc)
		}
	}
	return true
}

func isNotFoundOrConflictDeleted(err error) bool {
	if err == nil {
		return false
	}
	var ae *site.APIError
	if errors.As(err, &ae) && (ae.Status == 404 || (ae.Status == 409 && (strings.Contains(ae.Code, "deleted") || strings.Contains(string(ae.Raw), "deleted")))) {
		return true
	}
	return strings.Contains(err.Error(), "404")
}
