//go:build darwin

package desktop

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func macLaunchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("无法定位用户主目录")
	}
	return filepath.Join(home, "Library", "LaunchAgents", AutoStartMacLabel+".plist"), nil
}

func setAutoStartOS(enabled bool, exePath string) error {
	p, err := macLaunchAgentPath()
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
		return fmt.Errorf("创建 LaunchAgents 目录失败：%w", err)
	}
	data := []byte(renderMacLaunchAgentPlist(exePath))
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("写入开机启动配置失败：%w", err)
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return os.WriteFile(p, data, 0o644)
	}
	return nil
}
