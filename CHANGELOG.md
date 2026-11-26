# Changelog

All notable changes to `handraw-client` are documented in this file.

## v0.6.5 (2026-11-26)

### Features & Fixes
- **Embedded Resource Pack & Settings Stability (#178)**:
  - Embedded the official `handraw-style` v1.9.13 reference snapshot (styles, layouts, colors, tones, model capabilities, aliases, and layout prompts) directly into the client binary so single-file installs work out of the box without hitting `503 资源包未加载`.
  - Added on-demand lazy fetching and local disk caching for preview thumbnails under `/files/pack/images/...`.
  - Cached `/api/models` responses (5-minute TTL) with a 4-second upstream timeout and immediate loading state in `#settings`, preventing blank or hung settings pages when upstream is slow or offline.

### Security & Hardening
- **Network, Storage & Telemetry Hardening (#179)**:
  - Added DNS-pinned `DialContext` SSRF protection to `url_extract` to block private/loopback/link-local resolutions and DNS rebinding.
  - Escaped SQLite `file:` URI paths (`sqliteFileDSN`) so data directories containing `?`, `#`, or `%` cannot corrupt DSN parameters.
  - Hardened `site.Fetch` to require matching `Scheme` + `Host` before sending `Authorization: Bearer` headers and strip auth headers on cross-origin redirects.
  - Upgraded telemetry property filtering to case-insensitive sensitive substring matching (`token`, `secret`, `prompt`, `password`, etc.) and added `go vet` checks to CI.

### Architecture, Docs & Tests
- **Unified Market Sources, Shared Safe Zip Installer & Core Tests (#180)**:
  - Consolidated the 4 duplicated market source configurations (plugins, skills, galleries, Obsidian) onto a shared `MarketSource` type and unified all 4 zip installers onto `internal/ziputil` (symlink rejection, zip-slip protection, entry count and total size caps).
  - Tightened `internal/providers` in-memory response caps to 64 MiB and added streaming `DownloadToFile` helper.
  - Prevented unsupported `linux` (`nogui`) builds from advertising nonexistent release assets in the updater.
  - Expanded `README.md` with installation instructions, OS signing caveats, and attribution notice, and added unit test coverage for `internal/settings` and `internal/secrets`.

## v0.6.4 (2026-11-26)

### Security & Reliability
- **Updater (#176)**:
  - Resource pack integrity check now computes actual streaming SHA-256 hashes rather than checking file size alone, allowing same-size corrupted files to self-heal.
  - Resource pack signature verification is now strictly fail-closed (refuses updates when `PublicKey` is empty), matching binary updates.
  - Binary downloads now stream directly to a temporary file while hashing and enforce strict download/metadata/unzip size & entry limits to prevent OOM and zip bombs.
  - macOS bundle extraction validates symlink targets and parent path segments to prevent symlink-based directory traversal.
  - SemVer comparison (`Newer`) now handles prerelease precedence (`1.0.0 > 1.0.0-rc.1 > 1.0.0-beta.2 > 1.0.0-beta.1`).
- **Core, Store, Telemetry & Docs (#177)**:
  - Fixed potential goroutine leak in `internal/jobs` overflow enqueue path by honoring shutdown context cancellation and tracking overflow enqueues in `Wait()`.
  - Eliminated N+1 queries in `store.ListRuns` and `store.ActiveImages`, checked all `rows.Scan` / `rows.Err()` errors, escaped `%`/`_`/`\` wildcards in short `LIKE` searches, and added unit tests (`internal/store/store_test.go`).
  - Fixed UTF-8 multi-byte string truncation in `internal/telemetry` (rune-aware slicing) and removed token exposure from URL/argv in `tools/mirror-gitee.py`.
  - Documented opt-out anonymous telemetry clearly in `README.md` and `docs/product.md`, and added `LICENSE` (MIT License with Attribution Requirement) & `CHANGELOG.md`.

## v0.6.3 (2026-11-26)
- Synced Home Discover feed with Web (`#175`): added Inspiration Vault cards with in-app remix modal, deduplicated inspiration forum topics, adopted server-side `resourceRanking` order, and aligned 20-card mixed cadence.

## v0.6.2 (2026-11-26)
- Added privacy-friendly anonymous desktop usage telemetry with one-click opt-out toggle in Settings (`#174`).

## v0.6.1 (2026-11-26)
- Switched default software & resource update feed priority to Gitee Releases, with automatic fallback to `handraw-style.com/static/client/latest.json` and GitHub Releases (`#173`).
- Added automated GitHub → Gitee repository & release mirroring (`#172`).

## v0.6.0 (2026-11-26)
- Platform-aware update availability checks (`#167`) and local HTTP guard against DNS rebinding (`#171`).
- Waterfall style/layout pickers with shared server ranking, private/public resource consistency, and community deduplication.

## v0.5.0 (2026-11-20)
- Signed automated release pipeline for Windows (amd64/arm64) and macOS (arm64/amd64) with ed25519 `SHA256SUMS.sig` verification (`#43`).
