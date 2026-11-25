# 手绘风插件开发指南：调用画廊与生图能力

手绘风桌面端支持两类第三方插件：

- **L1 原生 Handraw 插件**：纯前端目录（`package.json` 含 `handraw` 字段），运行在沙箱 `iframe` 中，通过 `postMessage` 调用宿主白名单能力。
- **L2 DSH 兼容插件**：支持自带前端与 Node 后端服务，宿主自动注入 `window.handraw`（前端）与 `ctx.get('handraw')`（后端）。

两类插件共用同一套**画廊目录契约**，覆盖：

| `kind` | 说明 |
| --- | --- |
| `styles` | 官方 + 用户自建画风 |
| `layouts` | 官方 + 用户自建图型 |
| `colors` | 主题色 |
| `tones` | 影调 |
| `assets` | 用户「自建图库」及本地导入素材（含自定义分类） |
| `characters` / `props` / `scenes` | 资源包内置角色、道具、场景 |
| 扩展画廊（如 `ruic-poses`、`ruic-costumes` 等） | 本地安装的外部画廊包或其他插件注册的画廊 |

---

## 1. L1 原生插件调用方式

### 1.1 在 `package.json` 声明权限

```json
{
  "name": "my-gallery-plugin",
  "version": "0.1.0",
  "handraw": {
    "name": "我的画廊插件",
    "permissions": ["galleries:read", "galleries:register", "models:image"],
    "page": { "file": "index.html", "title": "我的画廊插件" }
  }
}
```

常用权限：
- `galleries:read`：读取全部画廊列表、条目、图片与缓存落地
- `galleries:register`：注册/注销插件自己的扩展画廊
- `models:text` / `models:vision` / `models:image`：调用宿主配置的文字、视觉、生图模型

### 1.2 封装 `callHost` 并调用画廊接口

```js
let seq = 0;
function callHost(action, args = {}) {
  return new Promise((resolve, reject) => {
    const callId = `c_${++seq}`;
    function onMsg(ev) {
      const m = ev.data;
      if (!m || m.kind !== "handraw-plugin-reply" || m.callId !== callId) return;
      window.removeEventListener("message", onMsg);
      if (m.ok) resolve(m.result);
      else reject(new Error(m.error || "宿主调用失败"));
    }
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ kind: "handraw-plugin-call", callId, action, args }, "*");
  });
}

// 1) 获取全部画廊（含 styles / layouts / colors / tones / assets / 扩展画廊）
const { galleries } = await callHost("galleries.list");

// 2) 查询某个画廊的条目（支持 q / category / source / series / limit / offset）
const { items, total } = await callHost("galleries.items", {
  kind: "assets",      // 或 "styles" / "ruic-poses" 等
  q: "橘猫",
  category: "character",
  limit: 20,
  offset: 0,
});

// 3) 获取单条详情
const { item } = await callHost("galleries.item", { kind: "styles", id: "FA-013" });

// 4) 获取图片 dataUrl（沙箱 iframe 中可直接赋值给 <img src>）
const img = await callHost("galleries.image", {
  kind: "assets",
  id: items[0].id,
  size: "thumb",       // "thumb" | "full"，默认 "full"
  variant: "",         // 多角度图库（如姿势）可传角度 key
});
document.querySelector("img").src = img.dataUrl;

// 5) 预缓存远程/按需画廊的参考图（不暴露宿主机绝对路径）
await callHost("galleries.materialize", {
  kind: "ruic-poses",
  id: "POSE-01",
  variant: "front",
});

// 6) 在生图中直接引用画廊条目（支持画风、自建图库、扩展姿势等）
await callHost("models.generate", {
  galleryRefs: [
    { kind: "styles", id: "FA-013" },
    { kind: "assets", id: items[0].id },
  ],
  input: { theme: "雨夜书店窗边打盹的橘猫" },
});

// 7) 注册与注销插件自己的扩展画廊（需 galleries:register 权限）
await callHost("galleries.register", {
  id: "my-stickers",
  name: "我的贴纸库",
  promptRole: "sticker",
  supportsRefImage: true,
  items: [
    { id: "ST-01", name: "暖灯贴纸", category: "warm", traits: "手绘暖黄吊灯", image: "assets/st01.png" },
  ],
});
await callHost("galleries.unregister", { kind: "my-stickers" });
```

---

## 2. L2 DSH 兼容插件调用方式

### 前端界面（`dsh-host.html` 自动注入）

