# 手绘风（Handraw）站点公开 API 接口参考（客户端 / 插件开发）

> **在线文档**：`https://handraw-style.com/api-docs`（结构化 JSON：`GET https://handraw-style.com/api/v1/docs`）  
> **配套权威文档**：与官网 `handraw-web/docs/client-api.md` 保持一致（#169 / handraw-web#549）。  
> **Base URL**：`https://handraw-style.com`

---

## 一、接入约定

### 1. 请求头
| Header | 要求 | 示例 |
| --- | --- | --- |
| `Accept` | 推荐 | `application/json` |
| `User-Agent` | **必填** | `handraw-client/0.6.0`（避免默认脚本 UA） |
| `X-Handraw-Client` | 推荐 | `desktop/0.6.0` |
| `Authorization` | 鉴权接口必填 | `Bearer hwt_<token>`（公开只读接口建议不带，便于 CDN 缓存） |

### 2. 错误响应格式
```json
{
  "ok": false,
  "error": "面向用户的中文错误提示",
  "code": "machine_readable_error_code",
  "requestId": "32位请求追踪ID"
}
```
关键状态码：`401 login_required`、`402 insufficient_cash / insufficient_points / verification_required`、`403 token_scope_denied / asset_locked / site_model_required`、`409 conflict`、`413 payload_too_large`、`429 rate_limited`。

### 3. Scope 权限
- **任意有效令牌**：`/api/auth/me`、`/api/auth/tokens`（仅自身）、`/api/auth/tokens/{tid}/revoke`（仅自身）、`/api/economy`、`/api/me/level`、`/api/me/creator-earnings`、`/api/v1/resources/ranking`、`/api/v1/community/resources`、`/api/v1/docs`
- **`studio`**：生图报价/提交/轮询、`/api/ai/chat`、AI 策划、积分解锁（含 `/api/v1/community/resources/{code}/unlock`）、云端配方、作品/灵感浏览与个人剪藏
- **`library`**：自定义画风/图型双向同步、私密封面上传、私人参考图库与自定义分类同步、资源下载
- **`publish`**：作品发布、画风/图型一键付费分享到社区、点赞/评论、插件提交

---

## 二、认证与设备授权（RFC 8628）
1. `POST /api/auth/device`（公开）：申请 `deviceCode`、`userCode`、`verificationUrl`、`interval`。
2. `POST /api/auth/device/token`（公开）：按 `interval + 450ms` 轮询换取 `hwt_` 令牌。
3. `GET /api/auth/me`（任意有效令牌）：查询用户资料、余额与积分。
4. `GET /api/auth/tokens` + `POST /api/auth/tokens/{tid}/revoke`（任意有效令牌，支持 `tid="current"`）：登出时在服务端吊销当前设备令牌。

---

## 三、公开目录、社区收费画风/图型与统一推荐排序
- `GET /api/v1/resources/ranking?kind=style|layout`（公开，不带 Token，ETag + CDN 缓存）：与网页频道一致的画风/图型推荐排序与质量徽章（客户端本地缓存 5 分钟，24 小时离线兜底）。
- `GET /api/v1/community/resources?kind=style|layout`（公开；带 Token 附带 `unlocked` / `isMine`）：社区共享与独家画风/图型列表（`promptHidden: true`, `siteModelOnly: true`，绝无明文提示词）。
- `POST /api/v1/community/resources/{code}/unlock` 或 `POST /api/unlocks`（`studio`）：积分解锁收费画风/图型/作品/灵感。
- `GET /api/resources/{code}`（公开 / `library`）：单个资源元数据与权限。
- `GET /api/economy/public-models` / `GET /api/studio/config` / `GET /api/features`（公开 / `studio`）：官方生图规格、抽象 AI 能力服务、并发上限与功能开关。

---

## 四、网站模型生图与统一 AI 网关（`scope: studio`）
- **生图**：
  - `POST /api/studio/quote`：费用与免费张数预估
  - `POST /api/studio/generate`：提交生图（`requestId` 幂等；社区画风/图型仅传编号，服务端云端黑盒注入并返回 `promptMasked: true`）
  - `GET /api/studio/tasks?id=<taskId>&requestId=<reqId>`：查询任务结果（失败自动退费）
  - `POST /api/studio/batches/{bid}/cancel-pending`：取消未提交槽位
- **统一 AI 网关与策划**：
  - `POST /api/ai/chat`（别名 `/api/v1/ai/chat`）：统一文字/视觉对话与工具调用（`30 次/分钟`、单用户最大并发 `4`、最多 `8` 张图、总文本 ≤ `120,000` 字符；`image_url` 仅允许 `data:image/` Base64 或本站受信任域名）
  - `POST /api/studio/chat-plan` / `batch-plan` / `article-plan` / `recommend-recipe`

---

## 五、账户资产与双向同步
- **资产只读**（任意有效令牌）：`GET /api/economy`、`GET /api/me/level`、`GET /api/me/creator-earnings`
- **个人画风/图型**（`library`）：`GET/PUT/DELETE /api/v1/me/resources`、`POST /api/v1/me/resources/cover`、`GET /api/v1/resources/{rid}/download`
- **一键付费分享到社区**（`publish`）：`POST /api/v1/me/resources/{uuid}/publish`（`price: 1~500` 整数积分，禁止免费，即时上架且隐藏提示词）
- **私人图库与分类**（`library`）：`GET/PUT/DELETE /api/library/assets`、`POST /api/library/assets/{uuid}/restore`、`GET /api/library/assets/{uuid}/image`、`GET/POST/DELETE /api/studio/asset-categories`、`POST /api/media/resolve-refs`（`studio`/`publish`）
- **云端配方**（`studio` / `library`）：`GET/PUT/DELETE /api/v1/me/recipes`

---

## 六、社区作品、灵感库与插件提交
- **作品**：`GET /api/works/feed`、`GET /api/works/{wid}`（公开 / `studio`）；`POST /api/v1/me/generations`（`publish`）；`GET /api/v1/me/generations`（`library`）；`POST /api/v1/works/{wid}/likes|comments`（`publish`）；`GET /api/v1/works/{wid}/comments`（`library`）
- **灵感库**：`GET /api/inspirations/feed`、`GET /api/inspirations/{iid}`（公开 / `studio`）；`POST /api/inspirations`（`studio` / `publish`）；`POST /api/inspirations/{iid}/unlock|pricing`（`studio`）；`GET/POST /api/inspirations/{iid}/comments`（`studio` / `publish`）；`GET/POST /api/me/inspirations...`（`studio`）
- **收藏与插件**：`POST /api/collections/toggle`（`library`）；`GET /api/extensions/submissions/mine` & `POST /api/extensions/submissions`（`publish`）
