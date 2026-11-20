// Command signsums signs a release's SHA256SUMS for the updater (#43).
//
//	go run ./tools/signsums keygen                 # prints a new key pair (base64)
//	HANDRAW_RELEASE_SIGNING_KEY=<seed> go run ./tools/signsums sign v0.5.0 SHA256SUMS > SHA256SUMS.sig
//	go run ./tools/signsums verify v0.5.0 SHA256SUMS SHA256SUMS.sig <public key>
//
// The signed message is "handraw release <version without v>\n" + SHA256SUMS,
// exactly what internal/updater.VerifySums checks, so one signature is only
// valid for one version.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"github.com/yang0/handraw-client/internal/updater"
)

func message(version string, sums []byte) []byte {
	return append([]byte("handraw release "+strings.TrimPrefix(version, "v")+"\n"), sums...)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fail("usage: signsums keygen | sign <version> <SHA256SUMS> | verify <version> <SHA256SUMS> <sig> <pubkey>")
	}
	switch os.Args[1] {
	case "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			fail("keygen: %v", err)
		}
		fmt.Println("public (repository variable HANDRAW_RELEASE_PUBKEY):", base64.StdEncoding.EncodeToString(pub))
		fmt.Println("private seed (secret HANDRAW_RELEASE_SIGNING_KEY):  ", base64.StdEncoding.EncodeToString(priv.Seed()))
	case "sign":
		if len(os.Args) != 4 {
			fail("usage: signsums sign <version> <SHA256SUMS>")
		}
		seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("HANDRAW_RELEASE_SIGNING_KEY")))
		if err != nil || len(seed) != ed25519.SeedSize {
			fail("HANDRAW_RELEASE_SIGNING_KEY must be a base64 ed25519 seed")
		}
		sums, err := os.ReadFile(os.Args[3])
		if err != nil {
			fail("read sums: %v", err)
		}
		sig := ed25519.Sign(ed25519.NewKeyFromSeed(seed), message(os.Args[2], sums))
		fmt.Println(base64.StdEncoding.EncodeToString(sig))
	case "verify":
		if len(os.Args) != 6 {
			fail("usage: signsums verify <version> <SHA256SUMS> <sig> <pubkey>")
		}
		sums, err1 := os.ReadFile(os.Args[3])
		sig, err2 := os.ReadFile(os.Args[4])
		if err1 != nil || err2 != nil {
			fail("read files: %v %v", err1, err2)
		}
		files, err := updater.VerifySums(os.Args[2], sums, sig, os.Args[5])
		if err != nil {
			fail("verify: %v", err)
		}
		fmt.Printf("ok: %d files\n", len(files))
	default:
		fail("unknown command %q", os.Args[1])
	}
}
