//go:build !windows && !darwin

package netutil

import "net/url"

func osSystemProxy(*url.URL) (*url.URL, error) {
	return nil, nil
}
