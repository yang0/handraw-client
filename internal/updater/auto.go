package updater

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// AutoModeAuto silently downloads, verifies, and applies updates on quit (#182).
	AutoModeAuto = "auto"
	// AutoModeNotify checks on schedule and notifies the user without auto-downloading.
	AutoModeNotify = "notify"
	// AutoModeOff disables automatic background update checks.
	AutoModeOff = "off"

	// DefaultCheckCooldown prevents repeated network checks across rapid restarts.
	DefaultCheckCooldown = 6 * time.Hour
	// DefaultSpreadHours smooths automatic background downloads across 2 hours
	// after release publication to avoid thundering-herd spikes on mirrors (#182).
	DefaultSpreadHours = 2.0
	// MaxAutoDownloadRetries caps automatic retries per release version.
	MaxAutoDownloadRetries = 3
)

var autoRetryBackoffs = []time.Duration{
	30 * time.Minute,
	2 * time.Hour,
	6 * time.Hour,
}

type persistedState struct {
	LastCheckAt        string   `json:"lastCheckAt,omitempty"`
	ETag               string   `json:"etag,omitempty"`
	ETagFeed           string   `json:"etagFeed,omitempty"`
	CachedRelease      *Release `json:"cachedRelease,omitempty"`
	StagedVersion      string   `json:"stagedVersion,omitempty"`
	StagedAsset        string   `json:"stagedAsset,omitempty"`
	StagedPath         string   `json:"stagedPath,omitempty"`
	StagedSHA256       string   `json:"stagedSha256,omitempty"`
	AutoFailVersion    string   `json:"autoFailVersion,omitempty"`
	AutoFailCount      int      `json:"autoFailCount,omitempty"`
	NextRetryAt        string   `json:"nextRetryAt,omitempty"`
	ApplyFailedVersion string   `json:"applyFailedVersion,omitempty"`
}

func (u *Updater) now() time.Time {
	if u.Now != nil {
		return u.Now()
	}
	return time.Now()
}

func (u *Updater) currentMode() string {
	if u.Mode != nil {
		switch strings.ToLower(strings.TrimSpace(u.Mode())) {
		case AutoModeNotify:
			return AutoModeNotify
		case AutoModeOff:
			return AutoModeOff
		case AutoModeAuto:
			return AutoModeAuto
		}
	}
	return AutoModeAuto
}

func (u *Updater) statePath() string {
	if strings.TrimSpace(u.Dir) == "" {
		return ""
	}
	return filepath.Join(u.Dir, "state.json")
}

func (u *Updater) loadState() persistedState {
	p := u.statePath()
	if p == "" {
		return persistedState{}
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return persistedState{}
	}
	var st persistedState
	if err := json.Unmarshal(b, &st); err != nil {
		return persistedState{}
	}
	return st
}

func (u *Updater) saveState(st persistedState) {
	p := u.statePath()
	if p == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		_ = os.WriteFile(p, b, 0o600)
	}
}

func (u *Updater) updateState(fn func(*persistedState)) persistedState {
	u.stateMu.Lock()
	defer u.stateMu.Unlock()
	st := u.loadState()
	fn(&st)
	u.saveState(st)
	return st
}

// LoadStaged restores a previously downloaded and verified update from disk
// so the client never re-downloads the same version across restarts (#182).
func (u *Updater) LoadStaged() {
	u.stateMu.Lock()
	st := u.loadState()
	u.stateMu.Unlock()

	if st.StagedVersion == "" {
		u.syncModeFields()
		return
	}
	// If we are already running the staged version (or newer), clean up stale state.
	if !Newer(st.StagedVersion, u.Version) {
		if st.StagedPath != "" && isWithinDir(u.Dir, st.StagedPath) {
			_ = os.Remove(st.StagedPath)
		}
		u.updateState(func(s *persistedState) {
			s.StagedVersion = ""
			s.StagedAsset = ""
			s.StagedPath = ""
			s.StagedSHA256 = ""
			if s.ApplyFailedVersion == st.StagedVersion {
				s.ApplyFailedVersion = ""
			}
		})
		u.syncModeFields()
		return
	}
	wantAsset := assetName()
	if wantAsset == "" || st.StagedAsset != wantAsset || st.StagedPath == "" || st.StagedSHA256 == "" {
		u.syncModeFields()
		return
	}
	if !isWithinDir(u.Dir, st.StagedPath) || !fileSHA256Matches(st.StagedPath, st.StagedSHA256) {
		u.updateState(func(s *persistedState) {
			s.StagedVersion = ""
			s.StagedAsset = ""
			s.StagedPath = ""
			s.StagedSHA256 = ""
		})
		u.syncModeFields()
		return
	}
	mode := u.currentMode()
	applyFailed := st.ApplyFailedVersion == st.StagedVersion
	u.mu.Lock()
	u.staged = st.StagedPath
	u.stagedVersion = st.StagedVersion
	u.stagedSHA256 = st.StagedSHA256
	if st.CachedRelease != nil && strings.TrimPrefix(st.CachedRelease.Tag, "v") == st.StagedVersion {
		u.release = st.CachedRelease
	}
	u.mu.Unlock()
	u.set(func(s *Status) {
		s.Latest = st.StagedVersion
		s.StagedVersion = st.StagedVersion
		s.AssetName = wantAsset
		s.Available = true
		s.Ready = true
		s.Progress = 100
		s.AutoMode = mode
		s.ApplyFailed = applyFailed
		s.AutoApplyOnQuit = mode == AutoModeAuto && !applyFailed
		if st.CachedRelease != nil && strings.TrimPrefix(st.CachedRelease.Tag, "v") == st.StagedVersion {
			s.Notes = st.CachedRelease.Body
		}
	})
}

