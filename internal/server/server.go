// Package server is the local JSON API behind the window. It listens on
// 127.0.0.1 only and checks a per-run token so other local programs and web
// pages cannot drive it.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/dshbridge"
	"github.com/yang0/handraw-client/internal/galleries"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/plugins"
	"github.com/yang0/handraw-client/internal/profile"
	"github.com/yang0/handraw-client/internal/prompt"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/skills"
	"github.com/yang0/handraw-client/internal/store"
	"github.com/yang0/handraw-client/internal/updater"
)

// Host is what the native shell provides (windows, clipboard, browser).
type Host interface {
	OpenURL(url string) error
	OpenPath(path string) error
	CopyImage(path string) error
	CopyText(text string) error
	ShowMain()
	HideQuick()
	Restart()
	SetHotkey(spec string) error
}

type nopHost struct{}

func (nopHost) OpenURL(string) error     { return errors.New("no desktop host") }
func (nopHost) OpenPath(string) error    { return errors.New("no desktop host") }
func (nopHost) CopyImage(string) error   { return errors.New("no desktop host") }
func (nopHost) CopyText(string) error    { return errors.New("no desktop host") }
func (nopHost) ShowMain()                {}
func (nopHost) HideQuick()               {}
func (nopHost) Restart()                 {}
func (nopHost) SetHotkey(string) error   { return nil }

type Server struct {
	Version  string
	Token    string
	DB       *store.DB
	Site     *site.Client
	Jobs     *jobs.Manager
	Updater   *updater.Updater
	Plugins   *plugins.Runtime
	Skills    *skills.Manager
	Galleries *galleries.Registry
	DSH       *dshbridge.Manager
	Host      Host
	Web      fs.FS // embedded UI
	PackDir  string
	Bundled  string // pack shipped next to the program (first run)
	Log      *slog.Logger

	mux      *http.ServeMux
	events   *hub
	login    *loginState
	cacheMu  sync.Mutex
	cache    map[string]cached
	addr     string
}

type cached struct {
	at   time.Time
	data json.RawMessage
}

func New(version string) *Server {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	s := &Server{
		Version:   version,
		Token:     hex.EncodeToString(b),
		Skills:    skills.New(appdir.Skills()),
		Galleries: galleries.New(),
		DSH:       dshbridge.New(filepath.Join(appdir.Cache(), "dsh-bridge")),
		events:    newHub(),
		login:     &loginState{},
		cache:     map[string]cached{},
		Host:      nopHost{},
		Log:       slog.Default(),
	}
	_ = s.Skills.EnsureBuiltin()
	s.Galleries.OnChange = func() {
		s.Emit("galleries", map[string]any{"updated": true})
	}
	return s
}

// Emit pushes an event to every open page.
func (s *Server) Emit(kind string, data any) { s.events.send(kind, data) }

// Pack returns the current pack with the user's own styles and layouts merged in.
func (s *Server) Pack() *resources.Pack {
	p := resources.Current()
	if p == nil {
		return nil
	}
	styles, layouts := s.customResources()
	if len(styles) == 0 && len(layouts) == 0 {
		return p
	}
	return p.WithCustom(styles, layouts)
}

func (s *Server) Rules() prompt.Rules {
	if p := resources.Current(); p != nil {
		return prompt.RulesFrom(p.Rules)
	}
	return prompt.DefaultRules()
}

// DefaultPort is the fixed loopback port shared with the Chrome clipper
// extension so pairing survives client restarts without reconfiguring (#98).
const DefaultPort = 18520

// Listen starts the API on the requested loopback port (falling back to
// nearby ports or an ephemeral port only if already in use) and returns its base URL.
func (s *Server) Listen(ctx context.Context, port int) (string, error) {
	s.routes()
	var (
		ln  net.Listener
		err error
	)
	if port > 0 {
		for offset := 0; offset < 3; offset++ {
			ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port+offset))
			if err == nil {
				break
			}
		}
	}
	if ln == nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", err
		}
	}
	s.addr = "http://" + ln.Addr().String()
	if s.DSH != nil {
		s.DSH.SetHostEndpoint(s.addr, s.Token)
	}
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		if s.DSH != nil {
			s.DSH.Stop()
		}
		sh, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sh)
	}()
	go func() { _ = srv.Serve(ln) }()
	if s.DSH != nil && s.Plugins != nil {
		go func() { _ = s.SyncDSH(ctx) }()
	}
	// Background non-blocking check for built-in Handraw Skill updates.
	if s.Skills != nil {
		go func() {
			t := time.NewTimer(4 * time.Second)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			st := settings.Get()
			if !st.AutoCheckUpdate && !st.AutoSyncResources {
				return
			}
			cctx, cancel := context.WithTimeout(ctx, 12*time.Second)
			defer cancel()
			if st.AutoSyncResources {
				if sk, changed, err := s.Skills.Update(cctx, skills.BuiltinHandrawSkillID); err == nil && changed {
					s.Emit("skills", map[string]any{"updated": true, "changed": true, "id": sk.ID, "version": sk.Version})
				}
				return
			}
			if res, err := s.Skills.CheckUpdate(cctx, skills.BuiltinHandrawSkillID); err == nil && res.UpdateAvailable {
				s.Emit("skills", map[string]any{"checked": true, "id": res.ID, "latestVersion": res.LatestVersion})
			}
		}()
	}
	return s.addr, nil
}

// SyncDSH reconciles the optional Node DSH sidecar with enabled DSH plugins.
func (s *Server) SyncDSH(ctx context.Context) error {
	if s.DSH == nil || s.Plugins == nil {
		return nil
	}
	st := settings.Get()
	list := s.Plugins.ListCommunity(st.Plugins)
	return s.DSH.Sync(ctx, list)
}

