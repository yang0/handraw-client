//go:build !windows && !darwin

package desktop

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func linuxAutostartPath() (string, error) {
	cfg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if cfg == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", errors.New("无法定位用户配置目录")
		}
		cfg = filepath.Join(home, ".config")
	}
	return filepath.Join(cfg, "autostart", "handraw-client.desktop"), nil
}

func setAutoStartOS(enabled bool, exePath string) error {
	p, err := linuxAutostartPath()
	if err != nil {
		return err
	}
	if !enabled {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("关闭开机自启失败：%w", err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("创建 autostart 目录失败：%w", err)
	}
	return os.WriteFile(p, []byte(renderLinuxDesktopEntry(exePath)), 0o644)
}
