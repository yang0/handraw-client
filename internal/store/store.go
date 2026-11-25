// Package store is the local SQLite index: runs (generation tasks), their
// images, and JSON documents (recipes, canvases, articles, personal library).
// Image files live on disk; the database only indexes them.
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct {
	sql *sql.DB
	mu  sync.Mutex // serialize writes; SQLite allows one writer
}

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  mode TEXT NOT NULL,            -- quick | single | series | article | canvas | edit
  title TEXT NOT NULL DEFAULT '',
  original_request TEXT NOT NULL DEFAULT '',
  prompt_zh TEXT NOT NULL DEFAULT '',
  prompt_en TEXT NOT NULL DEFAULT '',
  recipe TEXT NOT NULL DEFAULT '{}',
  model TEXT NOT NULL DEFAULT '',
  model_label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', -- site | provider
  cost_cents INTEGER NOT NULL DEFAULT 0,
  free_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | partial | failed | canceled
  error TEXT NOT NULL DEFAULT '',
  dir TEXT NOT NULL DEFAULT '',
  starred INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT NOT NULL DEFAULT '',  -- edits: the run this one revises
  group_id TEXT NOT NULL DEFAULT '',   -- article / canvas / series id
  remote_run_id TEXT NOT NULL DEFAULT '',
  published_work_id TEXT NOT NULL DEFAULT '',
  published_url TEXT NOT NULL DEFAULT '',
  published_inspiration_id TEXT NOT NULL DEFAULT '',
  published_inspiration_url TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS runs_group ON runs(group_id);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | canceled
  path TEXT NOT NULL DEFAULT '',
  thumb TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  remote_task_id TEXT NOT NULL DEFAULT '',
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS images_run ON images(run_id, idx);
CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL,          -- recipe | canvas | article | style | layout | asset | plugin
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  remote_id TEXT NOT NULL DEFAULT '',
  remote_rev INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0,  -- changed locally since last sync
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, id)
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS runs_fts USING fts5(run_id UNINDEXED, text, tokenize='trigram');
`

func Open(path string) (*DB, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)"
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(4)
	if _, err := d.Exec(schema); err != nil {
		d.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	// Idempotent column migrations for existing databases (#118).
	for _, ddl := range []string{
		`ALTER TABLE runs ADD COLUMN published_inspiration_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE runs ADD COLUMN published_inspiration_url TEXT NOT NULL DEFAULT ''`,
	} {
		_, _ = d.Exec(ddl)
	}
	return &DB{sql: d}, nil
}

func (d *DB) Close() error { return d.sql.Close() }

func Now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// ---------- runs ----------

type Run struct {
	ID              string          `json:"id"`
	CreatedAt       string          `json:"createdAt"`
	UpdatedAt       string          `json:"updatedAt"`
	Mode            string          `json:"mode"`
	Title           string          `json:"title"`
	OriginalRequest string          `json:"originalRequest"`
	PromptZh        string          `json:"promptZh"`
	PromptEn        string          `json:"promptEn"`
	Recipe          json.RawMessage `json:"recipe"`
	Model           string          `json:"model"`
	ModelLabel      string          `json:"modelLabel"`
	Source          string          `json:"source"`
	CostCents       int             `json:"costCents"`
	FreeCount       int             `json:"freeCount"`
	Status          string          `json:"status"`
	Error           string          `json:"error"`
	Dir             string          `json:"dir"`
	Starred         bool            `json:"starred"`
	ParentID        string          `json:"parentId"`
	GroupID         string          `json:"groupId"`
	RemoteRunID             string          `json:"remoteRunId"`
	PublishedWorkID         string          `json:"publishedWorkId"`
	PublishedURL            string          `json:"publishedUrl"`
	PublishedInspirationID  string          `json:"publishedInspirationId"`
	PublishedInspirationURL string          `json:"publishedInspirationUrl"`
	Meta                    json.RawMessage `json:"meta"`
	Images          []Image         `json:"images,omitempty"`
}

type Image struct {
	ID           string          `json:"id"`
	RunID        string          `json:"runId"`
	Idx          int             `json:"idx"`
	Status       string          `json:"status"`
	Path         string          `json:"path"`
	Thumb        string          `json:"thumb"`
	Width        int             `json:"width"`
	Height       int             `json:"height"`
	SHA256       string          `json:"sha256"`
	Theme        string          `json:"theme"`
	Prompt       string          `json:"prompt"`
	Error        string          `json:"error"`
	RemoteTaskID string          `json:"remoteTaskId"`
	CostCents    int             `json:"costCents"`
	CreatedAt    string          `json:"createdAt"`
	UpdatedAt    string          `json:"updatedAt"`
	Meta         json.RawMessage `json:"meta"`
}

const runCols = `id, created_at, updated_at, mode, title, original_request, prompt_zh, prompt_en, recipe, model, model_label, source, cost_cents, free_count, status, error, dir, starred, parent_id, group_id, remote_run_id, published_work_id, published_url, published_inspiration_id, published_inspiration_url, meta`

func rawOr(b json.RawMessage, def string) string {
	if len(b) == 0 {
		return def
	}
	return string(b)
}

func (d *DB) InsertRun(r *Run, images []Image) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := Now()
	if r.CreatedAt == "" {
		r.CreatedAt = now
	}
	r.UpdatedAt = now
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO runs (`+runCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.CreatedAt, r.UpdatedAt, r.Mode, r.Title, r.OriginalRequest, r.PromptZh, r.PromptEn,
		rawOr(r.Recipe, "{}"), r.Model, r.ModelLabel, r.Source, r.CostCents, r.FreeCount, r.Status, r.Error,
		r.Dir, boolInt(r.Starred), r.ParentID, r.GroupID, r.RemoteRunID, r.PublishedWorkID, r.PublishedURL,
		r.PublishedInspirationID, r.PublishedInspirationURL, rawOr(r.Meta, "{}"))
	if err != nil {
		return err
	}
	for i := range images {
		im := &images[i]
		im.RunID = r.ID
		im.CreatedAt, im.UpdatedAt = now, now
		if im.Status == "" {
			im.Status = "queued"
		}
		if _, err := tx.Exec(`INSERT INTO images (id, run_id, idx, status, path, thumb, width, height, sha256, theme, prompt, error, remote_task_id, cost_cents, created_at, updated_at, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			im.ID, im.RunID, im.Idx, im.Status, im.Path, im.Thumb, im.Width, im.Height, im.SHA256, im.Theme, im.Prompt, im.Error, im.RemoteTaskID, im.CostCents, im.CreatedAt, im.UpdatedAt, rawOr(im.Meta, "{}")); err != nil {
			return err
		}
	}
	text := strings.Join([]string{r.Title, r.OriginalRequest, r.PromptZh, r.PromptEn}, "\n")
	if _, err := tx.Exec(`INSERT INTO runs_fts (run_id, text) VALUES (?, ?)`, r.ID, text); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateRun sets the given columns. Only whitelisted columns are accepted.
func (d *DB) UpdateRun(id string, fields map[string]any) error {
	return d.update("runs", runFields, id, fields)
}

func (d *DB) UpdateImage(id string, fields map[string]any) error {
	return d.update("images", imageFields, id, fields)
}

var runFields = map[string]bool{"title": true, "status": true, "error": true, "cost_cents": true, "free_count": true, "starred": true,
	"remote_run_id": true, "published_work_id": true, "published_url": true, "published_inspiration_id": true, "published_inspiration_url": true,
	"deleted_at": true, "meta": true, "prompt_zh": true, "prompt_en": true, "dir": true}
var imageFields = map[string]bool{"status": true, "path": true, "thumb": true, "width": true, "height": true, "sha256": true, "error": true,
	"remote_task_id": true, "cost_cents": true, "meta": true, "prompt": true}

func (d *DB) update(table string, allowed map[string]bool, id string, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	sets := []string{"updated_at = ?"}
	args := []any{Now()}
	for k, v := range fields {
		if !allowed[k] {
			return fmt.Errorf("field %q not updatable", k)
		}
		if b, ok := v.(bool); ok {
			v = boolInt(b)
		}
		if raw, ok := v.(json.RawMessage); ok {
			v = string(raw)
		}
		sets = append(sets, k+" = ?")
		args = append(args, v)
	}
	args = append(args, id)
	_, err := d.sql.Exec("UPDATE "+table+" SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...)
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func scanRun(sc interface{ Scan(...any) error }) (Run, error) {
	var r Run
	var recipe, meta string
	var starred int
	err := sc.Scan(&r.ID, &r.CreatedAt, &r.UpdatedAt, &r.Mode, &r.Title, &r.OriginalRequest, &r.PromptZh, &r.PromptEn,
		&recipe, &r.Model, &r.ModelLabel, &r.Source, &r.CostCents, &r.FreeCount, &r.Status, &r.Error, &r.Dir, &starred,
		&r.ParentID, &r.GroupID, &r.RemoteRunID, &r.PublishedWorkID, &r.PublishedURL, &r.PublishedInspirationID, &r.PublishedInspirationURL, &meta)
	r.Recipe = json.RawMessage(recipe)
	r.Meta = json.RawMessage(meta)
	r.Starred = starred == 1
	return r, err
}

func (d *DB) GetRun(id string) (Run, error) {
	row := d.sql.QueryRow(`SELECT `+runCols+` FROM runs WHERE id = ? AND deleted_at = ''`, id)
	r, err := scanRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	r.Images, err = d.Images(id)
	return r, err
}

func (d *DB) Images(runID string) ([]Image, error) {
	rows, err := d.sql.Query(`SELECT id, run_id, idx, status, path, thumb, width, height, sha256, theme, prompt, error, remote_task_id, cost_cents, created_at, updated_at, meta FROM images WHERE run_id = ? ORDER BY idx`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Image{}
	for rows.Next() {
		var im Image
		var meta string
		if err := rows.Scan(&im.ID, &im.RunID, &im.Idx, &im.Status, &im.Path, &im.Thumb, &im.Width, &im.Height, &im.SHA256, &im.Theme, &im.Prompt, &im.Error, &im.RemoteTaskID, &im.CostCents, &im.CreatedAt, &im.UpdatedAt, &meta); err != nil {
			return nil, err
		}
		im.Meta = json.RawMessage(meta)
		out = append(out, im)
	}
	return out, rows.Err()
}

func (d *DB) GetImage(id string) (Image, error) {
	var im Image
	var meta string
	err := d.sql.QueryRow(`SELECT id, run_id, idx, status, path, thumb, width, height, sha256, theme, prompt, error, remote_task_id, cost_cents, created_at, updated_at, meta FROM images WHERE id = ?`, id).
		Scan(&im.ID, &im.RunID, &im.Idx, &im.Status, &im.Path, &im.Thumb, &im.Width, &im.Height, &im.SHA256, &im.Theme, &im.Prompt, &im.Error, &im.RemoteTaskID, &im.CostCents, &im.CreatedAt, &im.UpdatedAt, &meta)
	if errors.Is(err, sql.ErrNoRows) {
		return im, ErrNotFound
	}
	im.Meta = json.RawMessage(meta)
	return im, err
}

type RunQuery struct {
	Search    string
	Mode      string
	Starred   bool
	Published string // "", "yes", "no", "1", "0"
	GroupID   string
	Status    string
	HasImages bool
	Limit     int
	Offset    int
}

func (d *DB) ListRuns(q RunQuery) ([]Run, int, error) {
	where := []string{"r.deleted_at = ''"}
	args := []any{}
	if q.Search != "" {
		s := strings.TrimSpace(q.Search)
		if len([]rune(s)) >= 3 {
			where = append(where, "r.id IN (SELECT run_id FROM runs_fts WHERE runs_fts MATCH ?)")
			args = append(args, `"`+strings.ReplaceAll(s, `"`, `""`)+`"`)
		} else {
			where = append(where, "(r.title LIKE ? OR r.original_request LIKE ? OR r.recipe LIKE ?)")
			like := "%" + s + "%"
			args = append(args, like, like, like)
		}
	}
	if q.Mode != "" {
		where = append(where, "r.mode = ?")
		args = append(args, q.Mode)
	}
	if q.Starred {
		where = append(where, "r.starred = 1")
	}
	if q.Published == "yes" || q.Published == "1" {
		where = append(where, "(r.published_work_id != '' OR r.published_inspiration_id != '')")
	} else if q.Published == "no" || q.Published == "0" {
		where = append(where, "(r.published_work_id = '' AND r.published_inspiration_id = '')")
	}
	if q.GroupID != "" {
		where = append(where, "r.group_id = ?")
		args = append(args, q.GroupID)
	}
	if q.Status != "" {
		where = append(where, "r.status = ?")
		args = append(args, q.Status)
	}
	if q.HasImages {
		where = append(where, "EXISTS (SELECT 1 FROM images i WHERE i.run_id = r.id AND i.status = 'done' AND i.path != '')")
	}
	w := strings.Join(where, " AND ")
	var total int
	if err := d.sql.QueryRow("SELECT COUNT(*) FROM runs r WHERE "+w, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if q.Limit <= 0 || q.Limit > 500 {
		q.Limit = 60
	}
	cols := "r." + strings.ReplaceAll(runCols, ", ", ", r.")
	rows, err := d.sql.Query("SELECT "+cols+" FROM runs r WHERE "+w+" ORDER BY r.created_at DESC LIMIT ? OFFSET ?", append(args, q.Limit, q.Offset)...)
	if err != nil {
		return nil, 0, err
	}
	var out []Run
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			rows.Close()
			return nil, 0, err
		}
		out = append(out, r)
	}
	rows.Close()
	for i := range out {
		out[i].Images, _ = d.Images(out[i].ID)
	}
	if out == nil {
		out = []Run{}
	}
	return out, total, nil
}

