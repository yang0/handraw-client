# 发布客户端

对应 #43。推送 `v*` 标签后，`.github/workflows/release.yml` 会构建 Windows（amd64、arm64）和 macOS（arm64、amd64）安装包，生成 `SHA256SUMS` 和 ed25519 签名 `SHA256SUMS.sig`，发布到 GitHub Releases。客户端的自动更新只接受签名校验通过的版本。

## 第一次：准备签名密钥（只做一次）

```sh
go run -tags nogui ./tools/signsums keygen
```

会输出两行：

- **公钥**：放到仓库 Settings → Secrets and variables → Actions → **Variables**，名称 `HANDRAW_RELEASE_PUBKEY`。公钥会在构建时写进客户端。
- **私钥种子**：放到同一页的 **Secrets**，名称 `HANDRAW_RELEASE_SIGNING_KEY`。另外离线保存一份（例如密码管理器）。私钥丢失后只能换新密钥，已安装的旧版本将无法自动更新到用新密钥签名的版本。

两项缺任何一项，流水线会在构建前停止，不会发布未签名的版本。

## 每次发版

```sh
git tag -a v0.5.0 -m "手绘风 v0.5.0：……更新说明……"
git push origin v0.5.0
```

标签说明会作为 Release 的说明。构建完成后在 Releases 页面检查 6 个文件：4 个安装包、`SHA256SUMS`、`SHA256SUMS.sig`。

签名内容是 `handraw release <版本号>` 加 `SHA256SUMS`，一个签名只对一个版本有效，旧版本的签名不能冒充新版本。

## 只先发 Windows

某个平台还没验证完时，可以先发布 Windows，macOS 之后补上：

```sh
gh variable set HANDRAW_RELEASE_PLATFORMS --body windows   # 本次只发 Windows
git tag -a v0.6.0 -m "……"
git push origin v0.6.0
gh variable delete HANDRAW_RELEASE_PLATFORMS              # 流水线启动后恢复默认
```

也可以在 Actions 页面手动运行 Release，`platforms` 选 `windows`。

macOS 验证完成后，手动运行 Release，`tag` 填同一个版本、`platforms` 选 `all`：会把 macOS 安装包补进同一个 Release，并重新生成签名后的 `SHA256SUMS`。

客户端只在 Release 里有本平台安装包和签名文件时才提示更新（v0.6.0 起）。v0.5.0 及更早的 macOS 客户端会先看到新版本，点更新时提示“新版本没有 handraw-darwin-… 安装包”，补齐 macOS 安装包后即可正常更新。

## 备用更新源自动同步（Gitee & 官网镜像）

客户端按顺序尝试 3 个更新源：GitHub Releases → Gitee Releases → `https://handraw-style.com/static/client/latest.json`。

- **官网镜像（已自动生效）**：生产服务器上的 `handraw-sync-client.timer` 每 30 分钟自动从 GitHub Releases 同步最新签名版本到 `https://handraw-style.com/static/client/latest.json`（校验 SHA256 后原子切换）。
- **Gitee 代码仓库自动同步（与 `handraw-style` 一致，已配置 `GITEE_RSA_PRIVATE_KEY`）**：
  - 每次推送到 GitHub `main` 分支或 `v*` 标签，`.github/workflows/mirror-gitee.yml` 会通过 SSH 自动同步代码与标签到 `yang02010/handraw-client`。
- **Gitee Releases 安装包自动同步（配置 `GITEE_TOKEN` 后自动生效）**：
  1. 在 Gitee「设置 → 私人令牌」创建含 `projects` 权限的令牌；
  2. 写入 GitHub 仓库 Secret：`gh secret set GITEE_TOKEN --repo yang0/handraw-client`；
  3. 之后每次发版或重跑 `release.yml` 时，会自动把全部签名安装包与 `SHA256SUMS` / `SHA256SUMS.sig` 同步到 Gitee Releases（失败不影响 GitHub 发布）。也可以手动运行 `Sync to Gitee` 并填入 `release_tag` 补同步历史版本。

## 已知限制

- macOS 包没有 Apple 开发者签名和公证，用户第一次打开需要在「系统设置 → 隐私与安全性」里允许，或右键「打开」。上架前需要 Apple 开发者账号。
- Windows 包没有代码签名证书，SmartScreen 可能提示“未知发布者”。
