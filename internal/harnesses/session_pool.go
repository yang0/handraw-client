package harnesses

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	warmSessionIdleTTL = 8 * time.Minute
	maxWarmSessions    = 4
)

type agyStreamLine struct {
	line string
	err  error
}

type agyWarmWorker struct {
	key        string
	sessionKey string
	harnessID  string
	model      string
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	lines      chan agyStreamLine
	stderr     *limitedBuffer
	scratchDir string

	turnMu   sync.Mutex
	lastUsed time.Time
	dead     bool
}

var (
	warmPoolMu      sync.Mutex
	warmPool        = map[string]*agyWarmWorker{}
	warmReaperOnce  sync.Once
)

func startWarmReaper() {
	warmReaperOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(1 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				evictIdleWarmWorkers()
			}
		}()
	})
}

func evictIdleWarmWorkers() {
	now := time.Now()
	var stale []*agyWarmWorker
	warmPoolMu.Lock()
	for k, w := range warmPool {
		if w.dead || now.Sub(w.lastUsed) > warmSessionIdleTTL {
			stale = append(stale, w)
			delete(warmPool, k)
		}
	}
	warmPoolMu.Unlock()
	for _, w := range stale {
		w.close()
	}
}

// ResetSession closes any warm harness workers associated with sessionKey
// (e.g. when the user clears the AI chat conversation).
func ResetSession(sessionKey string) {
	sk := strings.TrimSpace(sessionKey)
	if sk == "" {
		return
	}
	var toClose []*agyWarmWorker
	warmPoolMu.Lock()
	for k, w := range warmPool {
		if w.sessionKey == sk {
			toClose = append(toClose, w)
			delete(warmPool, k)
		}
	}
	warmPoolMu.Unlock()
	for _, w := range toClose {
		w.close()
	}
}

func (w *agyWarmWorker) close() {
	if w == nil {
		return
	}
	w.dead = true
	if w.stdin != nil {
		_ = w.stdin.Close()
	}
	if w.cmd != nil && w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
		_, _ = w.cmd.Process.Wait()
	}
	if w.scratchDir != "" {
		_ = os.RemoveAll(w.scratchDir)
	}
}

func spawnAgyWarmWorker(st Status, model, workDir, key, sessionKey string) (*agyWarmWorker, error) {
	var scratchDir string
	if workDir == "" {
		if d, err := os.MkdirTemp("", "handraw-harness-warm-*"); err == nil {
			scratchDir = d
			workDir = d
		}
	}

	args, _ := BuildArgs("agy", model, st.ExtraArgs, "", "")
	cmd := exec.Command(st.ResolvedPath, args...)
	configureCommand(cmd)
	if workDir != "" {
		if info, err := os.Stat(workDir); err == nil && info.IsDir() {
			cmd.Dir = workDir
		}
	}
	cmd.Env = append(os.Environ(),
		"NO_COLOR=1",
		"FORCE_COLOR=0",
		"CLICOLOR=0",
		"PYTHONIOENCODING=utf-8",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		if scratchDir != "" {
			_ = os.RemoveAll(scratchDir)
		}
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		if scratchDir != "" {
			_ = os.RemoveAll(scratchDir)
		}
		return nil, err
	}
	stderr := &limitedBuffer{limit: 256 << 10}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		if scratchDir != "" {
			_ = os.RemoveAll(scratchDir)
		}
		return nil, err
	}

	linesCh := make(chan agyStreamLine, 64)
	go func() {
		defer close(linesCh)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64<<10), maxOutputBytes)
		for sc.Scan() {
			linesCh <- agyStreamLine{line: sc.Text()}
		}
		if scErr := sc.Err(); scErr != nil {
			linesCh <- agyStreamLine{err: scErr}
		}
		_ = cmd.Wait()
	}()

	return &agyWarmWorker{
		key:        key,
		sessionKey: sessionKey,
		harnessID:  st.ID,
		model:      model,
		cmd:        cmd,
		stdin:      stdin,
		lines:      linesCh,
		stderr:     stderr,
		scratchDir: scratchDir,
		lastUsed:   time.Now(),
	}, nil
}

func getOrCreateAgyWorker(st Status, model, workDir, sessionKey string) (*agyWarmWorker, bool, error) {
	startWarmReaper()
	key := strings.Join([]string{st.ID, st.ResolvedPath, model, strings.Join(st.ExtraArgs, "\x00"), workDir, sessionKey}, "|")

	warmPoolMu.Lock()
	if w, ok := warmPool[key]; ok && !w.dead {
		w.lastUsed = time.Now()
		warmPoolMu.Unlock()
		return w, true, nil
	}
	// Evict oldest if pool full
	var evicted *agyWarmWorker
	if len(warmPool) >= maxWarmSessions {
		var oldestKey string
		var oldestTime time.Time
		for k, w := range warmPool {
			if oldestKey == "" || w.lastUsed.Before(oldestTime) {
				oldestKey = k
				oldestTime = w.lastUsed
			}
		}
		if oldestKey != "" {
			evicted = warmPool[oldestKey]
			delete(warmPool, oldestKey)
		}
	}
	warmPoolMu.Unlock()
	if evicted != nil {
		evicted.close()
	}

	w, err := spawnAgyWarmWorker(st, model, workDir, key, sessionKey)
	if err != nil {
		return nil, false, err
	}
	warmPoolMu.Lock()
	warmPool[key] = w
	warmPoolMu.Unlock()
	return w, false, nil
}

