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

## 已知限制

- macOS 包没有 Apple 开发者签名和公证，用户第一次打开需要在「系统设置 → 隐私与安全性」里允许，或右键「打开」。上架前需要 Apple 开发者账号。
- Windows 包没有代码签名证书，SmartScreen 可能提示“未知发布者”。
- Gitee 镜像同步还没有接入流水线。
