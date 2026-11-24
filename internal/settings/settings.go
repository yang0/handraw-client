// Package settings keeps the user's preferences in settings.json.
// Secrets (site token, API keys) never go here; see package secrets.
package settings

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/yang0/handraw-client/internal/appdir"
)

// Provider is a user-configured image or text/vision API. Its key lives in the keyring.
type Provider struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`    // "openai" (OpenAI compatible)
	Purpose string  `json:"purpose"` // "image" or "text" (text + vision)
	BaseURL string  `json:"baseUrl"`
	Models  []Model `json:"models"`
	Enabled bool    `json:"enabled"`
}

// Model is one model the user picked from a provider's catalog.
type Model struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Sizes       []string `json:"sizes,omitempty"` // e.g. 1024x1024
	PriceCents  int      `json:"priceCents,omitempty"`
	CanEdit     bool     `json:"canEdit"`
	CanRefImage bool     `json:"canRefImage"`
	CanVision   bool     `json:"canVision,omitempty"`
}

// PluginMarketSource is one subscribed DSH Format 1 plugin market index.json URL.
type PluginMarketSource struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	Official bool   `json:"official,omitempty"`
	Enabled  bool   `json:"enabled"`
}

// DefaultPluginMarkets returns the built-in official plugin market sources.
func DefaultPluginMarkets() []PluginMarketSource {
	return []PluginMarketSource{
		{
			ID:       "handraw-official",
			Name:     "手绘风官方插件市场",
			URL:      "https://raw.githubusercontent.com/yang0/handraw-plugins/main/index.json",
			Official: true,
			Enabled:  true,
		},
	}
}

type Settings struct {
	SiteBase           string               `json:"siteBase"`
	WorksDir           string               `json:"worksDir"`
	ArticleVaultDir    string               `json:"articleVaultDir,omitempty"`
	ArticleVaultDirs   []string             `json:"articleVaultDirs,omitempty"`
	Theme              string               `json:"theme"` // light | dark | system
	AutoSyncResources  bool                 `json:"autoSyncResources"`
	AutoCheckUpdate    bool                 `json:"autoCheckUpdate"`
	CostLimitCents     int                  `json:"costLimitCents"`
	DefaultModel       string               `json:"defaultModel"`       // "site:<id>" or "<providerId>:<modelId>"
	DefaultTextModel   string               `json:"defaultTextModel"`   // "", "site:auto", "site:<id>", or "<providerId>:<modelId>"
	DefaultVisionModel string               `json:"defaultVisionModel"` // "", "site:auto", "site:<id>", or "<providerId>:<modelId>"
	QuickShotHotkey    string               `json:"quickShotHotkey"`
	QuickShotEnabled   bool                 `json:"quickShotEnabled"`
	MinimizeToTray     bool                 `json:"minimizeToTray"`
	Providers          []Provider           `json:"providers"`
	Plugins            map[string]bool      `json:"plugins"`
	PluginConfig       map[string]any       `json:"pluginConfig"`
	PluginMarkets      []PluginMarketSource `json:"pluginMarkets,omitempty"`
	LastRecipeID       string               `json:"lastRecipeId"`
	Onboarded          bool                 `json:"onboarded"`
	// KeepSiteGenerationsPrivate stops website-model images from being
	// published to the community automatically (the website default is public).
	KeepSiteGenerationsPrivate bool `json:"keepSiteGenerationsPrivate"`
	// ClipToken authenticates the local Chrome Inspiration Clipper extension (#73).
	ClipToken string `json:"clipToken,omitempty"`
}

func Defaults() Settings {
	return Settings{
		SiteBase:          "https://handraw-style.com",
		WorksDir:          appdir.DefaultWorks(),
		Theme:             "light",
		AutoSyncResources: true,
		AutoCheckUpdate:   true,
		CostLimitCents:    200,
		QuickShotHotkey:   "Alt+Space",
		QuickShotEnabled:  true,
		MinimizeToTray:    true,
		Plugins:           map[string]bool{},
		PluginConfig:      map[string]any{},
		PluginMarkets:     DefaultPluginMarkets(),
	}
}

var (
	mu  sync.Mutex
	cur *Settings
)

// Get returns a copy of the current settings, loading them once.
func Get() Settings {
	mu.Lock()
	defer mu.Unlock()
	if cur == nil {
		s := load()
		cur = &s
	}
	return clone(*cur)
}

// Update applies fn to the settings and saves them atomically.
func Update(fn func(*Settings) error) (Settings, error) {
	mu.Lock()
	defer mu.Unlock()
	if cur == nil {
		s := load()
		cur = &s
	}
	next := clone(*cur)
	if err := fn(&next); err != nil {
		return clone(*cur), err
	}
	if err := save(next); err != nil {
		return clone(*cur), err
	}
	cur = &next
	return clone(next), nil
}

// Reset drops the cache (tests).
func Reset() { mu.Lock(); cur = nil; mu.Unlock() }

func newClipToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "hwc_" + hex.EncodeToString(b)
}

// EnsureClipToken returns the persisted Chrome clipper pairing token, creating
// one on first use (#73).
func EnsureClipToken() string {
	st := Get()
	if tok := strings.TrimSpace(st.ClipToken); tok != "" {
		return tok
	}
	tok := newClipToken()
	_, _ = Update(func(s *Settings) error {
		if strings.TrimSpace(s.ClipToken) == "" {
			s.ClipToken = tok
		} else {
			tok = strings.TrimSpace(s.ClipToken)
		}
		return nil
	})
	return tok
}

// RotateClipToken replaces the pairing token for the Chrome clipper extension.
func RotateClipToken() (string, error) {
	tok := newClipToken()
	_, err := Update(func(s *Settings) error {
		s.ClipToken = tok
		return nil
	})
	return tok, err
}

func clone(s Settings) Settings {
	b, _ := json.Marshal(s)
	var out Settings
	_ = json.Unmarshal(b, &out)
	if out.Plugins == nil {
		out.Plugins = map[string]bool{}
	}
	if out.PluginConfig == nil {
		out.PluginConfig = map[string]any{}
	}
	if len(out.PluginMarkets) == 0 {
		out.PluginMarkets = DefaultPluginMarkets()
	}
	return out
}

func load() Settings {
	s := Defaults()
	b, err := os.ReadFile(appdir.Settings())
	if err != nil {
		return s
	}
	if err := json.Unmarshal(b, &s); err != nil {
		// Keep the broken file for the user; start from defaults.
		_ = os.Rename(appdir.Settings(), appdir.Settings()+".broken")
		return Defaults()
	}
	if s.SiteBase == "" {
		s.SiteBase = Defaults().SiteBase
	}
	if s.WorksDir == "" {
		s.WorksDir = appdir.DefaultWorks()
	}
	if len(s.PluginMarkets) == 0 {
		s.PluginMarkets = DefaultPluginMarkets()
	}
	return s
}

func save(s Settings) error {
	path := appdir.Settings()
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, b)
}

// WriteFileAtomic writes via temp file + rename, keeping a .bak of the old file.
func WriteFileAtomic(path string, data []byte) error {
	if path == "" {
		return errors.New("empty path")
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	if _, err := os.Stat(path); err == nil {
		_ = copyFile(path, path+".bak")
	}
	return os.Rename(tmp, path)
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o644)
}
