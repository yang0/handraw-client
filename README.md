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

## 隐私与匿名使用统计

桌面端遵循本地优先原则，作品、提示词与 API Key 均保存在本机。为帮助改进版本质量与了解更新进度，客户端默认开启**匿名使用统计**（发送至第一方接口 `https://handraw-style.com/api/analytics/events`）：

- **仅上报**：本地随机生成的匿名设备 ID（`dc_...`，不含硬件指纹）、版本号、操作系统/架构、功能模块访问频次、生图通道类型（官网通道 / 自带 Key）与成败状态、检查/应用更新事件。
- **绝不上报**：提示词原文、生成图片、参考图、本地文件路径、工作目录、API Key、邮箱或任何个人敏感内容（前后端双重白名单与敏感键过滤）。
- **随时关闭**：可在客户端「设置 → 偏好设置」取消勾选 **「发送匿名使用统计」**，关闭后客户端不再发送任何统计请求。

## 开发流程

先建 Issue，再开发。详见 [AGENTS.md](AGENTS.md)。