func evictWarmWorker(w *agyWarmWorker) {
	if w == nil {
		return
	}
	warmPoolMu.Lock()
	if cur, ok := warmPool[w.key]; ok && cur == w {
		delete(warmPool, w.key)
	}
	warmPoolMu.Unlock()
	w.close()
}

func chatViaAgyWarmSession(ctx context.Context, st Status, model, workDir, prompt, sessionKey string) (ChatResult, error) {
	for attempt := 0; attempt < 2; attempt++ {
		w, reused, err := getOrCreateAgyWorker(st, model, workDir, sessionKey)
		if err != nil {
			return ChatResult{}, err
		}

		res, retryable, turnErr := runAgyWarmTurn(ctx, w, st, model, prompt, reused)
		if turnErr == nil {
			return res, nil
		}
		evictWarmWorker(w)
		if !retryable || attempt > 0 {
			return ChatResult{}, turnErr
		}
	}
	return ChatResult{}, errors.New("agy 热会话启动失败")
}

func runAgyWarmTurn(ctx context.Context, w *agyWarmWorker, st Status, model, prompt string, reused bool) (ChatResult, bool, error) {
	w.turnMu.Lock()
	defer w.turnMu.Unlock()
	if w.dead {
		return ChatResult{}, true, errors.New("warm worker closed")
	}

	payload, _ := json.Marshal(map[string]any{
		"event": "user",
		"message": map[string]any{
			"content": prompt,
		},
	})
	start := time.Now()
	if _, err := io.WriteString(w.stdin, string(payload)+"\n"); err != nil {
		return ChatResult{}, reused, fmt.Errorf("%s 写入请求失败：%v", st.Name, err)
	}

	var streamParts []string
	for {
		select {
		case <-ctx.Done():
			if ctx.Err() == context.DeadlineExceeded {
				return ChatResult{}, false, fmt.Errorf("%s 响应超时（已等待 %d 秒），可在「设置 → 本地 Harness」中调大超时或换其他模型", st.Name, clampTimeout(st.TimeoutSec))
			}
			return ChatResult{}, false, ctx.Err()
		case item, ok := <-w.lines:
			if !ok {
				errStr := strings.TrimSpace(stripANSI(w.stderr.String()))
				if errStr != "" {
					return ChatResult{}, reused, fmt.Errorf("%s 进程提前退出：%s", st.Name, truncateErr(errStr))
				}
				return ChatResult{}, reused, fmt.Errorf("%s 会话意外断开", st.Name)
			}
			if item.err != nil {
				return ChatResult{}, false, fmt.Errorf("%s 读取输出失败：%v", st.Name, item.err)
			}
			ln := strings.TrimSpace(stripANSI(item.line))
			if !strings.HasPrefix(ln, "{") {
				continue
			}
			var obj map[string]any
			if json.Unmarshal([]byte(ln), &obj) != nil {
				continue
			}
			ev := strings.ToLower(extractStringField(obj, "event"))
			switch ev {
			case "step_update":
				if su, okMap := obj["step_update"].(map[string]any); okMap {
					if strings.EqualFold(extractStringField(su, "step_type"), "agent_response") {
						if d, okStr := su["text_delta"].(string); okStr && d != "" {
							streamParts = append(streamParts, d)
						}
					}
				}
			case "result":
				w.lastUsed = time.Now()
				elapsed := time.Since(start).Milliseconds()
				if resObj, okMap := obj["result"].(map[string]any); okMap {
					if strings.EqualFold(extractStringField(resObj, "status"), "error") {
						msg := firstNonEmpty(extractStringField(resObj, "error", "message"), "CLI 返回错误")
						return ChatResult{}, false, fmt.Errorf("%s 返回错误：%s", st.Name, msg)
					}
					text := strings.TrimSpace(extractStringField(resObj, "response", "result", "text", "content"))
					if text == "" {
						text = strings.TrimSpace(strings.Join(streamParts, ""))
					}
					if text == "" {
						return ChatResult{}, false, fmt.Errorf("%s 返回内容为空", st.Name)
					}
					return ChatResult{
						Text:        text,
						HarnessID:   st.ID,
						Driver:      st.Driver,
						Model:       model,
						ElapsedMs:   elapsed,
						WarmSession: reused,
					}, false, nil
				}
			}
		}
	}
}
