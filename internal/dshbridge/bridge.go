// Package dshbridge manages the optional Node.js compatibility sidecar for
// DeepSeek Harness (DSH) plugins (Scheme A).
//
// Zero-overhead guarantee: the Node process is started lazily ONLY when at least
// one DSH plugin is enabled, and terminated immediately when none are enabled.
package dshbridge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/plugins"
)

//go:embed dsh-bridge.mjs
var bridgeScript []byte

// PluginStatus reports the runtime status of one loaded DSH plugin in the sidecar.
type PluginStatus struct {
	ID     string `json:"id"`
	Loaded bool   `json:"loaded"`
	Error  string `json:"error,omitempty"`
}

// Status is returned to the UI so the user can see Node availability and active routes.
type Status struct {
	NodePath     string         `json:"nodePath,omitempty"`
	NodeVersion  string         `json:"nodeVersion,omitempty"`
	Running      bool           `json:"running"`
	Error        string         `json:"error,omitempty"`
	Plugins      []PluginStatus `json:"plugins"`
	ExactRoutes  []string       `json:"exactRoutes"`
	PrefixRoutes []string       `json:"prefixRoutes"`
}

// Manager supervises the Node sidecar process and exposes reverse-proxy matching.
type Manager struct {
	mu           sync.Mutex
	runtimeDir   string
	hostURL      string
	hostToken    string
	cmd          *exec.Cmd
	stdin        io.WriteCloser
	baseURL      string
	secret       string
	proxy        *httputil.ReverseProxy
	exactRoutes  map[string]bool
	prefixRoutes []string
	pluginStates []PluginStatus
	lastErr      string
	nodePath     string
	nodeVersion  string
}

// New creates a DSH bridge manager. It does not spawn Node until Sync is called
// with at least one enabled DSH plugin.
func New(runtimeDir string) *Manager {
	m := &Manager{
		runtimeDir:  runtimeDir,
		exactRoutes: map[string]bool{},
	}
	m.nodePath, m.nodeVersion = DetectNode()
	return m
}

// SetHostEndpoint sets the Go host loopback URL and token so the sidecar can call
// Host galleries and Host models on behalf of DSH plugins.
func (m *Manager) SetHostEndpoint(hostURL, hostToken string) {
	m.mu.Lock()
	m.hostURL = strings.TrimRight(hostURL, "/")
	m.hostToken = hostToken
	m.mu.Unlock()
}

// DetectNode finds a usable Node.js (>= 20) executable on the system or inside ~/.dsh.
func DetectNode() (string, string) {
	var candidates []string
	if v := strings.TrimSpace(os.Getenv("HANDRAW_NODE")); v != "" {
		candidates = append(candidates, v)
	}
	if p, err := exec.LookPath("node"); err == nil {
		candidates = append(candidates, p)
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		dshHome := strings.TrimSpace(os.Getenv("DSH_HOME"))
		if dshHome == "" {
			dshHome = filepath.Join(home, ".dsh")
		}
		exeName := "node"
		if runtime.GOOS == "windows" {
			exeName = "node.exe"
		}
		if matches, err := filepath.Glob(filepath.Join(dshHome, "dsh-runtimes", "*", "dependencies", "node*", exeName)); err == nil {
			candidates = append(candidates, matches...)
		}
		if matches, err := filepath.Glob(filepath.Join(dshHome, "dsh-runtimes", "*", "dependencies", "node*", "bin", exeName)); err == nil {
			candidates = append(candidates, matches...)
		}
	}
	if runtime.GOOS == "windows" {
		candidates = append(candidates,
			`C:\Program Files\nodejs\node.exe`,
			`C:\Program Files (x86)\nodejs\node.exe`,
		)
	} else {
		candidates = append(candidates, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node")
	}

	seen := map[string]bool{}
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		if st, err := os.Stat(c); err != nil || st.IsDir() {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, c, "-v")
		hideWindow(cmd)
		out, err := cmd.Output()
		cancel()
		if err != nil {
			continue
		}
		ver := strings.TrimSpace(string(out))
		if ver != "" {
			return c, ver
		}
	}
	return "", ""
}