// ActiveImages returns images still queued or running (to resume after restart).
func (d *DB) ActiveImages() ([]Image, error) {
	rows, err := d.sql.Query(`SELECT id FROM images WHERE status IN ('queued','running') ORDER BY created_at, idx`)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	out := []Image{}
	for _, id := range ids {
		if im, err := d.GetImage(id); err == nil {
			out = append(out, im)
		}
	}
	return out, nil
}

func (d *DB) SoftDeleteRun(id string) error {
	return d.UpdateRun(id, map[string]any{"deleted_at": Now()})
}

// ---------- docs ----------

type Doc struct {
	Kind      string          `json:"kind"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Data      json.RawMessage `json:"data"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
	RemoteID  string          `json:"remoteId"`
	RemoteRev int             `json:"remoteRev"`
	Dirty     bool            `json:"dirty"`
	Deleted   bool            `json:"deleted"`
}

var ErrNotFound = errors.New("not found")

// PutDoc inserts or replaces a document. dirty marks it for upload.
func (d *DB) PutDoc(doc *Doc) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := Now()
	if doc.CreatedAt == "" {
		doc.CreatedAt = now
	}
	doc.UpdatedAt = now
	_, err := d.sql.Exec(`INSERT INTO docs (kind, id, name, data, created_at, updated_at, remote_id, remote_rev, dirty, deleted)
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(kind, id) DO UPDATE SET name=excluded.name, data=excluded.data, updated_at=excluded.updated_at,
 remote_id=excluded.remote_id, remote_rev=excluded.remote_rev, dirty=excluded.dirty, deleted=excluded.deleted`,
		doc.Kind, doc.ID, doc.Name, rawOr(doc.Data, "{}"), doc.CreatedAt, doc.UpdatedAt, doc.RemoteID, doc.RemoteRev, boolInt(doc.Dirty), boolInt(doc.Deleted))
	return err
}

