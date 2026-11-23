package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestDeviceLoginRespectsIntervalAndSlowDownBackoff(t *testing.T) {
	origBuf := pollJitterBuffer
	pollJitterBuffer = 120 * time.Millisecond
	t.Cleanup(func() { pollJitterBuffer = origBuf })

	var mu sync.Mutex
	var pollTimes []time.Time
	var slowDownTriggered bool
	approved := false
	intervalSec := 1

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/device":
			_, _ = w.Write([]byte(`{"deviceCode":"dc_test_1","userCode":"ABCD-EFGH","verificationUrl":"/auth/device?code=ABCD-EFGH","expiresIn":120,"interval":1}`))
		case "/api/auth/device/token":
			mu.Lock()
			now := time.Now()
			if len(pollTimes) > 0 {
				delta := now.Sub(pollTimes[len(pollTimes)-1])
				if delta < time.Duration(intervalSec)*time.Second {
					slowDownTriggered = true
					intervalSec += 5
					pollTimes = append(pollTimes, now)
					mu.Unlock()
					w.WriteHeader(400)
					_, _ = w.Write([]byte(`{"error":"slow_down","code":"slow_down"}`))
					return
				}
			}
			pollTimes = append(pollTimes, now)
			count := len(pollTimes)
			isApproved := approved
			if count >= 2 {
				approved = true
				isApproved = true
			}
			mu.Unlock()
			if !isApproved {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"authorization_pending","code":"authorization_pending"}`))
				return
			}
			_, _ = w.Write([]byte(`{"token":"hwt_device_ok","scopes":["studio"],"user":{"id":42,"username":"demo","displayName":"手绘测试"}}`))
		case "/api/auth/me":
			_, _ = w.Write([]byte(`{"id":42,"username":"demo","displayName":"手绘测试"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	h := srv.Handler()

	rrStart := doReq(t, h, srv.Token, "POST", "/api/account/login", nil)
	if rrStart.Code != 200 {
		t.Fatalf("loginStart failed: %d %s", rrStart.Code, rrStart.Body.String())
	}
	var startResp map[string]any
	_ = json.Unmarshal(rrStart.Body.Bytes(), &startResp)
	if startResp["status"] != "pending" || startResp["userCode"] != "ABCD-EFGH" {
		t.Fatalf("unexpected start response: %v", startResp)
	}

	// Trigger rapid nudges via ?check=1; backend must NOT violate server interval.
	for i := 0; i < 3; i++ {
		rrCheck := doReq(t, h, srv.Token, "GET", "/api/account/login?check=1", nil)
		if rrCheck.Code != 200 {
			t.Fatalf("loginStatus?check=1 failed: %d", rrCheck.Code)
		}
		time.Sleep(80 * time.Millisecond)
	}

	// Wait for login to succeed cleanly on poll #2 without slow_down.
	deadline := time.Now().Add(5 * time.Second)
	var finalResp map[string]any
	for time.Now().Before(deadline) {
		rr := doReq(t, h, srv.Token, "GET", "/api/account/login", nil)
		_ = json.Unmarshal(rr.Body.Bytes(), &finalResp)
		if finalResp["status"] == "ok" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if finalResp["status"] != "ok" || finalResp["loggedIn"] != true {
		t.Fatalf("expected login ok, got %v", finalResp)
	}

	mu.Lock()
	gotSlow := slowDownTriggered
	gotPolls := len(pollTimes)
	mu.Unlock()
	if gotSlow {
		t.Fatalf("poll loop triggered slow_down despite interval guard (polls=%d)", gotPolls)
	}
	if gotPolls < 2 {
		t.Fatalf("expected at least 2 polls, got %d", gotPolls)
	}
}

func TestDeviceLoginSlowDownIncreasesIntervalAndCancelStops(t *testing.T) {
	origBuf := pollJitterBuffer
	pollJitterBuffer = 50 * time.Millisecond
	t.Cleanup(func() { pollJitterBuffer = origBuf })

	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/device":
			_, _ = w.Write([]byte(`{"deviceCode":"dc_slow","userCode":"WXYZ-1234","verificationUrl":"/auth/device?code=WXYZ-1234","expiresIn":120,"interval":1}`))
		case "/api/auth/device/token":
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"slow_down","code":"slow_down"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	h := srv.Handler()

	rrStart := doReq(t, h, srv.Token, "POST", "/api/account/login", nil)
	if rrStart.Code != 200 {
		t.Fatalf("loginStart failed: %d", rrStart.Code)
	}
	// Nudge immediately (first poll has no lastPollAt, so it fires right away).
	_ = doReq(t, h, srv.Token, "GET", "/api/account/login?check=1", nil)

	deadline := time.Now().Add(3 * time.Second)
	var st map[string]any
	for time.Now().Before(deadline) {
		rr := doReq(t, h, srv.Token, "GET", "/api/account/login", nil)
		_ = json.Unmarshal(rr.Body.Bytes(), &st)
		if int(st["intervalSec"].(float64)) >= 6 {
			break
		}
		time.Sleep(60 * time.Millisecond)
	}
	if int(st["intervalSec"].(float64)) != 6 {
		t.Fatalf("expected intervalSec to back off from 1 to 6 after slow_down, got %v", st["intervalSec"])
	}

	rrCancel := doReq(t, h, srv.Token, "POST", "/api/account/login/cancel", nil)
	if rrCancel.Code != 200 {
		t.Fatalf("loginCancel failed: %d %s", rrCancel.Code, rrCancel.Body.String())
	}
	var cancelResp map[string]any
	_ = json.Unmarshal(rrCancel.Body.Bytes(), &cancelResp)
	if cancelResp["status"] != "idle" || cancelResp["active"] != false {
		t.Fatalf("expected idle after cancel, got %v", cancelResp)
	}
}
