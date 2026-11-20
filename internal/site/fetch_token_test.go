package site

import "testing"

func TestNeedsTokenOnlyForPrivatePaths(t *testing.T) {
	for p, want := range map[string]bool{
		"/images/individual/FA/FA-001.webp": false,
		"/assets/avatar-default.svg":        false,
		"/uploads/u1/a.webp":                true,
		"/generated/x.webp":                 true,
		"/api/me/level":                     true,
	} {
		if got := needsToken(p); got != want {
			t.Errorf("needsToken(%q) = %v, want %v", p, got, want)
		}
	}
}
