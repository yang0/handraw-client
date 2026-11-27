package site

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/settings"
)

// #179: Fetch must not leak Authorization: Bearer to a different scheme (e.g. http
// when siteBase is https) or across redirects to a different origin.
func TestFetchRequiresMatchingSchemeForBearerToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("png"))
	}))
	defer srv.Close()

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HANDRAW_HOME", t.TempDir())
	t.Setenv("HANDRAW_SECRETS", "memory")
	settings.Reset()
	t.Cleanup(settings.Reset)
	// Configure siteBase with https:// scheme while target URL uses plaintext http:// on the same host.
	_, _ = settings.Update(func(s *settings.Settings) error {
		s.SiteBase = "https://" + u.Host
		return nil
	})
	if err := secrets.Set(secrets.SiteToken, "tok_sensitive_bearer"); err != nil {
		t.Fatalf("set test site token: %v", err)
	}
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	c := New("v0.6.4")
	if _, _, err := c.Fetch(context.Background(), "http://"+u.Host+"/generated/private.png"); err != nil {
		t.Fatalf("Fetch failed: %v", err)
	}
	if gotAuth != "" {
		t.Fatalf("Bearer token leaked over http:// when siteBase is https://: %q", gotAuth)
	}
}