func (d *DB) GetDoc(kind, id string) (Doc, error) {
	var doc Doc
	var data string
	var dirty, deleted int
	err := d.sql.QueryRow(`SELECT kind, id, name, data, created_at, updated_at, remote_id, remote_rev, dirty, deleted FROM docs WHERE kind = ? AND id = ?`, kind, id).
		Scan(&doc.Kind, &doc.ID, &doc.Name, &data, &doc.CreatedAt, &doc.UpdatedAt, &doc.RemoteID, &doc.RemoteRev, &dirty, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return doc, ErrNotFound
	}
	doc.Data = json.RawMessage(data)
	doc.Dirty, doc.Deleted = dirty == 1, deleted == 1
	return doc, err
}

// ListDocs lists documents of a kind; includeDeleted keeps tombstones (sync).
func (d *DB) ListDocs(kind string, includeDeleted bool) ([]Doc, error) {
	q := `SELECT kind, id, name, data, created_at, updated_at, remote_id, remote_rev, dirty, deleted FROM docs WHERE kind = ?`
	if !includeDeleted {
		q += " AND deleted = 0"
	}
	q += " ORDER BY updated_at DESC"
	rows, err := d.sql.Query(q, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Doc{}
	for rows.Next() {
		var doc Doc
		var data string
		var dirty, deleted int
		if err := rows.Scan(&doc.Kind, &doc.ID, &doc.Name, &data, &doc.CreatedAt, &doc.UpdatedAt, &doc.RemoteID, &doc.RemoteRev, &dirty, &deleted); err != nil {
			return nil, err
		}
		doc.Data = json.RawMessage(data)
		doc.Dirty, doc.Deleted = dirty == 1, deleted == 1
		out = append(out, doc)
	}
	return out, rows.Err()
}

func (d *DB) DeleteDocHard(kind, id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sql.Exec(`DELETE FROM docs WHERE kind = ? AND id = ?`, kind, id)
	return err
}

// ---------- kv ----------

func (d *DB) SetKV(key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err = d.sql.Exec(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, string(b))
	return err
}

func (d *DB) GetKV(key string, out any) error {
	var s string
	err := d.sql.QueryRow(`SELECT value FROM kv WHERE key = ?`, key).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(s), out)
}

