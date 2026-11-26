package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/updater"
)

// #172: Verify v0.6.0 server endpoints (/api/update/check, /download, /api/update)
// with #171 localguard active can discover, fail over to the fallback mirror,
// verify ed25519 + SHA256, and stage a signed v0.6.1 update.
func TestUpdateAPIV060ToV061WithLocalGuardAndFallback(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	origPub := updater.PublicKey
	origFeeds := updater.Feeds
	updater.PublicKey = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() {
		updater.PublicKey = origPub
		updater.Feeds = origFeeds
	})

	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		t.Skip("self-update binary assets are only published for windows/darwin (#180)")
	}
	asset := "handraw-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		asset += ".exe"
	} else if runtime.GOOS == "darwin" {
		asset += ".zip"
	}

	binPayload := []byte("signed-handraw-v0.6.1-release-binary")
	binSum := sha256.Sum256(binPayload)
	sumsText := fmt.Sprintf("%s  %s\n", hex.EncodeToString(binSum[:]), asset)
	sig := ed25519.Sign(priv, append([]byte("handraw release 0.6.1\n"), []byte(sumsText)...))
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	var mirror *httptest.Server
	mirror = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/static/client/latest.json":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(updater.Release{
				Tag:       "v0.6.1",
				Name:      "手绘风 v0.6.1",
				Body:      "v0.6.1 升级测试",
				Published: "2026-11-26T09:30:00Z",
				Assets: []updater.Asset{
					{Name: asset, URL: mirror.URL + "/static/client/v0.6.1/" + asset, Size: int64(len(binPayload))},
					{Name: "SHA256SUMS", URL: mirror.URL + "/static/client/v0.6.1/SHA256SUMS", Size: int64(len(sumsText))},
					{Name: "SHA256SUMS.sig", URL: mirror.URL + "/static/client/v0.6.1/SHA256SUMS.sig", Size: int64(len(sigB64))},
				},
			})
		case "/static/client/v0.6.1/SHA256SUMS":
			_, _ = w.Write([]byte(sumsText))
		case "/static/client/v0.6.1/SHA256SUMS.sig":
			_, _ = w.Write([]byte(sigB64))
		case "/static/client/v0.6.1/" + asset:
			_, _ = w.Write(binPayload)
		default:
			http.NotFound(w, r)
		}
	}))
	defer mirror.Close()

	brokenGH := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "github unreachable", http.StatusBadGateway)
	}))
	defer brokenGH.Close()

	updater.Feeds = []string{
		brokenGH.URL + "/releases/latest",
		mirror.URL + "/static/client/latest.json",
	}

	srv, cancel := setupTestServer(t, "")
	defer cancel()
	stageDir := t.TempDir()
	srv.Version = "v0.6.0"
	srv.Updater = updater.New("v0.6.0", stageDir)
	h := srv.Handler()

	// 1. Check via HTTP API (passes through #171 localguard).
	rrChk := doReq(t, h, srv.Token, http.MethodPost, "/api/update/check", nil)
	if rrChk.Code != http.StatusOK {
		t.Fatalf("POST /api/update/check failed: %d %s", rrChk.Code, rrChk.Body.String())
	}
	var chkResp struct {
		Status updater.Status `json:"status"`
	}
	if err := json.Unmarshal(rrChk.Body.Bytes(), &chkResp); err != nil {
		t.Fatalf("decode check: %v", err)
	}
	if !chkResp.Status.Available || chkResp.Status.Latest != "0.6.1" || chkResp.Status.Current != "v0.6.0" {
		t.Fatalf("unexpected check status: %+v", chkResp.Status)
	}

	// 2. Trigger async download via HTTP API and poll GET /api/update until Ready.
	rrDl := doReq(t, h, srv.Token, http.MethodPost, "/api/update/download", nil)
	if rrDl.Code != http.StatusOK {
		t.Fatalf("POST /api/update/download failed: %d %s", rrDl.Code, rrDl.Body.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	var st updater.Status
	for time.Now().Before(deadline) {
		rrSt := doReq(t, h, srv.Token, http.MethodGet, "/api/update", nil)
		if rrSt.Code != http.StatusOK {
			t.Fatalf("GET /api/update failed: %d %s", rrSt.Code, rrSt.Body.String())
		}
		_ = json.Unmarshal(rrSt.Body.Bytes(), &st)
		if st.Ready || (st.Error != "" && !st.Downloading) {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !st.Ready || st.Progress != 100 || st.Error != "" {
		t.Fatalf("download did not finish cleanly: %+v", st)
	}
	got, err := os.ReadFile(filepath.Join(stageDir, asset))
	if err != nil || string(got) != string(binPayload) {
		t.Fatalf("staged file mismatch: err=%v got=%q", err, string(got))
	}
}
