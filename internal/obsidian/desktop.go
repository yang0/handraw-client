package obsidian

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yang0/handraw-client/internal/netutil"
)

const (
	maxProxyBodyBytes = 32 << 20 // 32 MiB for image upload/download
	maxSpawnOutBytes  = 4 << 20  // 4 MiB stdout/stderr cap
)

// ProxyRequest mirrors Obsidian's RequestUrlParam.
type ProxyRequest struct {
	URL         string            `json:"url"`
	Method      string            `json:"method,omitempty"`
	ContentType string            `json:"contentType,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	BodyText    string            `json:"bodyText,omitempty"`
	BodyBase64  string            `json:"bodyBase64,omitempty"`
	TimeoutMs   int               `json:"timeoutMs,omitempty"`
}

// ProxyResponse mirrors Obsidian's RequestUrlResponse.
type ProxyResponse struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
}

func isPrivateOrLoopbackIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

func isAllowedLocalPort(port int, allowed []int) bool {
	for _, p := range allowed {
		if p == port {
			return true
		}
	}
	return false
}

// ProxyHTTPRequest executes an outbound HTTP request on behalf of an Obsidian plugin's requestUrl().
// It blocks SSRF against private/loopback addresses unless the user explicitly allowed that localhost port.
func ProxyHTTPRequest(ctx context.Context, req ProxyRequest, allowedLocalPorts []int) (ProxyResponse, error) {
	rawURL := strings.TrimSpace(req.URL)
	if rawURL == "" {
		return ProxyResponse{}, errors.New("缺少请求 URL")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ProxyResponse{}, errors.New("仅支持 http:// 或 https:// 请求")
	}
	host := strings.ToLower(strings.TrimSpace(u.Hostname()))
	if host == "" {
		return ProxyResponse{}, errors.New("无效的请求主机名")
	}
	portNum := 80
	if u.Scheme == "https" {
		portNum = 443
	}
	if pStr := u.Port(); pStr != "" {
		if p, pErr := strconv.Atoi(pStr); pErr == nil {
			portNum = p
		}
	}

	isLoopbackHost := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if isLoopbackHost {
		if !isAllowedLocalPort(portNum, allowedLocalPorts) {
			return ProxyResponse{}, fmt.Errorf("已拦截对本机端口 %d 的访问（如需访问本地服务如 PicGo，请在插件卡片的「本地端口白名单」中放行端口 %d）", portNum, portNum)
		}
	}

	// Custom DialContext enforces SSRF check after DNS resolution while still
	// honoring OS system proxy settings and preferring IPv4 for direct dials (#181).
	dialer := &net.Dialer{Timeout: 12 * time.Second, KeepAlive: 30 * time.Second}
	var approvedProxies sync.Map
	transport := netutil.NewTransport()
	transport.Proxy = func(r *http.Request) (*url.URL, error) {
		pURL, err := netutil.SystemProxyFunc(r)
		if err == nil && pURL != nil {
			if ep := netutil.ProxyEndpointAddr(pURL); ep != "" {
				approvedProxies.Store(ep, struct{}{})
			}
		}
		return pURL, err
	}
	transport.DialContext = func(dctx context.Context, network, addr string) (net.Conn, error) {
		if _, ok := approvedProxies.Load(strings.ToLower(strings.TrimSpace(addr))); ok {
			return dialer.DialContext(dctx, network, addr)
		}
		h, pStr, splitErr := net.SplitHostPort(addr)
		if splitErr != nil {
			return nil, splitErr
		}
		pVal, _ := strconv.Atoi(pStr)
		ips, lErr := net.DefaultResolver.LookupIPAddr(dctx, h)
		if lErr != nil || len(ips) == 0 {
			return dialer.DialContext(dctx, network, addr)
		}
		var chosen net.IP
		for _, ipAddr := range netutil.OrderIPsPreferIPv4(ips) {
			if isPrivateOrLoopbackIP(ipAddr.IP) {
				if ipAddr.IP.IsLoopback() && isAllowedLocalPort(pVal, allowedLocalPorts) {
					chosen = ipAddr.IP
					break
				}
				return nil, fmt.Errorf("安全策略已拦截对内网地址 %s 的请求", ipAddr.IP.String())
			}
			if chosen == nil {
				chosen = ipAddr.IP
			}
		}
		if chosen == nil {
			return nil, errors.New("无法解析目标地址")
		}
		return dialer.DialContext(dctx, network, net.JoinHostPort(chosen.String(), pStr))
	}

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = "GET"
	}

	var bodyReader io.Reader
	if req.BodyBase64 != "" {
		decoded, dErr := base64.StdEncoding.DecodeString(req.BodyBase64)
		if dErr != nil {
			return ProxyResponse{}, fmt.Errorf("请求体 base64 解码失败：%w", dErr)
		}
		if len(decoded) > maxProxyBodyBytes {
			return ProxyResponse{}, errors.New("请求体超过 32MB 限制")
		}
		bodyReader = bytes.NewReader(decoded)
	} else if req.BodyText != "" {
		if len(req.BodyText) > maxProxyBodyBytes {
			return ProxyResponse{}, errors.New("请求体超过 32MB 限制")
		}
		bodyReader = strings.NewReader(req.BodyText)
	}

	timeout := 30 * time.Second
	if req.TimeoutMs > 0 {
		t := time.Duration(req.TimeoutMs) * time.Millisecond
		if t > 120*time.Second {
			t = 120 * time.Second
		}
		if t >= time.Second {
			timeout = t
		}
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, rawURL, bodyReader)
	if err != nil {
		return ProxyResponse{}, err
	}
	hasCT := false
	hasUA := false
	for k, v := range req.Headers {
		kl := strings.ToLower(strings.TrimSpace(k))
		if kl == "" || kl == "host" || kl == "content-length" {
			continue
		}
		if kl == "content-type" {
			hasCT = true
		}
		if kl == "user-agent" {
			hasUA = true
		}
		httpReq.Header.Set(k, v)
	}
	if !hasCT && strings.TrimSpace(req.ContentType) != "" {
		httpReq.Header.Set("Content-Type", req.ContentType)
	}
	if !hasUA {
		httpReq.Header.Set("User-Agent", "Mozilla/5.0 (compatible; HandrawObsidianCompat/1.0)")
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("重定向次数过多")
			}
			rh := strings.ToLower(r.URL.Hostname())
			if rh == "localhost" || rh == "127.0.0.1" || rh == "::1" {
				rp := 80
				if r.URL.Scheme == "https" {
					rp = 443
				}
				if ps := r.URL.Port(); ps != "" {
					if v, perr := strconv.Atoi(ps); perr == nil {
						rp = v
					}
				}
				if !isAllowedLocalPort(rp, allowedLocalPorts) {
					return fmt.Errorf("安全策略已拦截重定向至本机端口 %d", rp)
				}
			} else if ip := net.ParseIP(rh); ip != nil && isPrivateOrLoopbackIP(ip) {
				return fmt.Errorf("安全策略已拦截重定向至内网地址 %s", ip.String())
			}
			return nil
		},
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return ProxyResponse{}, err
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxProxyBodyBytes))
	if err != nil {
		return ProxyResponse{}, err
	}
	hdrs := make(map[string]string, len(resp.Header))
	for k, vals := range resp.Header {
		hdrs[strings.ToLower(k)] = strings.Join(vals, ", ")
	}
	return ProxyResponse{
		Status:     resp.StatusCode,
		Headers:    hdrs,
		BodyBase64: base64.StdEncoding.EncodeToString(respBytes),
	}, nil
}

// DesktopEnvInfo exposes safe OS environment metadata to the Obsidian shim.
type DesktopEnvInfo struct {
	Platform         string            `json:"platform"` // win32 | darwin | linux
	TmpDir           string            `json:"tmpDir"`
	HomeDir          string            `json:"homeDir"`
	PathSep          string            `json:"pathSep"`
	Delimiter        string            `json:"delimiter"`
	PathEnv          string            `json:"pathEnv"`
	KnownExecutables map[string]string `json:"knownExecutables,omitempty"`
}

func GetDesktopEnv() DesktopEnvInfo {
	plat := runtime.GOOS
	if plat == "windows" {
		plat = "win32"
	}
	home, _ := os.UserHomeDir()
	known := map[string]string{}
	for _, bin := range []string{"node", "npm", "npx", "wechatsync", "picgo", "python", "python3", "git"} {
		if p, err := exec.LookPath(bin); err == nil && p != "" {
			known[bin] = p
		}
	}
	return DesktopEnvInfo{
		Platform:         plat,
		TmpDir:           os.TempDir(),
		HomeDir:          home,
		PathSep:          string(os.PathSeparator),
		Delimiter:        string(os.PathListSeparator),
		PathEnv:          os.Getenv("PATH"),
		KnownExecutables: known,
	}
}

// SpawnRequest executes a local binary for a user-trusted desktop plugin (shell: false).
type SpawnRequest struct {
	Executable string            `json:"executable"`
	Args       []string          `json:"args,omitempty"`
	Cwd        string            `json:"cwd,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	TimeoutMs  int               `json:"timeoutMs,omitempty"`
}