func (u *Updater) syncModeFields() {
	mode := u.currentMode()
	u.set(func(s *Status) {
		s.AutoMode = mode
		s.AutoApplyOnQuit = s.Ready && mode == AutoModeAuto && !s.ApplyFailed
	})
}

// SyncMode refreshes AutoMode / AutoApplyOnQuit in Status after settings change.
func (u *Updater) SyncMode() { u.syncModeFields() }

func fileSHA256Matches(path, wantHex string) bool {
	wantHex = strings.ToLower(strings.TrimSpace(wantHex))
	if wantHex == "" {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	return strings.EqualFold(hex.EncodeToString(h.Sum(nil)), wantHex)
}

// RolloutBucket maps (deviceKey, version) deterministically to [0, 99] so
// staged rollouts and download smoothing stay stable per device & release (#182).
func RolloutBucket(deviceKey, version string) int {
	key := strings.TrimSpace(deviceKey)
	if key == "" {
		key = "anon"
	}
	ver := strings.TrimPrefix(strings.TrimSpace(version), "v")
	sum := sha256.Sum256([]byte(key + ":" + ver))
	return int(binary.BigEndian.Uint16(sum[:2]) % 100)
}

// EvaluateAutoDownload checks rollout percentage and spread-window timing for
// automatic background downloads. Manual clicks bypass this check.
// Returns (eligibleNow, deferUntil). If !eligibleNow and deferUntil.IsZero(),
// this device is outside the rollout percentage for this version.
func EvaluateAutoDownload(rel *Release, deviceKey string, now time.Time) (bool, time.Time) {
	if rel == nil {
		return false, time.Time{}
	}
	pct := rel.RolloutPercent
	if pct < 0 {
		return false, time.Time{}
	}
	if pct == 0 || pct > 100 {
		pct = 100
	}
	bucket := RolloutBucket(deviceKey, rel.Tag)
	if bucket >= pct {
		return false, time.Time{}
	}
	spreadHours := DefaultSpreadHours
	if rel.SpreadHours != nil {
		spreadHours = *rel.SpreadHours
	}
	if spreadHours <= 0 || strings.TrimSpace(rel.Published) == "" {
		return true, time.Time{}
	}
	pubAt, err := time.Parse(time.RFC3339, strings.TrimSpace(rel.Published))
	if err != nil {
		return true, time.Time{}
	}
	offset := time.Duration(float64(bucket) / 100.0 * spreadHours * float64(time.Hour))
	slot := pubAt.Add(offset)
	if now.Before(slot) {
		return false, slot
	}
	return true, time.Time{}
}

// CheckAuto checks for updates while honoring the persistent cooldown window
// so frequent app restarts do not hammer update servers (#182).
func (u *Updater) CheckAuto(ctx context.Context) (Status, error) {
	cooldown := u.CheckCooldown
	if cooldown <= 0 {
		cooldown = DefaultCheckCooldown
	}
	u.stateMu.Lock()
	st := u.loadState()
	u.stateMu.Unlock()

	if st.LastCheckAt != "" && st.CachedRelease != nil {
		if lastAt, err := time.Parse(time.RFC3339, st.LastCheckAt); err == nil {
			if u.now().Sub(lastAt) < cooldown {
				return u.applyReleaseStatus(st.CachedRelease, lastAt), nil
			}
		}
	}
	return u.Check(ctx)
}

// AutoStep runs one background auto-update cycle (check with cooldown, check
// busy/backoff/rollout eligibility, and download silently if eligible).
// Returns an optional earlier wakeup time if deferred by busy state or spread window.
func (u *Updater) AutoStep(ctx context.Context) (nextWake time.Duration) {
	mode := u.currentMode()
	u.syncModeFields()
	if mode == AutoModeOff {
		return 0
	}
	st, err := u.CheckAuto(ctx)
	if err != nil || mode != AutoModeAuto {
		return 0
	}
	if !st.Available || st.Ready || st.Downloading {
		return 0
	}
	if u.IsBusy != nil && u.IsBusy() {
		return 2 * time.Minute
	}

	u.stateMu.Lock()
	ps := u.loadState()
	u.stateMu.Unlock()

	// Respect per-version failure cap & exponential backoff.
	if ps.AutoFailVersion == st.Latest {
		if ps.AutoFailCount >= MaxAutoDownloadRetries {
			return 0
		}
		if ps.NextRetryAt != "" {
			if retryAt, rerr := time.Parse(time.RFC3339, ps.NextRetryAt); rerr == nil && u.now().Before(retryAt) {
				return retryAt.Sub(u.now())
			}
		}
	}

	u.mu.Lock()
	rel := u.release
	u.mu.Unlock()

	key := ""
	if u.BucketKey != nil {
		key = u.BucketKey()
	}
	eligible, deferUntil := EvaluateAutoDownload(rel, key, u.now())
	if !eligible {
		if !deferUntil.IsZero() {
			u.set(func(s *Status) { s.AutoDeferredUntil = deferUntil.UTC().Format(time.RFC3339) })
			d := deferUntil.Sub(u.now())
			if d < time.Second {
				d = time.Second
			}
			return d
		}
		return 0
	}
	u.set(func(s *Status) { s.AutoDeferredUntil = "" })

	dlCtx, cancel := context.WithTimeout(ctx, 25*time.Minute)
	defer cancel()
	if dlErr := u.Download(dlCtx); dlErr != nil {
		u.recordAutoDownloadFailure(st.Latest)
		if u.OnDownloadError != nil {
			u.OnDownloadError(st.Latest, dlErr)
		}
		return 0
	}
	return 0
}

func (u *Updater) recordAutoDownloadFailure(ver string) {
	ver = strings.TrimPrefix(strings.TrimSpace(ver), "v")
	if ver == "" {
		return
	}
	u.updateState(func(s *persistedState) {
		if s.AutoFailVersion != ver {
			s.AutoFailVersion = ver
			s.AutoFailCount = 1
		} else {
			s.AutoFailCount++
		}
		idx := s.AutoFailCount - 1
		if idx >= len(autoRetryBackoffs) {
			idx = len(autoRetryBackoffs) - 1
		}
		s.NextRetryAt = u.now().Add(autoRetryBackoffs[idx]).UTC().Format(time.RFC3339)
	})
}

// AutoLoop runs the jittered background check & silent download loop until ctx ends (#182).
func (u *Updater) AutoLoop(ctx context.Context, baseInterval time.Duration) {
	if baseInterval <= 0 {
		baseInterval = DefaultCheckCooldown
	}
	minDelay := u.StartupDelayMin
	maxDelay := u.StartupDelayMax
	if minDelay <= 0 {
		minDelay = 30 * time.Second
	}
	if maxDelay < minDelay {
		maxDelay = 180 * time.Second
	}
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	initial := minDelay
	if maxDelay > minDelay {
		initial += time.Duration(rng.Int63n(int64(maxDelay - minDelay)))
	}
	timer := time.NewTimer(initial)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			wake := u.AutoStep(ctx)
			next := baseInterval + time.Duration(rng.Int63n(int64(2*time.Hour)))
			if wake > 0 && wake < next {
				next = wake
			}
			timer.Reset(next)
		case <-u.nudgeCh:
			wake := u.AutoStep(ctx)
			next := baseInterval + time.Duration(rng.Int63n(int64(2*time.Hour)))
			if wake > 0 && wake < next {
				next = wake
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(next)
		}
	}
}

