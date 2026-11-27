package server

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/telemetry"
)

type quitSpyHost struct {
	nopHost
	quitCalls atomic.Int32
}

func (h *quitSpyHost) Quit() { h.quitCalls.Add(1) }

func TestPrivacyConsentDefaultsInspectAndQuit(t *testing.T) {
	srv, _ := setupTestServer(t, "")
	spy := &quitSpyHost{}
	srv.Host = spy
	tel := telemetry.New("0.6.10")
	tel.Enabled = func() bool {
		st := settings.Get()
		return st.HasPrivacyConsent() && !st.TelemetryDisabled
	}
	srv.Telemetry = tel
	h := srv.Handler()

	// 1. Before consent: defaults are opt-in (telemetry disabled, launchAtLogin false), inspect reports disabled.
	rr0 := doReq(t, h, srv.Token, http.MethodGet, "/api/telemetry/inspect", nil)
	if rr0.Code != 200 {
		t.Fatalf("inspect status = %d: %s", rr0.Code, rr0.Body.String())
	}
	var ins0 map[string]any
	_ = json.Unmarshal(rr0.Body.Bytes(), &ins0)
	if ins0["enabled"] != false || ins0["hasConsent"] != false || ins0["telemetryDisabled"] != true {
		t.Fatalf("expected disabled & unconsented by default, got %v", ins0)
	}
	if evs, ok := ins0["allowedEvents"].([]any); !ok || len(evs) == 0 {
		t.Fatalf("expected non-empty allowedEvents whitelist, got %v", ins0["allowedEvents"])
	}

	// 2. Accept consent with telemetry opted in.
	rr1 := doReq(t, h, srv.Token, http.MethodPatch, "/api/settings", map[string]any{
		"acceptPrivacyConsent": true,
		"telemetryDisabled":    false,
		"launchAtLogin":        false,
	})
	if rr1.Code != 200 {
		t.Fatalf("patch consent status = %d: %s", rr1.Code, rr1.Body.String())
	}
	st := settings.Get()
	if !st.HasPrivacyConsent() || st.PrivacyConsentVersion != settings.CurrentPrivacyConsentVersion || st.PrivacyConsentAt == "" {
		t.Fatalf("expected consent persisted, got %+v", st)
	}
	if st.TelemetryDisabled || st.LaunchAtLogin {
		t.Fatalf("expected telemetry enabled and launchAtLogin false, got telDis=%v launch=%v", st.TelemetryDisabled, st.LaunchAtLogin)
	}

	rr2 := doReq(t, h, srv.Token, http.MethodGet, "/api/telemetry/inspect", nil)
	var ins1 map[string]any
	_ = json.Unmarshal(rr2.Body.Bytes(), &ins1)
	if ins1["enabled"] != true || ins1["hasConsent"] != true {
		t.Fatalf("expected enabled after consent, got %v", ins1)
	}

	// 3. Declining consent calls /api/app/quit -> Host.Quit().
	rrQ := doReq(t, h, srv.Token, http.MethodPost, "/api/app/quit", nil)
	if rrQ.Code != 200 {
		t.Fatalf("quit status = %d: %s", rrQ.Code, rrQ.Body.String())
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && spy.quitCalls.Load() == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if spy.quitCalls.Load() != 1 {
		t.Fatalf("expected Host.Quit() to be invoked once, got %d", spy.quitCalls.Load())
	}
}