```js
const g = window.handraw.galleries; // 或 ctx.handraw.galleries

const list = await g.list();
const { items } = await g.items("assets", { q: "角色", limit: 20 });
const item = await g.item("styles", "FA-013");

// 可直接用于 <img src>（已自动附带本地鉴权 token，支持 variant / size）
const url = g.imageUrl("assets", items[0].id, { size: "thumb" });

// 或直接获取 dataUrl / 触发本地缓存落地
const dataUrl = await g.imageDataUrl("ruic-poses", "POSE-01", { variant: "front" });
const mat = await g.materialize("ruic-poses", "POSE-01", "front");
```

### 后端服务（`dsh-bridge.mjs` 自动注入）

```js
const hr = ctx.get("handraw");

const list = await hr.galleries.list();
const { items } = await hr.galleries.items("assets", { category: "character" });
const item = await hr.galleries.item("assets", items[0].id);

// 读取图片二进制（支持 variant / size）
const { bytes, contentType } = await hr.galleries.imageBytes("assets", items[0].id, { size: "full" });
const mat = await hr.galleries.materialize("ruic-poses", "POSE-01", "front");

// 注册与注销当前插件拥有的画廊
await hr.galleries.register({ id: "my-poses", name: "自定义姿势", items: [] });
await hr.galleries.unregister("my-poses");
```

---

## 3. 扩展图库插件市场（`handraw-galleries`）

除功能型插件在运行时动态注册画廊外，纯素材/参考图类图库可直接打包为**扩展图库插件**，由用户在 **画廊 → `🧩 扩展图库`** 中按需选装（不随启动自动安装，索引与图片仅缓存在本机）：

- **官方图库插件市场仓库（双镜像同步）**：
  - Gitee 国内镜像（默认优先）：<https://gitee.com/yang02010/handraw-galleries>（订阅索引：`https://gitee.com/yang02010/handraw-galleries/raw/main/index.json`）
  - GitHub 官方原仓：<https://github.com/yang0/handraw-galleries>（订阅索引：`https://raw.githubusercontent.com/yang0/handraw-galleries/main/index.json`）
- **统一标准接口（Format 1）**：所有收录图库（包括已改造迁移至 [handraw-gallery-ruic-poseatlas](https://github.com/yang0/handraw-gallery-ruic-poseatlas) / [Gitee 镜像](https://gitee.com/yang02010/handraw-gallery-ruic-poseatlas) 的 `ruic-poses`、`ruic-costumes`、`ruic-faces` 三套开源图鉴）均采用统一标准格式，无需客户端硬编码适配：
  1. `json`：标准 Format 1 声明式 `gallery.json`，原生支持单图与 `variants[]` 多视角变体，并支持通过 `imageMirrors` 声明国内/国际多图床自动容错切换。
  2. `zip`：离线图库压缩包（内含 `gallery.json` 与相对路径图片，解压即用）。
- **社区 PR 投稿与自定义扩展**：
  - 任何符合 [Format 1 规范](https://github.com/yang0/handraw-galleries/blob/main/docs/spec.md) 的图库均可向 `yang0/handraw-galleries` 提交 PR（CI 自动运行 `node scripts/validate.mjs --check-remote` 校验）；
  - 客户端也支持订阅第三方 Format 1 `index.json` 市场源，或通过 `🔗 链接直装` 直接输入 `.json` / `.zip` 链接安装。

---

## 4. 四大官方扩展市场仓库与商业化预留协议（#127）

手绘风桌面端左侧「扩展与插件中心」统一管理以下 4 套官方市场，均内置 **Gitee 国内镜像（默认优先）+ GitHub 原仓（自动回退）** 双镜像，并支持社区通过 PR 投稿：

| 生态频道 | GitHub 官方原仓 | Gitee 国内镜像（默认优先） | 规范类型 |
| --- | --- | --- | --- |
| 功能插件（Handraw / DSH） | <https://github.com/yang0/handraw-plugins> | <https://gitee.com/yang02010/handraw-plugins> | DSH Format 1 |
| 扩展图库 | <https://github.com/yang0/handraw-galleries> | <https://gitee.com/yang02010/handraw-galleries> | Gallery Format 1 |
| AI Skills | <https://github.com/yang0/handraw-skills> | <https://gitee.com/yang02010/handraw-skills> | Skills Format 1 |
| 写作插件（Obsidian 兼容） | <https://github.com/yang0/handraw-obsidian-plugins> | <https://gitee.com/yang02010/handraw-obsidian-plugins> | Obsidian Format 1 |

### 可选商业化扩展字段（向后兼容，免费项可省略）
4 套市场的条目均支持预留字段 `pricing`（`model`: `free` / `pro` / `credits` / `paid`、`credits`、`priceCents`）与 `delivery`（`auth`: `none` / `handraw-account`），供后续接入会员权益、积分兑换与创作者分成市场使用。