type SpawnResponse struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Error    string `json:"error,omitempty"`
}

type cappedBuffer struct {
	buf bytes.Buffer
	max int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	rem := c.max - c.buf.Len()
	if rem > 0 {
		if len(p) > rem {
			c.buf.Write(p[:rem])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}

func SpawnProcess(ctx context.Context, req SpawnRequest) (SpawnResponse, error) {
	exe := strings.TrimSpace(req.Executable)
	if exe == "" {
		return SpawnResponse{}, errors.New("缺少可执行文件路径")
	}
	timeout := 180 * time.Second
	if req.TimeoutMs > 0 {
		t := time.Duration(req.TimeoutMs) * time.Millisecond
		if t > 5*time.Minute {
			t = 5 * time.Minute
		}
		if t >= time.Second {
			timeout = t
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, exe, req.Args...)
	hideWindow(cmd)
	if strings.TrimSpace(req.Cwd) != "" {
		cmd.Dir = req.Cwd
	}
	env := os.Environ()
	for k, v := range req.Env {
		if strings.TrimSpace(k) == "" {
			continue
		}
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	var outBuf = &cappedBuffer{max: maxSpawnOutBytes}
	var errBuf = &cappedBuffer{max: maxSpawnOutBytes}
	cmd.Stdout = outBuf
	cmd.Stderr = errBuf

	err := cmd.Run()
	exitCode := 0
	errMsg := ""
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
			errMsg = err.Error()
		}
	}
	return SpawnResponse{
		ExitCode: exitCode,
		Stdout:   outBuf.buf.String(),
		Stderr:   errBuf.buf.String(),
		Error:    errMsg,
	}, nil
}

// DesktopFSRequest runs controlled node:fs / node:fs/promises ops for trusted desktop plugins.
type DesktopFSRequest struct {
	Op         string `json:"op"` // exists | stat | access | readFile | writeFile | mkdir | mkdtemp | rm | readdir | copyFile
	Path       string `json:"path"`
	DestPath   string `json:"destPath,omitempty"`
	DataBase64 string `json:"dataBase64,omitempty"`
	DataText   string `json:"dataText,omitempty"`
	Recursive  bool   `json:"recursive,omitempty"`
	Force      bool   `json:"force,omitempty"`
}

func ExecDesktopFS(req DesktopFSRequest) (map[string]any, error) {
	p := strings.TrimSpace(req.Path)
	if p == "" {
		return nil, errors.New("缺少路径参数")
	}
	switch req.Op {
	case "exists", "access":
		_, err := os.Stat(p)
		return map[string]any{"exists": err == nil}, nil
	case "stat":
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"isFile": !info.IsDir(),
			"isDir":  info.IsDir(),
			"size":   info.Size(),
			"mtime":  info.ModTime().UnixMilli(),
		}, nil
	case "realpath":
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			// Only fall back to Abs when the path actually exists on disk (#134).
			if _, stErr := os.Stat(p); stErr == nil {
				if abs, aErr := filepath.Abs(p); aErr == nil {
					return map[string]any{"path": abs}, nil
				}
			}
			return nil, err
		}
		return map[string]any{"path": real}, nil
	case "readFile":
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if info.Size() > maxProxyBodyBytes {
			return nil, errors.New("文件超过 32MB 限制")
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"base64": base64.StdEncoding.EncodeToString(b),
			"size":   len(b),
		}, nil
	case "writeFile":
		var data []byte
		if req.DataBase64 != "" {
			var err error
			data, err = base64.StdEncoding.DecodeString(req.DataBase64)
			if err != nil {
				return nil, err
			}
		} else {
			data = []byte(req.DataText)
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "size": len(data)}, nil
	case "mkdir":
		if req.Recursive {
			if err := os.MkdirAll(p, 0o755); err != nil {
				return nil, err
			}
		} else {
			if err := os.Mkdir(p, 0o755); err != nil {
				return nil, err
			}
		}
		return map[string]any{"ok": true}, nil
	case "mkdtemp":
		// p is prefix like /tmp/article-sync-
		dir := filepath.Dir(p)
		prefix := filepath.Base(p)
		if dir == "" || dir == "." {
			dir = os.TempDir()
		}
		created, err := os.MkdirTemp(dir, prefix+"*")
		if err != nil {
			return nil, err
		}
		return map[string]any{"path": created}, nil
	case "rm":
		// Safety guard: never allow removing filesystem roots or user home directly.
		clean := filepath.Clean(p)
		home, _ := os.UserHomeDir()
		if len(clean) <= 3 || samePath(clean, home) || samePath(clean, os.TempDir()) {
			return nil, errors.New("安全拦截：拒绝删除根目录或系统主目录")
		}
		var err error
		if req.Recursive {
			err = os.RemoveAll(clean)
		} else {
			err = os.Remove(clean)
		}
		if err != nil && (!req.Force || !os.IsNotExist(err)) {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "readdir":
		entries, err := os.ReadDir(p)
		if err != nil {
			return nil, err
		}
		items := make([]map[string]any, 0, len(entries))
		for _, e := range entries {
			items = append(items, map[string]any{
				"name":  e.Name(),
				"isDir": e.IsDir(),
			})
		}
		return map[string]any{"entries": items}, nil
	case "copyFile":
		dst := strings.TrimSpace(req.DestPath)
		if dst == "" {
			return nil, errors.New("缺少目标路径")
		}
		if err := copyFile(p, dst); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	default:
		return nil, fmt.Errorf("不支持的文件系统操作：%s", req.Op)
	}
}