func (s *Server) Addr() string { return s.addr }

// Handler wraps routes with the token guard. Pages get the token from boot.js.
func (s *Server) Handler() http.Handler {
	if s.mux == nil {
		s.routes()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Allow paired Chrome extension ("手绘风灵感捕手") to call ONLY the
		// dedicated local clip endpoints with X-Handraw-Clip-Token (#73).
		if isClipBridgePath(r.URL.Path) {
			if o := r.Header.Get("Origin"); strings.HasPrefix(o, "chrome-extension://") || strings.HasPrefix(o, "http://127.0.0.1") || strings.HasPrefix(o, "http://localhost") {
				w.Header().Set("Access-Control-Allow-Origin", o)
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Handraw-Clip-Token, X-Handraw-Token")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if !s.authorizedClip(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			s.mux.ServeHTTP(w, r)
			return
		}
		if s.DSH != nil && s.DSH.MatchRoute(r.URL.Path) {
			if !s.authorized(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			s.DSH.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/files/") {
			if !s.authorized(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) authorized(r *http.Request) bool {
	// Refuse requests from other sites (DNS rebinding / CSRF).
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host != "127.0.0.1" && host != "localhost" && host != "wails.localhost" && host != "" {
		return false
	}
	if o := r.Header.Get("Origin"); o != "" && o != "null" {
		if !(strings.HasPrefix(o, "http://127.0.0.1") || strings.HasPrefix(o, "http://localhost") || strings.HasPrefix(o, "wails://") || strings.HasPrefix(o, "http://wails.localhost") || strings.HasPrefix(o, "https://wails.localhost")) {
			return false
		}
	}
	tok := r.Header.Get("X-Handraw-Token")
	if tok == "" {
		tok = r.URL.Query().Get("t")
	}
	if tok == "" {
		if c, err := r.Cookie("hw"); err == nil {
			tok = c.Value
		}
	}
	return tok == s.Token
}

func isClipBridgePath(p string) bool {
	return p == "/api/inspirations/clip" || p == "/api/inspirations/clip/ping"
}

func (s *Server) authorizedClip(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host != "127.0.0.1" && host != "localhost" && host != "" {
		return false
	}
	if s.authorized(r) {
		return true
	}
	if o := r.Header.Get("Origin"); o != "" && o != "null" {
		if !strings.HasPrefix(o, "chrome-extension://") && !strings.HasPrefix(o, "http://127.0.0.1") && !strings.HasPrefix(o, "http://localhost") {
			return false
		}
	}
	clipTok := strings.TrimSpace(r.Header.Get("X-Handraw-Clip-Token"))
	expected := settings.EnsureClipToken()
	return clipTok != "" && expected != "" && clipTok == expected
}

// ---------- helpers ----------

type apiError struct {
	Status int
	Msg    string
	Code   string
}

func (e *apiError) Error() string { return e.Msg }

func bad(msg string) error             { return &apiError{Status: 400, Msg: msg} }
func notFound(msg string) error        { return &apiError{Status: 404, Msg: msg} }
func conflict(msg string) error        { return &apiError{Status: 409, Msg: msg, Code: "conflict"} }

type handler func(w http.ResponseWriter, r *http.Request) (any, error)

func (s *Server) h(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.Log.Error("panic", "path", r.URL.Path, "err", rec)
				writeJSON(w, 500, map[string]any{"error": fmt.Sprint("内部错误：", rec)})
			}
		}()
		out, err := fn(w, r)
		if err != nil {
			status := 500
			code := ""
			var ae *apiError
			var se *site.APIError
			switch {
			case errors.As(err, &ae):
				status, code = ae.Status, ae.Code
			case errors.As(err, &se):
				status, code = se.Status, se.Code
				if status < 400 {
					status = 502
				}
			case errors.Is(err, store.ErrNotFound):
				status = 404
			}
			writeJSON(w, status, map[string]any{"error": err.Error(), "code": code})
			return
		}
		if out == nil {
			return // handler wrote the response itself
		}
		writeJSON(w, 200, out)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if raw, ok := v.(json.RawMessage); ok {
		_, _ = w.Write(raw)
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}

func decode(r *http.Request, v any) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		return bad("读取请求失败")
	}
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, v); err != nil {
		return bad("请求格式错误：" + err.Error())
	}
	return nil
}

func qint(r *http.Request, name string, def int) int {
	if v, err := strconv.Atoi(r.URL.Query().Get(name)); err == nil {
		return v
	}
	return def
}

type ok struct {
	OK bool `json:"ok"`
}

var okv = ok{OK: true}

// ---------- file serving ----------

// serveFile serves a local file only if it is inside one of the allowed roots.
func (s *Server) serveLocal(w http.ResponseWriter, r *http.Request, path string) {
	clean, err := filepath.Abs(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	allowed := []string{settings.Get().WorksDir, s.PackDir, filepath.Dir(s.DBPathHint()), appdir.Galleries()}
	if tk := profile.TukuDir(); tk != "" {
		allowed = append(allowed, tk)
	}
	if p := resources.Current(); p != nil {
		allowed = append(allowed, p.ImageRoot)
	}
	okRoot := false
	for _, a := range allowed {
		if a == "" {
			continue
		}
		aa, _ := filepath.Abs(a)
		if strings.HasPrefix(strings.ToLower(clean), strings.ToLower(aa)+string(os.PathSeparator)) {
			okRoot = true
			break
		}
	}
	if !okRoot {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	st, err := os.Stat(clean)
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, clean)
}

// DBPathHint is the data root (library images live there).
func (s *Server) DBPathHint() string {
	return filepath.Join(dataRoot(), "x")
}
