package telemetry

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	errDedupWindow   = 10 * time.Minute
	maxErrorsPerHour = 20
	maxCrashReadSize = 16 << 10
)

type errDedupEntry struct {
	lastSent   time.Time
	suppressed int
}

// ErrorReport carries a structured, pre-sanitization runtime error or crash (#186).
type ErrorReport struct {
	Category string // js_error | unhandled_rejection | api_5xx | http_panic | http_5xx | updater_apply | go_crash
	Source   string // frontend | backend | crash
	Route    string // normalized API route or view, e.g. "POST /api/account/login"
	Location string // script file:line or Go package/file:line
	Status   int    // HTTP status when applicable
	Message  string
	Stack    string
}

var (
	reWinUserPath  = regexp.MustCompile(`(?i)([a-z]:\\users\\)([^\\/\s"']+)`)
	reUnixUserPath = regexp.MustCompile(`(/(?:Users|home)/)([^/\s"']+)`)
	reBearerSecret = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}`)
	reKnownToken   = regexp.MustCompile(`\b(?:hwc_[0-9a-fA-F]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pou]_[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,})\b`)
	reQuerySecret  = regexp.MustCompile(`(\?[^\s"']+)`)
	reEmail        = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
	reCNPhone      = regexp.MustCompile(`\b1[3-9]\d{9}\b`)
	reHexNum       = regexp.MustCompile(`0x[0-9a-fA-F]+`)
	reUUID         = regexp.MustCompile(`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`)
	reLongDigits   = regexp.MustCompile(`\b\d{5,}\b`)
	reSpaces       = regexp.MustCompile(`\s+`)
)

// SanitizeErrorText strips personal paths, tokens, query parameters, emails,
// and phone numbers so error diagnostics never leak user PII or secrets (#186).
func SanitizeErrorText(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = reBearerSecret.ReplaceAllString(s, `${1}<REDACTED>`)
	s = reKnownToken.ReplaceAllString(s, `<REDACTED>`)
	s = reQuerySecret.ReplaceAllString(s, `?<REDACTED>`)
	s = reWinUserPath.ReplaceAllString(s, `${1}<USER>`)
	s = reUnixUserPath.ReplaceAllString(s, `${1}<USER>`)
	s = reEmail.ReplaceAllString(s, `<EMAIL>`)
	s = reCNPhone.ReplaceAllString(s, `<PHONE>`)
	s = strings.TrimSpace(reSpaces.ReplaceAllString(s, " "))
	return s
}

// SanitizeStack trims a Go or JS stack trace to project-relevant frames,
// redacts local filesystem prefixes and secrets, and caps its length (#186).
func SanitizeStack(raw string) string {
	raw = strings.TrimSpace(strings.ReplaceAll(raw, "\r\n", "\n"))
	if raw == "" {
		return ""
	}
	lines := strings.Split(raw, "\n")
	var kept []string
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		// Normalize absolute repo paths down to relative paths.
		if idx := strings.Index(strings.ToLower(ln), "handraw-client/"); idx >= 0 {
			ln = ln[idx:]
		} else if idx := strings.Index(strings.ToLower(ln), `handraw-client\`); idx >= 0 {
			ln = strings.ReplaceAll(ln[idx:], `\`, "/")
		}
		ln = SanitizeErrorText(ln)
		if ln == "" {
			continue
		}
		kept = append(kept, ln)
		if len(kept) >= 8 {
			break
		}
	}
	out := strings.Join(kept, "\n")
	if utf8.RuneCountInString(out) > 600 {
		out = string([]rune(out)[:600])
	}
	return out
}

// NormalizeRoute strips query parameters and replaces volatile IDs in API paths
// so errors on the same endpoint aggregate under one fingerprint.
func NormalizeRoute(method, rawPath string) string {
	p := strings.TrimSpace(rawPath)
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	if p == "" {
		return ""
	}
	segs := strings.Split(p, "/")
	for i, seg := range segs {
		if seg == "" {
			continue
		}
		if reUUID.MatchString(seg) || reLongDigits.MatchString(seg) ||
			strings.HasPrefix(seg, "run_") || strings.HasPrefix(seg, "img_") ||
			strings.HasPrefix(seg, "insp_") || strings.HasPrefix(seg, "rcp_") {
			segs[i] = ":id"
		}
	}
	norm := strings.Join(segs, "/")
	m := strings.ToUpper(strings.TrimSpace(method))
	if m != "" {
		return m + " " + norm
	}
	return norm
}

func errorFingerprint(r ErrorReport) string {
	normMsg := SanitizeErrorText(r.Message)
	normMsg = reHexNum.ReplaceAllString(normMsg, "0x*")
	normMsg = reUUID.ReplaceAllString(normMsg, ":uuid")
	normMsg = reLongDigits.ReplaceAllString(normMsg, ":num")
	if utf8.RuneCountInString(normMsg) > 100 {
		normMsg = string([]rune(normMsg)[:100])
	}
	key := strings.Join([]string{
		strings.ToLower(strings.TrimSpace(r.Category)),
		strings.ToLower(strings.TrimSpace(r.Source)),
		strings.TrimSpace(r.Route),
		strings.TrimSpace(r.Location),
		normMsg,
	}, "|")
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:6])
}

func (c *Client) now() time.Time {
	if c != nil && c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// ReportError enqueues a deduplicated, rate-limited, privacy-sanitized
// client_error event. Respects TelemetryDisabled and never blocks (#186).
func (c *Client) ReportError(r ErrorReport) bool {
	if !c.isEnabled() {
		return false
	}
	if strings.TrimSpace(r.Category) == "" {
		r.Category = "runtime_error"
	}
	if strings.TrimSpace(r.Source) == "" {
		r.Source = "backend"
	}
	fp := errorFingerprint(r)
	now := c.now()

	c.errMu.Lock()
	if c.errSeen == nil {
		c.errSeen = map[string]errDedupEntry{}
	}
	// Prune hourly sliding window timestamps.
	cutoff := now.Add(-1 * time.Hour)
	kept := c.errTimes[:0]
	for _, ts := range c.errTimes {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	c.errTimes = kept

	count := 1
	if ent, ok := c.errSeen[fp]; ok && now.Sub(ent.lastSent) < errDedupWindow {
		ent.suppressed++
		c.errSeen[fp] = ent
		c.errMu.Unlock()
		return false
	} else if ok && ent.suppressed > 0 {
		count += ent.suppressed
	}
	if len(c.errTimes) >= maxErrorsPerHour {
		c.errMu.Unlock()
		return false
	}
	c.errSeen[fp] = errDedupEntry{lastSent: now, suppressed: 0}
	c.errTimes = append(c.errTimes, now)
	c.errMu.Unlock()

	props := map[string]any{
		"fingerprint": fp,
		"category":    r.Category,
		"source":      r.Source,
		"count":       count,
		"message":     r.Message,
	}
	if r.Route != "" {
		props["route"] = r.Route
	}
	if r.Location != "" {
		props["location"] = r.Location
	}
	if r.Status > 0 {
		props["status"] = r.Status
	}
	if r.Stack != "" {
		props["stack"] = r.Stack
	}
	c.Track("client_error", props)
	return true
}

// ReportPreviousCrash inspects crashPath from a prior run; if a crash log is
// found, it extracts a sanitized summary + stack, enqueues one client_crash
// event, and deletes the file so it is reported at most once (#186).
func (c *Client) ReportPreviousCrash(crashPath string) bool {
	if strings.TrimSpace(crashPath) == "" {
		return false
	}
	f, err := os.Open(crashPath)
	if err != nil {
		return false
	}
	raw, _ := io.ReadAll(io.LimitReader(f, maxCrashReadSize))
	_ = f.Close()
	_ = os.Remove(crashPath)

	text := strings.TrimSpace(string(raw))
	if text == "" || !c.isEnabled() {
		return false
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	headline := ""
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln != "" {
			headline = ln
			break
		}
	}
	if headline == "" {
		headline = "fatal runtime crash"
	}
	rep := ErrorReport{
		Category: "go_crash",
		Source:   "crash",
		Message:  headline,
		Stack:    text,
	}
	fp := errorFingerprint(rep)
	c.Track("client_crash", map[string]any{
		"fingerprint": fp,
		"category":    "go_crash",
		"source":      "crash",
		"count":       1,
		"message":     rep.Message,
		"stack":       rep.Stack,
	})
	return true
}

// SetupCrashOutput directs Go fatal runtime crash dumps to crashPath so the
// next launch can report the previous crash via ReportPreviousCrash (#186).
func SetupCrashOutput(crashPath string) error {
	if strings.TrimSpace(crashPath) == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(crashPath), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(crashPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		_ = f.Close()
		return err
	}
	// debug.SetCrashOutput duplicates the fd internally, so we can close our handle.
	return f.Close()
}
