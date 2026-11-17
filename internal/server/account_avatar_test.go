package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
)

func TestAccountAvatarFollowsWebsiteAndClearsOnLogout(t *testing.T) {
	var revision atomic.Int32
	var status atomic.Int32
	status.Store(http.StatusOK)
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/tokens" {
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
			return
		}
		if r.URL.Path != "/api/auth/me" {
			http.NotFound(w, r)
			return
		}
		if code := int(status.Load()); code != http.StatusOK {
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "website unavailable"})
			return
		}
		username, avatar := "first-user", "/avatars/first.webp"
		if revision.Load() == 1 {
			avatar = "/avatars/updated.webp"
		}
		if r.Header.Get("Authorization") == "Bearer hwt_second_user" {
			username, avatar = "second-user", "/avatars/second.webp"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"username": username, "displayName": username, "avatarUrl": avatar,
		})
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, mockSite.URL)
	if err := secrets.Set(secrets.SiteToken, "hwt_first_user"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	h := srv.Handler()
	type accountResponse struct {
		LoggedIn bool   `json:"loggedIn"`
		Offline  bool   `json:"offline"`
		SiteBase string `json:"siteBase"`
		User     struct {
			Username  string `json:"username"`
			AvatarURL string `json:"avatarUrl"`
		} `json:"user"`
	}
	account := func() accountResponse {
		t.Helper()
		rr := doReq(t, h, srv.Token, "GET", "/api/account", nil)
		if rr.Code != http.StatusOK {
			t.Fatalf("account HTTP %d: %s", rr.Code, rr.Body.String())
		}
		var out accountResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	assertAvatar := func(username, avatar string, offline bool) {
		t.Helper()
		got := account()
		if !got.LoggedIn || got.User.Username != username || got.User.AvatarURL != avatar ||
			got.Offline != offline || got.SiteBase != mockSite.URL {
			t.Fatalf("unexpected account state: %+v", got)
		}
	}

	assertAvatar("first-user", "/avatars/first.webp", false)
	revision.Store(1)
	assertAvatar("first-user", "/avatars/updated.webp", false)

	status.Store(http.StatusServiceUnavailable)
	assertAvatar("first-user", "/avatars/updated.webp", true)

	status.Store(http.StatusOK)
	rr := doReq(t, h, srv.Token, "POST", "/api/account/logout", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("logout HTTP %d: %s", rr.Code, rr.Body.String())
	}
	if got := account(); got.LoggedIn || got.User.AvatarURL != "" {
		t.Fatalf("previous avatar survived logout: %+v", got)
	}
	if err := secrets.Set(secrets.SiteToken, "hwt_second_user"); err != nil {
		t.Fatal(err)
	}
	assertAvatar("second-user", "/avatars/second.webp", false)

	status.Store(http.StatusUnauthorized)
	if got := account(); got.LoggedIn || got.User.AvatarURL != "" {
		t.Fatalf("expired token kept a stale avatar: %+v", got)
	}
	if secrets.Has(secrets.SiteToken) {
		t.Fatal("expired token was not cleared")
	}
	var cached map[string]any
	if err := srv.DB.GetKV("account_user", &cached); err != nil {
		t.Fatal(err)
	}
	if len(cached) != 0 {
		t.Fatalf("expired account remained cached: %v", cached)
	}
}