// Stats summarizes the local library for the home page.
func (d *DB) Stats() map[string]int {
	out := map[string]int{}
	var n int
	d.sql.QueryRow(`SELECT COUNT(*) FROM runs WHERE deleted_at = ''`).Scan(&n)
	out["runs"] = n
	d.sql.QueryRow(`SELECT COUNT(*) FROM images i JOIN runs r ON r.id = i.run_id WHERE i.status = 'done' AND r.deleted_at = ''`).Scan(&n)
	out["images"] = n
	d.sql.QueryRow(`SELECT COALESCE(SUM(cost_cents),0) FROM runs WHERE deleted_at = ''`).Scan(&n)
	out["costCents"] = n
	return out
}

// PathRewriteStats reports how many database rows were updated when migrating
// a storage directory from one location to another.
type PathRewriteStats struct {
	Runs   int `json:"runs"`
	Images int `json:"images"`
	Docs   int `json:"docs"`
}

// RewritePathPrefix rewrites all stored file paths under oldRoot to point to
// newRoot across runs, images, and docs JSON payloads inside one transaction.
func (d *DB) RewritePathPrefix(oldRoot, newRoot string) (PathRewriteStats, error) {
	var stats PathRewriteStats
	oldClean := filepath.Clean(strings.TrimSpace(oldRoot))
	newClean := filepath.Clean(strings.TrimSpace(newRoot))
	if oldClean == "" || newClean == "" || samePathRoot(oldClean, newClean) {
		return stats, nil
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	tx, err := d.sql.Begin()
	if err != nil {
		return stats, err
	}
	defer tx.Rollback()

	// 1. Update runs.dir
	type idDir struct {
		id, dir string
	}
	var runUpdates []idDir
	if rows, err := tx.Query(`SELECT id, dir FROM runs WHERE dir != ''`); err != nil {
		return stats, err
	} else {
		for rows.Next() {
			var id, dir string
			if err := rows.Scan(&id, &dir); err != nil {
				rows.Close()
				return stats, err
			}
			if next, changed := RewritePath(dir, oldClean, newClean); changed {
				runUpdates = append(runUpdates, idDir{id: id, dir: next})
			}
		}
		rows.Close()
	}
	for _, u := range runUpdates {
		if _, err := tx.Exec(`UPDATE runs SET dir = ? WHERE id = ?`, u.dir, u.id); err != nil {
			return stats, err
		}
		stats.Runs++
	}

	// 2. Update images.path and images.thumb
	type imgUpd struct {
		id, path, thumb string
	}
	var imgUpdates []imgUpd
	if rows, err := tx.Query(`SELECT id, path, thumb FROM images WHERE path != '' OR thumb != ''`); err != nil {
		return stats, err
	} else {
		for rows.Next() {
			var id, p, th string
			if err := rows.Scan(&id, &p, &th); err != nil {
				rows.Close()
				return stats, err
			}
			nextP, c1 := RewritePath(p, oldClean, newClean)
			nextTh, c2 := RewritePath(th, oldClean, newClean)
			if c1 || c2 {
				imgUpdates = append(imgUpdates, imgUpd{id: id, path: nextP, thumb: nextTh})
			}
		}
		rows.Close()
	}
	for _, u := range imgUpdates {
		if _, err := tx.Exec(`UPDATE images SET path = ?, thumb = ? WHERE id = ?`, u.path, u.thumb, u.id); err != nil {
			return stats, err
		}
		stats.Images++
	}

	// 3. Update any local file paths embedded inside docs.data JSON (canvas, articles, recipes, etc.)
	type docUpd struct {
		kind, id, data string
	}
	var docUpdates []docUpd
	if rows, err := tx.Query(`SELECT kind, id, data FROM docs WHERE data != '' AND data != '{}'`); err != nil {
		return stats, err
	} else {
		for rows.Next() {
			var kind, id, data string
			if err := rows.Scan(&kind, &id, &data); err != nil {
				rows.Close()
				return stats, err
			}
			var decoded any
			if err := json.Unmarshal([]byte(data), &decoded); err != nil {
				continue
			}
			nextVal, changed := rewriteJSONPaths(decoded, oldClean, newClean)
			if !changed {
				continue
			}
			encoded, err := json.Marshal(nextVal)
			if err != nil {
				continue
			}
			docUpdates = append(docUpdates, docUpd{kind: kind, id: id, data: string(encoded)})
		}
		rows.Close()
	}
	for _, u := range docUpdates {
		if _, err := tx.Exec(`UPDATE docs SET data = ? WHERE kind = ? AND id = ?`, u.data, u.kind, u.id); err != nil {
			return stats, err
		}
		stats.Docs++
	}

	if err := tx.Commit(); err != nil {
		return stats, err
	}
	return stats, nil
}

// RewritePath replaces oldRoot prefix with newRoot if p equals oldRoot or is a
// child path under oldRoot (case-insensitive on Windows).
func RewritePath(p, oldRoot, newRoot string) (string, bool) {
	trimmed := strings.TrimSpace(p)
	if trimmed == "" {
		return p, false
	}
	cleanP := filepath.Clean(trimmed)
	cleanOld := filepath.Clean(oldRoot)
	cleanNew := filepath.Clean(newRoot)

	cmpP, cmpOld := cleanP, cleanOld
	if runtime.GOOS == "windows" {
		cmpP = strings.ToLower(cmpP)
		cmpOld = strings.ToLower(cmpOld)
	}
	if cmpP == cmpOld {
		return cleanNew, true
	}
	prefix := cmpOld
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	if strings.HasPrefix(cmpP, prefix) {
		rel := cleanP[len(cleanOld):]
		rel = strings.TrimLeft(rel, `/\`)
		return filepath.Join(cleanNew, rel), true
	}
	return p, false
}

func samePathRoot(a, b string) bool {
	ca, cb := filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

func rewriteJSONPaths(v any, oldRoot, newRoot string) (any, bool) {
	switch x := v.(type) {
	case string:
		return RewritePath(x, oldRoot, newRoot)
	case []any:
		changed := false
		for i, elem := range x {
			if nv, c := rewriteJSONPaths(elem, oldRoot, newRoot); c {
				x[i] = nv
				changed = true
			}
		}
		return x, changed
	case map[string]any:
		changed := false
		for k, val := range x {
			if nv, c := rewriteJSONPaths(val, oldRoot, newRoot); c {
				x[k] = nv
				changed = true
			}
		}
		return x, changed
	default:
		return v, false
	}
}
