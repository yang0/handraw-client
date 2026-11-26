//go:build windows

package desktop

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

const windowsRunKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`

func setAutoStartOS(enabled bool, exePath string) error {
	if !enabled {
		k, err := registry.OpenKey(registry.CURRENT_USER, windowsRunKeyPath, registry.SET_VALUE)
		if err != nil {
			if errors.Is(err, registry.ErrNotExist) {
				return nil
			}
			return fmt.Errorf("打开开机启动注册表项失败：%w", err)
		}
		defer k.Close()
		if err := k.DeleteValue(AutoStartRegistryValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return fmt.Errorf("关闭开机自启失败：%w", err)
		}
		return nil
	}

	k, _, err := registry.CreateKey(registry.CURRENT_USER, windowsRunKeyPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("写入开机启动注册表项失败：%w", err)
	}
	defer k.Close()
	if err := k.SetStringValue(AutoStartRegistryValue, formatWindowsRunCommand(exePath)); err != nil {
		return fmt.Errorf("开启开机自启失败：%w", err)
	}
	return nil
}
