# Changelog

All notable changes to `handraw-client` are documented in this file.

## v0.6.15 (2026-11-28)

### Features
- **Auto-Discover DeepSeek Harness Desktop CLI & `dsh` Headless Driver (#203)**:
  - Automatically discovered the bundled `resources/runtime/cli/bin/dsh(.cmd)` inside DeepSeek Harness Desktop installations on Windows (default locations + Windows Uninstall registry lookup for custom install directories) and macOS/Linux (`.app` bundle & `$DSH_HOME/bin`).
  - Added dedicated `dsh` headless driver support (`dsh --profile headless --approval-policy never [--add-dir ...] -` with stdin prompt passing) so DeepSeek Harness works out of the box in Chat and Studio planning.

## v0.6.14 (2026-11-28)

### Features & UX
- **Inspiration Vault Multi-Item Batch Collection & AI Auto-Titling (#201)**:
  - Removed the manual title input box (and redundant per-item source URL input) from the **「收集新灵感」** modal so AI automatically generates clean Chinese titles on save.
  - Upgraded the modal into a compact multi-item horizontal card queue supporting **「＋ 再加一条」**, **「🖼 批量选图」**, multi-image drag-and-drop auto-splitting, and continuous keyboard-only `Ctrl+V` image pasting (fills the active card if empty or auto-appends a new card and focuses its prompt box).
  - Added 2-way concurrent batch submission with per-card live status, shared folder & AI-organize options, and partial-failure preservation so failed items can be retried without duplicating succeeded ones.
- **Studio & Asset Deep Links (#199)**:
  - Added `handraw://studio` and `handraw://asset` deep-link routing support.

### Fixes & Reliability
- **Custom Style Prompt Preservation & Accurate `rawUserPrompt` (#200)**:
  - Set `promptFromSkill: true` on website generation payloads whenever the client has already composed the Skill prompt locally (including local custom styles `MY-S-*` and layouts `MY-L-*`), preventing server-side re-composition from dropping custom style traits.
  - Forwarded the user's concise original input (`originalRequest` → `rawUserPrompt`) separately from AI-expanded scene prompts so local history and Admin logs keep raw user input and Skill-resolved prompts cleanly separated.
- **Production Log Audit Fixes & Telemetry Noise Reduction (#202)**:
  - Auto-stripped accidental endpoint suffixes (`/chat/completions`, `/images/generations`, `/images/edits`, `/models`) from third-party provider `BaseURL`s and returned `400 provider_unreachable` instead of `500` when testing unreachable custom endpoints.
  - Preserved public catalog-relative paths for `/files/pack/...` `media_broken` diagnostics while filtering out detached DOM image errors caused by rapid view switches.
  - Suppressed `api_network: Failed to fetch` error floods during window unload, restart, or OS sleep, and filtered third-party content safety/policy 400 rejections out of `job_tech_fail`.
  - Added short backoff retries (`200ms`/`500ms`/`1s`) around Windows updater binary rename to tolerate transient antivirus or handle locks.

## v0.6.13 (2026-11-27)

### Fixes
- **Consistent Update Status Across Topbar & Settings (#196)**:
  - Cleared `Ready`, `AutoApplyOnQuit`, and `StagedVersion` at the start of `Updater.Download()` so `downloading` and `ready` are strictly mutually exclusive when downloading a newer release while a previous update was already staged.
  - Subscribed the Settings update card (`web/js/views/settings.js`) to live `update` SSE events, made download/apply buttons mutually exclusive, and rendered ready banners/buttons with `stagedVersion || latest` consistently across both topbar and Settings.

### UX & Onboarding
- **Streamlined First-Run Consent Modal (#197)**:
  - Redesigned the first-run consent dialog (`web/js/consent.js`, `web/css/app.css`) with a compact 3-column promise strip, unified option list card, and single-row footer so it fits cleanly on desktop without scrollbars.
  - Pre-checked preferences by default in the first-run modal while keeping the Go backend's pre-consent hard gate intact until the user clicks **「同意并开始使用」**.
- **Built-in Auto-Update & Clearer Preference Copy (#198)**:
  - Made automatic check and silent background update a fixed built-in capability after consent (`cmd/handraw/main.go`), removing the auto-update toggle/selector from the first-run modal and Settings UI.
  - Refined telemetry and launch-at-login copy in both the consent modal and Settings to clarify product improvement without personal privacy data and explain that clipping prompts from X requires the client running in the background tray.

## v0.6.12 (2026-11-26)

### Fixes
- **Updater Double-Apply Fix, Pack Thumbnail Throttling & Task Reconcile Cleanup (#192)**:
  - Serialized `Updater.Apply()` and marked the binary as applied immediately on success so graceful shutdown (`ApplyIfReady`) never attempts a second rename during "重启升级", eliminating spurious Windows `Access is denied` errors; added `.old.<pid>` fallback when `.old` is locked and cleaned up `.old*` backups in `CleanupOld()`.
  - Bounded `/files/pack/images/` lazy thumbnail fetches with a 4-way concurrency cap, per-path singleflight deduplication, and `429`/`503` backoff retries so single-file users browsing the Atlas no longer trigger upstream media rate limits.
  - Updated `reconcileSitePublishedWork` to skip failed/unsubmitted images without a `RemoteTaskID` and negative-cache terminal 404 misses, eliminating repeated `/api/studio/tasks` 404 storms after synchronous generation failures.
  - Redacted non-`Users` Windows drive directory paths (`<WIN_PATH>\...`) and normalized full local paths in error fingerprints so identical failures across install folders aggregate under one fingerprint.
- **X (Twitter) Inspiration Image Clipping & Third-Party Media Rendering (#193)**:
  - Upgraded embedded `handraw-clipper` to `v1.0.5` with `pbs.twimg.com` host permission so Chrome fetches clipped images directly as `imageDataUrl` (≤ 8 MiB) using the browser's own proxy/session.
  - Hardened `fetchRemoteImageBytes` with `netutil.DoWithRetry`, `Accept`/`Referer` headers, and `.avif`/`.heic` extension sniffing; returned `imageWarning` on download failure and added `POST /api/inspirations/{id}/refetch-image` with a one-click **「重新拉取本地图」** action in the detail modal.
  - Updated `remoteThumb()` to proxy only site-hosted/relative media via `/files/remote` and render third-party URLs directly (`referrerpolicy="no-referrer"`), eliminating 100% 403 broken images on X inspirations.
- **Inspiration Vault Batch Delete & Clear Selection Label (#195)**:
  - Renamed the ambiguous batch-mode **「清空」** button to **「取消全选」** and added a real **「🗑 批量删除」** action backed by `POST /api/inspirations/batch-delete` with an in-app `showModal` confirmation dialog and safe local cache cleanup (`library/inspirations/` only).

### Diagnostics & Observability
- **Full-Pipeline Error Capture v2 (#194)**:
  - Added `severity` (`critical` / `error` / `warn`) and host-only `domain` fields with independent per-tier hourly rate limits so warning bursts never starve crash or panic reports.
  - Added capture-phase frontend resource error reporting (`media_broken` / `asset_load_fail`), `api_network` & unexpected `api_protocol_4xx` tracking, `observeMedia` proxy monitoring for `/files/*` and gallery image routes, and silent-degradation hooks for inspiration image fetches, clipper failures, technical generation job failures, background update downloads, and launch-at-login errors.

## v0.6.11 (2026-11-26)

### Privacy & Trust
- **First-Run Privacy & Usage Consent Modal, Strict Opt-in Defaults & Telemetry Inspector (#191)**:
  - Changed default preferences to strict opt-in (`telemetryDisabled: true`, `launchAtLogin: false`) and enforced a pre-consent hard gate on startup: zero telemetry/crash requests, zero system autostart registry/LaunchAgents writes, and zero background auto-update downloads until the user explicitly accepts.
  - Added a first-run native `<dialog>` privacy & usage notice modal explaining local-first storage, open-source auditability, and generation visibility controls, with explicit per-option checkboxes, **「暂不同意并退出」** (`POST /api/app/quit`), and **「同意并开始使用」**.
  - Split **「隐私、数据与协议」** into a dedicated Settings section with a live **telemetry transparency inspector** (`GET /api/telemetry/inspect`) displaying the allowed event whitelist, redacted sensitive keywords, consent version/timestamp, and the actual recent JSON batches sent during the session, plus a button to reopen the consent dialog anytime.

## v0.6.10 (2026-11-26)

### Fixes & UX
- **Default 1K Resolution & Clear 2K/4K Insufficient-Balance Guidance (#190)**:
  - Changed the default image resolution across Studio, Article, Series, Canvas, Quick Shot, and built-in canvas templates from `2k` to `1k` so users with 1K free quota generate for free out of the box.
  - Added clear `insufficient_cash` guidance on both pre-quote (`POST /api/generate` HTTP 402) and async job failures explaining when a paid `2K`/`4K` resolution caused insufficient cash (noting AI bonus credit does not apply to image generation and showing remaining 1K free quota), plus a one-click **「切回 1K 免费生成」** dialog action.

## v0.6.9 (2026-11-26)

### Features & UX
- **Topbar Recommend/Submit Plugin Entry & Polished Two-Step Modal (#189)**:
  - Added a warm-paper `🧩 推荐插件` pill button right next to `＋ 新建` in the global topbar (and a `🧩 推荐或提交插件` action in the `⌘K` command palette) so both plugin authors and community members who discover great plugins can submit effortlessly from anywhere.
  - Upgraded the shared submission modal into a low-friction two-step warm-paper workflow with role radio cards (`发现好物，顺手推荐` vs `我自己开发的`), 4-channel category cards (工作台插件 / 图库插件 / AI Skills / 写作插件), one-click clipboard paste, AI repo auto-inspection, step progress indicator, optional recommendation notes (`[好物推荐]` / `[作者自荐]`), automatic repo-author attribution, and an improved `我的记录` status view.

### Fixes
- **Creator Earnings Field Alignment in Inspiration Vault (#188)**:
  - Aligned creator-earnings field mapping in `web/js/views/inspirations.js` with the `handraw-web` API response shape.

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
