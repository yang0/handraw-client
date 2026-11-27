# Changelog

All notable changes to `handraw-client` are documented in this file.

## v0.6.8 (2026-11-26)

### Diagnostics & Reliability
- **Privacy-Safe Client Error & Crash Reporting (#186)**:
  - Captured frontend JS runtime/promise/API `>= 500` errors, local Go server panics & `>= 500` responses, quit-update apply failures, and previous-session Go process crashes (`debug.SetCrashOutput` → `<appdir>/crash-last.log`).
  - Added local path/username, credential/token (`Bearer`/`hwc_`/`sk-`/`ghp_`/JWT), URL query, email, and phone redaction, 10-minute fingerprint deduplication with suppressed count rollups, and a 20/hour sliding rate limit; strictly honors the Settings telemetry opt-out toggle.

### Fixes
- **Public `/api/boot` Fallback & Optional Endpoint Negative Cache (#187)**:
  - Switched community catalog fallback `/api/boot?surface=catalog` to unauthenticated `Site.Public` requests so desktop `hwt_` tokens no longer trigger `403 token_scope_denied`.
  - Added per-session negative caching for optional dedicated endpoints (`/api/studio/canvas-assistant`, `/api/studio/analyze-style`) on `403`/`404` so callers fall back immediately to `/api/ai/chat` without redundant round-trips.
  - Isolated site keyring tests to `HANDRAW_SECRETS=memory` for headless Linux CI and developer keyring safety.

## v0.6.7 (2026-11-26)

### Features & UX
- **Seamless Auto-Update & Low-Load Distribution (#182)**:
  - Enabled default background silent download, ed25519/SHA-256 verification, and automatic **Apply-on-Quit** replacement (with a topbar `已就绪 · 重启升级` pill, one-time toast per version, and 3-mode selector in Settings: `auto` / `notify` / `off`).
  - Separated metadata checks (Cloudflare-cached `handraw-style.com/static/client/latest.json` with `ETag` / `304 Not Modified`, 6-hour persistent cooldown, startup & loop jitter, and deterministic `rolloutPercent` / `spreadHours` smoothing) from binary downloads (`asset.mirrors` preferring Gitee Releases CDN → GitHub → official fallback).
  - Deferred automatic downloads while image generation jobs are active, added exponential failure backoff (`30m → 2h → 6h`, max 3 auto retries per version), and guarded against quit-apply failure loops.
- **Launch at Login (#183)**:
  - Added cross-platform user-scope launch-at-login (Windows `HKCU\...\Run`, macOS `LaunchAgents` plist, Linux XDG autostart), enabled by default with an opt-out toggle in Settings.
  - Added `--autostart` silent boot into the system tray when `minimizeToTray` is enabled, plus temporary/dev executable protection.
- **Embedded Pre-Paired Inspiration Clipper Extension (#185)**:
  - Embedded `extensions/handraw-clipper` (v1.0.4) directly into single-binary builds and auto-extracted it to `<appdir>/extensions/handraw-clipper/` with pre-paired `defaults.json` (`0600`), eliminating manual token copy-pasting.
  - Added `POST /api/settings/clipper/prepare` and one-click folder open buttons in Settings & Inspiration Vault; token rotation automatically refreshes `defaults.json`.

### Fixes
- **Meaningful Batch Work Titles (#184)**:
  - Derived clear titles for series and canvas batch works instead of generic placeholders.

## v0.6.6 (2026-11-26)

### Network & Connectivity Fixes
- **System Proxy, IPv4-First Dialing & Transient Reset Retry (#181)**:
  - Added `internal/netutil` desktop HTTP transport installed as `http.DefaultTransport` on startup: automatically reads OS system proxy settings (Windows Internet Settings registry & macOS `scutil --proxy`) in addition to `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, supports standard & macOS shorthand CIDRs in bypass rules, and always bypasses loopback addresses.
  - Preferred IPv4 (`tcp4`) before falling back to IPv6 (`tcp6`), preventing TLS handshake resets on dual-stack ISPs with broken Cloudflare IPv6 routes that previously broke website login, lazy thumbnail loading, and community feeds.
  - Added automatic single-retry on transient pre-response TCP/TLS resets (`wsarecv` / `connection reset` / `EOF`) with actionable Chinese network diagnostics across `internal/site` (including `Fetch`) and `internal/updater`.
  - Updated `url_extract` and Obsidian plugin `ProxyHTTPRequest` SSRF-protected transports to work seamlessly when an OS system proxy is active while still blocking direct/redirect SSRF to private or disallowed local addresses and preferring IPv4 for direct dials.

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
