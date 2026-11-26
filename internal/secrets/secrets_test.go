package secrets

import (
	"errors"
	"testing"
)

func TestSecretsMemoryRoundTrip(t *testing.T) {
	t.Setenv("HANDRAW_SECRETS", "memory")

	key := ProviderKey("test-unit-provider")
	_ = Delete(key)
	if Has(key) {
		t.Fatalf("expected key absent initially")
	}
	if _, err := Get(key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := Set(key, "sk-unit-123"); err != nil {
		t.Fatal(err)
	}
	if !Has(key) {
		t.Fatalf("expected Has(key)=true after Set")
	}
	got, err := Get(key)
	if err != nil || got != "sk-unit-123" {
		t.Fatalf("Get mismatch: %q err=%v", got, err)
	}
	if err := Delete(key); err != nil {
		t.Fatal(err)
	}
	if Has(key) {
		t.Fatalf("expected Has(key)=false after Delete")
	}
}
