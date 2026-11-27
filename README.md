<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/brand-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/brand-lockup-light.svg">
    <img src="docs/brand/brand-lockup-light.svg" alt="手绘风 Handraw" width="320">
  </picture>
</p>

# 手绘风生图工作台 · handraw-client

Windows / macOS 桌面客户端，连接 [手绘风 Skill](https://github.com/yang0/handraw-style) 的本地资源库与 [handraw-style.com](https://handraw-style.com) 的账号、计费和社区。

- 产品文档：[docs/product.md](docs/product.md)
- 发布说明：[docs/release.md](docs/release.md)
- 变更日志：[CHANGELOG.md](CHANGELOG.md)
- 竞品调研：[docs/research.md](docs/research.md)

## 下载与安装

支持以下任意镜像下载（所有正式包均附带 ed25519 签名 `SHA256SUMS.sig`，内置自动更新优先使用国内 Gitee 源并自动回退官网镜像 / GitHub）：

- **Gitee Releases（国内推荐）**：https://gitee.com/yang02010/handraw-client/releases
- **官网镜像直链**：https://handraw-style.com/static/client/latest.json
- **GitHub Releases**：https://github.com/yang0/handraw-client/releases

### 系统要求与首次打开说明
- **Windows**：Windows 10 / 11（`amd64` 或 `arm64`，系统内置 WebView2）。下载单文件 `handraw-windows-<arch>.exe` 双击即可运行。因暂未购买商业代码签名证书，首次启动如遇 SmartScreen 提示，点「更多信息 → 仍要运行」即可。
- **macOS**：macOS 12+（Apple Silicon `arm64` 或 Intel `amd64`）。解压 `handraw-darwin-<arch>.zip` 并将「手绘风.app」拖入「应用程序」。因暂未做 Apple 开发者公证，首次打开请右键「打开」，或在「系统设置 → 隐私与安全性」中点击「仍要打开」。
- **Linux（仅源码 `nogui` 模式）**：暂不发布预编译安装包，不支持自动更新；如需使用可执行 `go build -tags nogui ./cmd/handraw` 后以 `handraw web` 模式运行。

## 隐私与匿名使用统计

桌面端遵循本地优先原则，作品、提示词与 API Key 均保存在本机。为帮助改进版本质量与了解更新进度，客户端默认开启**匿名使用统计**（发送至第一方接口 `https://handraw-style.com/api/analytics/events`）：

- **仅上报**：本地随机生成的匿名设备 ID（`dc_...`，不含硬件指纹）、版本号、操作系统/架构、功能模块访问频次、生图通道类型（官网通道 / 自带 Key）与成败状态、检查/应用更新事件，以及**严格脱敏后的运行时异常与崩溃诊断信息**（已自动抹除用户名路径、密钥、邮箱/手机号与 URL 参数，按指纹去重并限流）。
- **绝不上报**：提示词原文、生成图片、参考图、本地文件路径、工作目录、API Key、邮箱或任何个人敏感内容（前后端双重白名单与敏感键过滤）。
- **随时关闭**：可在客户端「设置 → 偏好设置」取消勾选 **「发送匿名使用统计」**，关闭后客户端不再发送任何统计请求。

## 开源协议

本项目基于 **MIT License (with Attribution Requirement)** 开源，详见 [LICENSE](LICENSE)。

- 允许自由使用、修改、分发与商用。
- **署名要求**：基于本项目进行分发、修改或二次开发时，需保留版权声明，并在界面、文档、仓库或产品介绍的明显位置保留 **「手绘风 Handraw」图标、名称、原作者署名（yang0）及原仓库地址链接**（`https://github.com/yang0/handraw-client`）。

## 开发流程

先建 Issue，再开发。详见 [AGENTS.md](AGENTS.md)。
