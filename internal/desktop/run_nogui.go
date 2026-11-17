//go:build nogui

package desktop

import (
	"errors"

	"github.com/yang0/handraw-client/internal/server"
)

// Run is disabled in -tags nogui builds; callers should run `handraw web`.
func Run(string, *server.Server, string, bool, string) error {
	return errors.New("当前为无界面构建（nogui），请运行 handraw web 启动浏览器工作台")
}