// Status returns a snapshot of the sidecar state.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	exact := make([]string, 0, len(m.exactRoutes))
	for k := range m.exactRoutes {
		exact = append(exact, k)
	}
	pfx := append([]string(nil), m.prefixRoutes...)
	pls := append([]PluginStatus(nil), m.pluginStates...)
	if pls == nil {
		pls = []PluginStatus{}
	}
	if exact == nil {
		exact = []string{}
	}
	if pfx == nil {
		pfx = []string{}
	}
	return Status{
		NodePath:     m.nodePath,
		NodeVersion:  m.nodeVersion,
		Running:      m.cmd != nil && m.baseURL != "",
		Error:        m.lastErr,
		Plugins:      pls,
		ExactRoutes:  exact,
		PrefixRoutes: pfx,
	}
}

type syncPluginPayload struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Dir       string         `json:"dir"`
	HostEntry string         `json:"hostEntry"`
	PluginID  string         `json:"pluginId,omitempty"`
	Config    map[string]any `json:"config,omitempty"`
}

// Sync reconciles the running sidecar with the full community plugin list.
// Only enabled plugins with Kind == "dsh" are loaded. If none are enabled,
// the sidecar is stopped to keep memory/process overhead at zero.
func (m *Manager) Sync(ctx context.Context, list []plugins.Community) error {
	var desired []syncPluginPayload
	for _, c := range list {
		if !c.Enabled || c.Kind != "dsh" || c.DSH == nil || c.Error != "" {
			continue
		}
		if c.DSH.Compat == "unsupported" {
			continue
		}
		desired = append(desired, syncPluginPayload{
			ID:        c.ID,
			Name:      c.Name,
			Dir:       c.Dir,
			HostEntry: c.DSH.HostEntry,
			PluginID:  c.DSH.PluginID,
			Config:    c.DSH.Config,
		})
	}

	m.mu.Lock()
	if len(desired) == 0 {
		m.stopLocked()
		m.lastErr = ""
		m.mu.Unlock()
		return nil
	}
	if err := m.ensureRunningLocked(); err != nil {
		m.lastErr = err.Error()
		m.mu.Unlock()
		return err
	}
	baseURL := m.baseURL
	secret := m.secret
	m.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{"plugins": desired})
	reqCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "POST", baseURL+"/__bridge/sync", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Bridge-Secret", secret)
	resp, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
	if err != nil {
		m.mu.Lock()
		m.lastErr = "同步 DSH Sidecar 失败：" + err.Error()
		m.mu.Unlock()
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		err := fmt.Errorf("DSH Sidecar 返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
		m.mu.Lock()
		m.lastErr = err.Error()
		m.mu.Unlock()
		return err
	}

	var res struct {
		Plugins      []PluginStatus `json:"plugins"`
		ExactRoutes  []string       `json:"exactRoutes"`
		PrefixRoutes []string       `json:"prefixRoutes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return err
	}

	m.mu.Lock()
	m.exactRoutes = map[string]bool{}
	for _, p := range res.ExactRoutes {
		m.exactRoutes[p] = true
	}
	m.prefixRoutes = append([]string(nil), res.PrefixRoutes...)
	m.pluginStates = append([]PluginStatus(nil), res.Plugins...)
	m.lastErr = ""
	m.mu.Unlock()
	return nil
}

func (m *Manager) ensureRunningLocked() error {
	if m.cmd != nil && m.baseURL != "" {
		return nil
	}
	if m.nodePath == "" {
		m.nodePath, m.nodeVersion = DetectNode()
	}
	if m.nodePath == "" {
		return errors.New("未检测到 Node.js（需要 >= 20），请先安装 Node.js 或在环境变量 HANDRAW_NODE 中指定路径")
	}
	if err := os.MkdirAll(m.runtimeDir, 0o755); err != nil {
		return err
	}
	scriptPath := filepath.Join(m.runtimeDir, "dsh-bridge.mjs")
	if err := os.WriteFile(scriptPath, bridgeScript, 0o644); err != nil {
		return err
	}
	var rb [24]byte
	_, _ = rand.Read(rb[:])
	secret := hex.EncodeToString(rb[:])

	cmd := exec.Command(m.nodePath, scriptPath)
	hideWindow(cmd)
	env := append([]string(nil), os.Environ()...)
	env = append(env,
		"HANDRAW_BRIDGE_SECRET="+secret,
		"HANDRAW_HOST_URL="+m.hostURL,
		"HANDRAW_HOST_TOKEN="+m.hostToken,
	)
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return fmt.Errorf("启动 Node Sidecar 失败：%w", err)
	}

	// Drain stderr in background so Node never blocks on pipe buffers.
	go func() {
		_, _ = io.Copy(io.Discard, stderr)
	}()

	readyCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "READY ") {
				readyCh <- strings.TrimPrefix(line, "READY ")
				break
			}
		}
		if err := sc.Err(); err != nil {
			errCh <- err
		}
		// Keep draining stdout.
		_, _ = io.Copy(io.Discard, stdout)
	}()

	var readyLine string
	select {
	case readyLine = <-readyCh:
	case err := <-errCh:
		_ = cmd.Process.Kill()
		return fmt.Errorf("Node Sidecar 启动异常：%w", err)
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		return errors.New("Node Sidecar 启动超时")
	}

	var ready struct {
		Port int `json:"port"`
	}
	if err := json.Unmarshal([]byte(readyLine), &ready); err != nil || ready.Port <= 0 {
		_ = cmd.Process.Kill()
		return fmt.Errorf("Node Sidecar 握手无效：%s", readyLine)
	}

	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", ready.Port))
	proxy := httputil.NewSingleHostReverseProxy(target)
	origDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		origDirector(req)
		req.Header.Set("X-Bridge-Secret", secret)
	}

	m.cmd = cmd
	m.stdin = stdin
	m.baseURL = target.String()
	m.secret = secret
	m.proxy = proxy

	// Watch process exit so we reset state if Node exits unexpectedly.
	go func(c *exec.Cmd) {
		_ = c.Wait()
		m.mu.Lock()
		if m.cmd == c {
			m.cmd = nil
			m.stdin = nil
			m.baseURL = ""
			m.proxy = nil
			m.exactRoutes = map[string]bool{}
			m.prefixRoutes = nil
			m.pluginStates = nil
		}
		m.mu.Unlock()
	}(cmd)

	return nil
}

func isProtectedHostPath(pathname string) bool {
	protected := []string{
		"/api/boot",
		"/api/events",
		"/api/settings",
		"/api/account",
		"/api/providers",
		"/api/plugins",
		"/api/host/",
		"/api/update",
		"/api/galleries",
		"/api/resources",
		"/api/works",
		"/api/mine",
		"/api/models",
		"/api/generate",
		"/api/quote",
		"/api/prompt",
		"/files/",
	}
	for _, p := range protected {
		if pathname == strings.TrimRight(p, "/") || strings.HasPrefix(pathname, p) {
			return true
		}
	}
	return false
}

// MatchRoute reports whether pathname is handled by an active DSH plugin.
func (m *Manager) MatchRoute(pathname string) bool {
	if isProtectedHostPath(pathname) {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.proxy == nil {
		return false
	}
	if m.exactRoutes[pathname] {
		return true
	}
	for _, pfx := range m.prefixRoutes {
		if pathname == pfx || strings.HasPrefix(pathname, pfx+"/") {
			return true
		}
	}
	return false
}

// ServeHTTP reverse-proxies an already-authenticated request to the Node sidecar.
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	proxy := m.proxy
	m.mu.Unlock()
	if proxy == nil {
		http.Error(w, `{"error":"DSH sidecar not running"}`, http.StatusServiceUnavailable)
		return
	}
	proxy.ServeHTTP(w, r)
}

// Stop terminates the sidecar cleanly.
func (m *Manager) Stop() {
	m.mu.Lock()
	m.stopLocked()
	m.mu.Unlock()
}

func (m *Manager) stopLocked() {
	if m.stdin != nil {
		_ = m.stdin.Close()
		m.stdin = nil
	}
	if m.cmd != nil && m.cmd.Process != nil {
		done := make(chan struct{})
		p := m.cmd.Process
		go func() {
			_, _ = p.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(1500 * time.Millisecond):
			_ = p.Kill()
		}
		m.cmd = nil
	}
	m.baseURL = ""
	m.proxy = nil
	m.exactRoutes = map[string]bool{}
	m.prefixRoutes = nil
	m.pluginStates = nil
}
