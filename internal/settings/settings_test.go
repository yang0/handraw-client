package settings

import (
	"os"
	"testing"

	"github.com/yang0/handraw-client/internal/appdir"
)

func TestSettingsPersistenceAndUnifiedMarkets(t *testing.T) {
	t.Setenv("HANDRAW_HOME", t.TempDir())
	Reset()
	t.Cleanup(Reset)

	st := Get()
	if st.PreferredMarketMirror != "gitee" {
		t.Fatalf("expected default mirror gitee, got %q", st.PreferredMarketMirror)
	}
	if len(st.PluginMarkets) != 1 || len(st.SkillMarkets) != 1 || len(st.GalleryMarkets) != 1 || len(st.ObsidianMarkets) != 1 {
		t.Fatalf("expected all 4 official markets initialized")
	}

	// Update persists atomically and backfills missing mirrors on official source.
	_, err := Update(func(s *Settings) error {
		s.Theme = "dark"
		s.TelemetryDisabled = true
		s.PluginMarkets[0].Mirrors = nil
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	Reset()
	reloaded := Get()
	if reloaded.Theme != "dark" || !reloaded.TelemetryDisabled {
		t.Fatalf("settings did not persist: %+v", reloaded)
	}
	if reloaded.PluginMarkets[0].Mirrors["gitee"] == "" {
		t.Fatalf("expected official market mirrors to be backfilled")
	}

	// EnsureClipToken / RotateClipToken / EnsureTelemetryID
	tok1 := EnsureClipToken()
	tok2 := EnsureClipToken()
	if tok1 == "" || tok1 != tok2 {
		t.Fatalf("clip token should be stable: %q vs %q", tok1, tok2)
	}
	tok3, err := RotateClipToken()
	if err != nil || tok3 == "" || tok3 == tok1 {
		t.Fatalf("rotated clip token invalid: %q err=%v", tok3, err)
	}
	tid1 := EnsureTelemetryID()
	tid2 := EnsureTelemetryID()
	if tid1 == "" || tid1 != tid2 {
		t.Fatalf("telemetry id should be stable: %q vs %q", tid1, tid2)
	}

	// Provider model kind resolution
	p := Provider{Purpose: "image", Models: []Model{{ID: "m1"}, {ID: "m2", Kind: "text"}}}
	if len(p.ImageModels()) != 1 || len(p.TextModels()) != 1 {
		t.Fatalf("unexpected model split: img=%d txt=%d", len(p.ImageModels()), len(p.TextModels()))
	}
}

func TestAutoUpdateModeMigration(t *testing.T) {
	appdir.SetRoot(t.TempDir())
	Reset()
	t.Cleanup(Reset)

	// Fresh defaults -> "auto", LaunchAtLogin=false, TelemetryDisabled=true, no consent yet (#191).
	if st0 := Get(); st0.EffectiveAutoUpdateMode() != "auto" || st0.LaunchAtLogin || !st0.TelemetryDisabled || st0.HasPrivacyConsent() {
		t.Fatalf("expected privacy-first defaults (auto update, launch=false, telemetryDisabled=true, consent=false), got mode=%q launch=%v telDis=%v consent=%v",
			st0.EffectiveAutoUpdateMode(), st0.LaunchAtLogin, st0.TelemetryDisabled, st0.HasPrivacyConsent())
	}

	// Legacy settings.json with only autoCheckUpdate=false -> migrates to "off".
	if err := os.WriteFile(appdir.Settings(), []byte(`{"autoCheckUpdate":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	Reset()
	st := Get()
	if st.AutoUpdateMode != "off" || st.AutoCheckUpdate {
		t.Fatalf("expected legacy autoCheckUpdate=false to migrate to off, got mode=%q check=%v", st.AutoUpdateMode, st.AutoCheckUpdate)
	}

	// Legacy settings.json with only autoCheckUpdate=true -> migrates to "auto".
	if err := os.WriteFile(appdir.Settings(), []byte(`{"autoCheckUpdate":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	Reset()
	st = Get()
	if st.AutoUpdateMode != "auto" || !st.AutoCheckUpdate {
		t.Fatalf("expected legacy autoCheckUpdate=true to migrate to auto, got mode=%q check=%v", st.AutoUpdateMode, st.AutoCheckUpdate)
	}
}
