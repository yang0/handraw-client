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
	"github.com/yang0/handraw-client/internal/harnesses"
)

// Provider is a user-configured image and/or text/vision API. Its key lives in the keyring.
type Provider struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`    // "openai" (OpenAI compatible)
	Purpose string  `json:"purpose"` // "all" (mixed), "image", or "text" (legacy)
	BaseURL string  `json:"baseUrl"`
	Models  []Model `json:"models"`
	Enabled bool    `json:"enabled"`
}

// Model is one model the user picked from a provider's catalog.
type Model struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Kind        string   `json:"kind,omitempty"` // "image" | "text" (empty falls back to Provider.Purpose)
	Sizes       []string `json:"sizes,omitempty"` // e.g. 1024x1024
	PriceCents  int      `json:"priceCents,omitempty"`
	CanEdit     bool     `json:"canEdit"`
	CanRefImage bool     `json:"canRefImage"`
	CanVision   bool     `json:"canVision,omitempty"`
}

// EffectiveModelKind returns "image" or "text" for a model under provider p,
// remaining backward-compatible with legacy provider-level Purpose settings.
func (p Provider) EffectiveModelKind(m Model) string {
	k := strings.ToLower(strings.TrimSpace(m.Kind))
	if k == "image" {
		return "image"
	}
	if k == "text" || k == "vision" {
		return "text"
	}
	purp := strings.ToLower(strings.TrimSpace(p.Purpose))
	if purp == "text" || purp == "vision" {
		return "text"
	}
	if purp == "image" {
		return "image"
	}
	return "text"
}

// ImageModels returns the subset of models configured for image generation.
func (p Provider) ImageModels() []Model {
	out := []Model{}
	for _, m := range p.Models {
		if p.EffectiveModelKind(m) == "image" {
			out = append(out, m)
		}
	}
	return out
}

// TextModels returns the subset of models configured for text / vision chat.
func (p Provider) TextModels() []Model {
	out := []Model{}
	for _, m := range p.Models {
		if p.EffectiveModelKind(m) == "text" {
			out = append(out, m)
		}
	}
	return out
}

// MarketSource is one subscribed Format 1 extension market index.json URL
// shared across plugins, skills, Obsidian writing plugins, and galleries (#180).
type MarketSource struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	URL      string            `json:"url"`
	Mirrors  map[string]string `json:"mirrors,omitempty"`
	Official bool              `json:"official,omitempty"`
	Enabled  bool              `json:"enabled"`
}

// Type aliases preserve backward compatibility for existing callers across packages.
type (
	PluginMarketSource   = MarketSource
	SkillMarketSource    = MarketSource
	ObsidianMarketSource = MarketSource
	GalleryMarketSource  = MarketSource
)

func officialMarket(id, name, githubRepo, giteeRepo string) []MarketSource {
	gh := "https://raw.githubusercontent.com/" + githubRepo + "/main/index.json"
	gt := "https://gitee.com/" + giteeRepo + "/raw/main/index.json"
	return []MarketSource{
		{
			ID:   id,
			Name: name,
			URL:  gh,
			Mirrors: map[string]string{
				"gitee":  gt,
				"github": gh,
			},
			Official: true,
			Enabled:  true,
		},
	}
}

func backfillOfficialMarkets(markets, defaults []MarketSource) []MarketSource {
	if len(markets) == 0 {
		return defaults
	}
	if len(defaults) == 0 {
		return markets
	}
	def := defaults[0]
	for i := range markets {
		if markets[i].ID == def.ID && strings.EqualFold(strings.TrimSpace(markets[i].URL), def.URL) {
			if len(markets[i].Mirrors) == 0 {
				markets[i].Mirrors = map[string]string{
					"gitee":  def.Mirrors["gitee"],
					"github": def.Mirrors["github"],
				}
			}
		}
	}
	return markets
}

// DefaultPluginMarkets returns the built-in official plugin market sources.
func DefaultPluginMarkets() []PluginMarketSource {
	return officialMarket("handraw-official", "手绘风官方插件市场", "yang0/handraw-plugins", "yang02010/handraw-plugins")
}

// DefaultSkillMarkets returns the built-in official AI Skills market sources.
func DefaultSkillMarkets() []SkillMarketSource {
	return officialMarket("handraw-skills-official", "手绘风官方 Skills 市场", "yang0/handraw-skills", "yang02010/handraw-skills")
}

// DefaultObsidianMarkets returns the built-in official Obsidian writing plugins market sources.
func DefaultObsidianMarkets() []ObsidianMarketSource {
	return officialMarket("handraw-obsidian-official", "手绘风官方写作插件市场", "yang0/handraw-obsidian-plugins", "yang02010/handraw-obsidian-plugins")
}

// DefaultGalleryMarkets returns the built-in official extension gallery market sources.
func DefaultGalleryMarkets() []GalleryMarketSource {
	return officialMarket("handraw-galleries-official", "手绘风官方图库市场", "yang0/handraw-galleries", "yang02010/handraw-galleries")
}

type Settings struct {
	SiteBase           string               `json:"siteBase"`
	WorksDir           string               `json:"worksDir"`
	LegacyWorksDirs    []string             `json:"legacyWorksDirs,omitempty"`
	ArticleVaultDir    string               `json:"articleVaultDir,omitempty"`
	ArticleVaultDirs   []string             `json:"articleVaultDirs,omitempty"`
	Theme              string               `json:"theme"` // light | dark | system
	AutoSyncResources  bool                 `json:"autoSyncResources"`
	AutoCheckUpdate    bool                 `json:"autoCheckUpdate"`
	CostLimitCents     int                  `json:"costLimitCents"`
	DefaultModel       string               `json:"defaultModel"`       // "site:<id>" or "<providerId>:<modelId>"
	DefaultTextModel   string               `json:"defaultTextModel"`   // "", "site:auto", "site:<id>", "<providerId>:<modelId>", or "harness:<id>"
	DefaultVisionModel string               `json:"defaultVisionModel"` // "", "site:auto", "site:<id>", or "<providerId>:<modelId>"
	QuickShotHotkey    string               `json:"quickShotHotkey"`
	QuickShotEnabled   bool                 `json:"quickShotEnabled"`
	MinimizeToTray     bool                 `json:"minimizeToTray"`
	Providers          []Provider           `json:"providers"`
	Harnesses          []harnesses.Config   `json:"harnesses,omitempty"`   // local CLI AI harness overrides & custom CLIs (#119)
	SceneModels        map[string]string    `json:"sceneModels,omitempty"` // per-scene text/planning model overrides (#119)
	Plugins               map[string]bool        `json:"plugins"`
	PluginConfig          map[string]any         `json:"pluginConfig"`
	PreferredMarketMirror string                 `json:"preferredMarketMirror,omitempty"` // gitee | github (#127)
	PluginMarkets         []PluginMarketSource   `json:"pluginMarkets,omitempty"`
	GalleryMarkets        []GalleryMarketSource  `json:"galleryMarkets,omitempty"`
	SkillMarkets          []SkillMarketSource    `json:"skillMarkets,omitempty"`
	ObsidianMarkets       []ObsidianMarketSource `json:"obsidianMarkets,omitempty"`
	LastRecipeID          string                 `json:"lastRecipeId"`
	Onboarded          bool                 `json:"onboarded"`
	// KeepSiteGenerationsPrivate stops website-model images from being
	// published to the community automatically (the website default is public).
	KeepSiteGenerationsPrivate bool `json:"keepSiteGenerationsPrivate"`
	// ClipToken authenticates the local Chrome Inspiration Clipper extension (#73).
	ClipToken string `json:"clipToken,omitempty"`
	// TelemetryDisabled opts out of anonymous desktop usage telemetry (#174).
	TelemetryDisabled bool `json:"telemetryDisabled,omitempty"`
	// TelemetryID is a locally generated random anonymous identifier (dc_...).
	TelemetryID string `json:"telemetryId,omitempty"`
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
		SceneModels:           map[string]string{},
		Plugins:               map[string]bool{},
		PluginConfig:          map[string]any{},
		PreferredMarketMirror: "gitee",
		PluginMarkets:         DefaultPluginMarkets(),
		GalleryMarkets:        DefaultGalleryMarkets(),
		SkillMarkets:          DefaultSkillMarkets(),
		ObsidianMarkets:       DefaultObsidianMarkets(),
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

func newTelemetryID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "dc_" + hex.EncodeToString(b)
}

// EnsureTelemetryID returns a persisted random anonymous device ID for opt-in
// desktop usage statistics, creating one on first use (#174).
func EnsureTelemetryID() string {
	st := Get()
	if id := strings.TrimSpace(st.TelemetryID); id != "" {
		return id
	}
	id := newTelemetryID()
	_, _ = Update(func(s *Settings) error {
		if strings.TrimSpace(s.TelemetryID) == "" {
			s.TelemetryID = id
		} else {
			id = strings.TrimSpace(s.TelemetryID)
		}
		return nil
	})
	return id
}

func clone(s Settings) Settings {
	b, _ := json.Marshal(s)
	var out Settings
	_ = json.Unmarshal(b, &out)
	if out.Plugins == nil {
		out.Plugins = map[string]bool{}
	}
	if out.SceneModels == nil {
		out.SceneModels = map[string]string{}
	}
	if out.PluginConfig == nil {
		out.PluginConfig = map[string]any{}
	}
	if out.PreferredMarketMirror != "github" {
		out.PreferredMarketMirror = "gitee"
	}
	out.PluginMarkets = backfillOfficialMarkets(out.PluginMarkets, DefaultPluginMarkets())
	out.GalleryMarkets = backfillOfficialMarkets(out.GalleryMarkets, DefaultGalleryMarkets())
	out.SkillMarkets = backfillOfficialMarkets(out.SkillMarkets, DefaultSkillMarkets())
	out.ObsidianMarkets = backfillOfficialMarkets(out.ObsidianMarkets, DefaultObsidianMarkets())
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
	if s.PreferredMarketMirror != "github" {
		s.PreferredMarketMirror = "gitee"
	}
	s.PluginMarkets = backfillOfficialMarkets(s.PluginMarkets, DefaultPluginMarkets())
	s.GalleryMarkets = backfillOfficialMarkets(s.GalleryMarkets, DefaultGalleryMarkets())
	s.SkillMarkets = backfillOfficialMarkets(s.SkillMarkets, DefaultSkillMarkets())
	s.ObsidianMarkets = backfillOfficialMarkets(s.ObsidianMarkets, DefaultObsidianMarkets())
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