// NudgeAuto wakes AutoLoop (e.g. when user switches update mode to "auto").
func (u *Updater) NudgeAuto() {
	if u.nudgeCh == nil {
		return
	}
	select {
	case u.nudgeCh <- struct{}{}:
	default:
	}
}

// ApplyIfReady silently swaps the verified staged binary during graceful exit
// when auto-update mode is "auto", no generation jobs are running, and the
// staged version has not previously failed to apply (#182).
func (u *Updater) ApplyIfReady() (bool, error) {
	if u.currentMode() != AutoModeAuto {
		return false, nil
	}
	if u.IsBusy != nil && u.IsBusy() {
		return false, nil
	}
	u.mu.Lock()
	staged := u.staged
	ver := u.stagedVersion
	wantHash := u.stagedSHA256
	ready := u.status.Ready
	applied := u.applied
	u.mu.Unlock()

	if !ready || staged == "" || ver == "" || applied {
		return false, nil
	}
	u.stateMu.Lock()
	ps := u.loadState()
	u.stateMu.Unlock()
	if ps.ApplyFailedVersion == ver {
		return false, nil
	}
	if wantHash != "" && !fileSHA256Matches(staged, wantHash) {
		return false, errors.New("已暂存更新包校验不一致，已跳过退出自动安装")
	}

	if _, err := u.Apply(); err != nil {
		u.updateState(func(s *persistedState) {
			s.ApplyFailedVersion = ver
		})
		u.set(func(s *Status) {
			s.ApplyFailed = true
			s.AutoApplyOnQuit = false
		})
		return false, err
	}
	return true, nil
}

// assetURLs returns deduplicated candidate download URLs for an asset,
// preferring explicit Mirrors (e.g. Gitee Releases CDN) before asset.URL (#182).
func assetURLs(a Asset) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range append(append([]string{}, a.Mirrors...), a.URL) {
		u := strings.TrimSpace(raw)
		if u == "" || seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	return out
}
