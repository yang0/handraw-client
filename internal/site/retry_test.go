package site

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestClientRetriesTransientResetOnStartDeviceAndFetch(t *testing.T) {
	resetErr := errors.New(`read tcp [2408:8240::1]:11594->[2606:4700:3036::6815:f66]:443: wsarecv: An existing connection was forcibly closed by the remote host.`)

	var deviceAttempts atomic.Int32
	c := NewWithBase("https://handraw-style.example", "0.6.4")
	c.HTTP = &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			n := deviceAttempts.Add(1)
			if n == 1 {
				return nil, resetErr
			}
			// Verify request body was properly rewound on retry.
			b, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(b), "clientName") {
				t.Fatalf("expected rewound JSON body on retry, got %q", string(b))
			}
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(bytes.NewBufferString(`{"deviceCode":"dc_1","userCode":"ABCD-1234","verificationUrl":"/auth/device","interval":3,"expiresIn":300}`)),
			}, nil
		}),
	}

	ds, err := c.StartDevice(context.Background())
	if err != nil {
		t.Fatalf("expected StartDevice to succeed on retry, got err=%v", err)
	}
	if deviceAttempts.Load() != 2 || ds.UserCode != "ABCD-1234" {
		t.Fatalf("unexpected retry state: attempts=%d ds=%+v", deviceAttempts.Load(), ds)
	}

	// Fetch should also retry once on transient reset.
	var fetchAttempts atomic.Int32
	c.HTTP = &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if fetchAttempts.Add(1) == 1 {
				return nil, resetErr
			}
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"image/webp"}},
				Body:       io.NopCloser(bytes.NewBufferString("RIFF1234WEBP")),
			}, nil
		}),
	}
	data, ct, err := c.Fetch(context.Background(), "/images/individual/FA/FA-001.webp")
	if err != nil || string(data) != "RIFF1234WEBP" || ct != "image/webp" || fetchAttempts.Load() != 2 {
		t.Fatalf("expected Fetch retry success, got data=%q ct=%q err=%v attempts=%d", string(data), ct, err, fetchAttempts.Load())
	}

	// Persistent resets should surface a friendly Chinese diagnosis.
	c.HTTP = &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return nil, resetErr
		}),
	}
	_, err = c.StartDevice(context.Background())
	if err == nil || !strings.Contains(err.Error(), "系统代理") {
		t.Fatalf("expected friendly Chinese network guidance on persistent reset, got %v", err)
	}
}
