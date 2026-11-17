// Package secrets stores the site token and API keys in the OS credential
// store (Windows Credential Manager, macOS Keychain). Nothing secret is
// written to settings.json or logs.
package secrets

import (
	"errors"
	"os"
	"sync"

	"github.com/zalando/go-keyring"
)

const service = "handraw-client"

const SiteToken = "site-token"

// ProviderKey is the keyring entry name for a provider's API key.
func ProviderKey(providerID string) string { return "provider:" + providerID }

var (
	memMu sync.Mutex
	mem   = map[string]string{}
)

// memory mode is for tests and machines with no credential store.
func memory() bool { return os.Getenv("HANDRAW_SECRETS") == "memory" }

func Set(name, value string) error {
	if memory() {
		memMu.Lock()
		mem[name] = value
		memMu.Unlock()
		return nil
	}
	return keyring.Set(service, name, value)
}

func Get(name string) (string, error) {
	if memory() {
		memMu.Lock()
		defer memMu.Unlock()
		v, ok := mem[name]
		if !ok {
			return "", ErrNotFound
		}
		return v, nil
	}
	v, err := keyring.Get(service, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return v, err
}

func Delete(name string) error {
	if memory() {
		memMu.Lock()
		delete(mem, name)
		memMu.Unlock()
		return nil
	}
	err := keyring.Delete(service, name)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// Has reports whether a secret exists without returning it.
func Has(name string) bool {
	v, err := Get(name)
	return err == nil && v != ""
}

var ErrNotFound = errors.New("secret not found")
