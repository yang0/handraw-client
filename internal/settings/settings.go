// Package settings keeps the user's preferences in settings.json.
// Secrets (site token, API keys) never go here; see package secrets.
package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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

type Settings struct {
	SiteBase           string          `json:"siteBase"`
	WorksDir           string          `json:"worksDir"`
	Theme              string          `json:"theme"` // light | dark | system
	AutoSyncResources  bool            `json:"autoSyncResources"`
	AutoCheckUpdate    bool            `json:"autoCheckUpdate"`
	CostLimitCents     int             `json:"costLimitCents"`
	DefaultModel       string          `json:"defaultModel"`       // "site:<id>" or "<providerId>:<modelId>"
	DefaultTextModel   string          `json:"defaultTextModel"`   // "", "site:auto", "site:<id>", or "<providerId>:<modelId>"
	DefaultVisionModel string          `json:"defaultVisionModel"` // "", "site:auto", "site:<id>", or "<providerId>:<modelId>"
	QuickShotHotkey    string          `json:"quickShotHotkey"`
	QuickShotEnabled   bool            `json:"quickShotEnabled"`
	MinimizeToTray     bool            `json:"minimizeToTray"`
	Providers          []Provider      `json:"providers"`
	Plugins            map[string]bool `json:"plugins"`
	PluginConfig       map[string]any  `json:"pluginConfig"`
	LastRecipeID       string          `json:"lastRecipeId"`
	Onboarded          bool            `json:"onboarded"`
	// KeepSiteGenerationsPrivate stops website-model images from being
	// published to the community automatically (the website default is public).
	KeepSiteGenerationsPrivate bool `json:"keepSiteGenerationsPrivate"`
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
