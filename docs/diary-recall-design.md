# 日记与回忆功能设计（草案）

状态：设计草案，尚未实现。本文定义需求、架构边界和分阶段验收标准；实现状态仍以 `docs/implementation-plan.md` 为准。

## 1. 目标与范围

把 MeMem 从“AI 可读写的个人记忆库”扩展为“带照片的个人日记 + 回忆生成”：

- **记录**：每天或每周几次，记一段文字并附上若干照片。
- **回忆**：选择一个主题（例如“我和妻子共同度过的时光”）和时间范围，由 AI 客户端通过 MCP 读取历史记录、撰写叙事，Worker 用固定模板渲染成一个可分享的回忆网页。

已确定的决策：

| 问题 | 决策 |
| --- | --- |
| 使用者 | 个人日记，单一 owner。多人共同回忆是以后的扩展，本阶段不改 owner 模型。 |
| 媒体存储 | 原图存 Cloudflare R2。本阶段只支持照片，不支持视频。 |
| 回忆文字 | 由 Claude / ChatGPT 通过 MCP 读取数据后撰写。Worker 和 core 不调用任何 AI API，不需要 API key。 |

不在本阶段范围内：视频上传与视频导出、多人共享空间、语义检索（Vectorize）、Worker 内的 AI 调用、端到端加密。

## 2. 数据模型

### 2.1 日记条目复用现有 memory

日记条目就是一条 `kind: 'event'` 的 memory，不新增 kind：

- `text`：用户的日记原文。
- `occurredAt`：事情发生的时间（不是记录时间）。
- `relatedIds`：关联的 `person` / `place` 记录。例如先建一条 `person` 记录“妻子 · 名字”，之后和她相关的日记都通过 `relatedIds` 指向它。

回忆检索因此可以直接用现有查询完成：先 `search_memories(text: "妻子")` 找到人物 ID，再 `search_memories(relatedTo: <id>, from, before)` 取出时间范围内的条目。

注意：`list` 按记录 ID 升序做 keyset 分页，不是时间顺序。回忆页面在渲染时按 `occurredAt` 排序，不依赖查询顺序。

### 2.2 新表：媒体（`migrations/d1/0002_media.sql`）

```sql
CREATE TABLE IF NOT EXISTS media (
  owner TEXT NOT NULL, id TEXT NOT NULL,
  memory_id TEXT,                 -- 关联的日记条目；NULL 表示已上传但未关联
  content_type TEXT NOT NULL,     -- image/jpeg、image/heic、image/png、image/webp
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,           -- 去重与完整性校验
  taken_at TEXT,                  -- EXIF 拍摄时间，带时区的 ISO 时间；未知为 NULL
  width INTEGER, height INTEGER,
  caption TEXT,
  created_at TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS media_memory ON media(owner, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_hash ON media(owner, sha256);
```

R2 对象键：`{owner}/{sha256}/original`、`{owner}/{sha256}/display`（长边 1600px）、`{owner}/{sha256}/thumb`（长边 400px），键由照片内容的 SHA-256 决定，同一张照片总是使用同一组键（见 4.3）。R2 bucket 私有，不开放公共访问。

GPS 坐标：第一阶段不存储。展示用的 `display` / `thumb` 衍生图不带 EXIF；原图保留原始文件。

### 2.3 新表：回忆（`migrations/d1/0003_recalls.sql`）

```sql
CREATE TABLE IF NOT EXISTS recalls (
  owner TEXT NOT NULL, id TEXT NOT NULL,
  payload TEXT NOT NULL,          -- 回忆文档 JSON，结构见 4.2
  share_token_hash TEXT,          -- 分享链接令牌的哈希；NULL 表示未分享
  share_expires_at TEXT,
  created_at TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
```

## 3. 架构边界

遵守 AGENTS.md 的规则：`MemoryStore` 保持不变，core 不依赖平台和 AI。

- `src/core/contracts.ts` 新增两个独立接口，不扩展 `MemoryStore`：
  - `MediaStore`：媒体元数据的 get / list / save / delete（与 `MemoryStore` 相同的 owner 作用域和 CAS 语义）。
  - `BlobStore`：`put(key, stream, contentType)`、`get(key)`、`delete(keys)`。core 只看到这个接口，看不到 R2 类型。
  - `RecallStore`：回忆文档的 CRUD。
- `src/core/` 新增 `media.ts`、`recall.ts` 服务，负责校验（类型白名单、大小上限、ID 归属检查）。
- `src/storage/` 新增 D1 实现；`src/platform/cloudflare.ts` 用 R2 binding 实现 `BlobStore`。
- `wrangler.json` 新增 R2 binding `MEDIA`。D1 存元数据，R2 存文件，`OAUTH_KV` 只存 OAuth 数据。
- owner 仍然只来自服务端（OAuth 上下文或网页会话），任何 MCP 参数或表单字段都不接受 owner。

## 4. 功能设计

### 4.1 记录入口：网页采集页 `/capture`

MCP tool 的参数是 JSON，没办法可靠地把照片二进制交给 tool，所以照片上传走一个单独的网页入口。

- **登录**：用 owner 口令登录，创建一个 `HttpOnly; Secure; SameSite=Strict` 会话 cookie。会话存在 D1 的 `web_sessions` 表（只存令牌哈希和过期时间），不存在 `OAUTH_KV`。
- **页面**：选照片，写一段文字，可选择关联的人物和地点，然后提交。适配手机 Safari，可以“添加到主屏幕”作为 PWA 使用。
- **客户端处理**：浏览器读取 EXIF 拍摄时间，作为 `occurredAt` 的默认值；用 canvas 生成 `display` 和 `thumb` 衍生图；计算 sha256。这样 Worker 不需要做图片处理。HEIC 在 Safari 里能解码；其他浏览器无法解码时只上传原图，并标记为缺少衍生图。
- **上传**：`POST /api/media`（multipart），由 Worker 流式写入 R2。不使用 R2 预签名 URL，以免引入额外的 S3 凭证。单张照片上限 25 MB。
- **安全**：同源校验、CSRF 令牌、严格 CSP，与现有授权页同一套做法。

后续可以加 iOS 快捷指令入口，使用单独的、只能上传的可吊销令牌。这一项不在第一阶段。

文字日记仍然可以直接在 ChatGPT 或 Claude 里通过 `record_memory` 记录；照片之后可以在 `/capture` 页面上关联到这条已有记录。

### 4.2 回忆生成：MCP + 模板渲染

新增 MCP 工具：

| 工具 | 作用 | 所需 scope |
| --- | --- | --- |
| `list_media` | 按 `memoryId` 或时间范围列出照片元数据（id、拍摄时间、尺寸、说明）。可选返回缩略图，作为 MCP image content，供 AI 看图写字。 | `memory:read` |
| `create_recall` | 提交回忆文档，返回回忆页面 URL。 | `memory:read memory:write` |
| `update_recall` / `delete_recall` | 修改或删除回忆，使用 expectedVersion 做 CAS。 | `memory:read memory:write` |
| `share_recall` | 生成或撤销分享链接，可设置有效期（默认 30 天）。 | `memory:read memory:write` |

沿用现有 scope，已连接的 ChatGPT 和 Claude connector 不需要重新授权。

回忆文档结构（AI 只提供数据，不提供 HTML）：

```json
{
  "title": "我们的 2025",
  "subtitle": "可选",
  "sections": [
    {
      "heading": "春天 · 京都",
      "body": "纯文本叙事，Worker 渲染时转义",
      "memoryIds": ["..."],
      "mediaIds": ["..."]
    }
  ]
}
```

- `create_recall` 校验每个 `memoryId` 和 `mediaId` 都属于当前 owner；有任何一个不存在就整体拒绝。
- AI 撰写的文字一律作为纯文本转义后渲染，不接受 HTML 或 Markdown 中的链接和脚本，以防记录内容里的 prompt injection 变成页面里的 XSS。
- 页面 `/r/{id}` 用固定模板渲染：封面、按 `occurredAt` 排序的时间线、照片网格、日记原文引用。照片通过 `/r/{id}/media/{mediaId}/{variant}` 提供，只有在该回忆引用了这张照片、且访问者是 owner 会话或持有有效分享令牌时才返回。

典型流程（在 Claude 或 ChatGPT 里）：

1. 用户说：“帮我做一个和妻子 2025 年的回忆”。
2. AI 调用 `search_memories` 找到“妻子”这条 person 记录的 ID。
3. AI 调用 `search_memories(relatedTo, from, before)`，取出这段时间的日记条目。
4. AI 对相关条目调用 `list_media`。
5. AI 挑选内容、分段、撰写叙事，然后调用 `create_recall`，返回页面链接。
6. 用户需要分享时，调用 `share_recall` 拿到带有效期的链接，发给妻子。

### 4.3 删除语义

- `forget_memory`：删除日记条目时，把关联照片的 `memory_id` 置为 NULL，照片本身不删；回忆页面中这一条显示为已删除的空位。删除可以安全重试：先删除条目，解除关联失败时 `forget_memory` 报错；重试时条目已不存在，视为成功，并再次执行解除关联（解除关联本身是幂等的）。
- 照片 blob 按内容寻址，R2 键为 `{owner}/{sha256}/{variant}`，`variant` 为 `original`、`display` 或 `thumb`。每次上传都写入同一组键：重复上传会补回缺失的 blob；上传中途失败留下的 blob 会被下一次上传覆盖，失败路径不再清理 blob。
- 删除照片时先删除 R2 中的 blob，再用版本号做比较并交换删除 D1 中的元数据。中途失败后重试会完成删除；已删除的照片再次删除返回成功。
- `/capture` 提交的日记条目携带浏览器生成的 `id`（`crypto.randomUUID()`）。内容不变的重试沿用同一个 `id`，服务端按 `id` 重放已保存的条目，因此响应丢失后的重试不会产生第二条日记；用户在重试前改了内容时换用新 `id`（服务端不会用不同内容重放同一个 `id`），此时若第一次其实已保存，会留下两条日记。删除后不保留墓碑，用同一 `id` 和内容重放会重新创建条目。
- 本次改动不需要数据迁移：照片功能尚未部署。
- `forget_media`（新增 MCP 工具，同时在 `/capture` 页面提供）：删除 R2 中的三个对象和 D1 中的元数据，并从所有回忆中移除对这张照片的引用。
- 分享令牌可以随时撤销，撤销后旧链接立即返回 404。

## 5. 分阶段计划与验收标准

每个阶段都要先在本地通过 Miniflare（D1、KV、R2）集成测试，再运行 `npm run check` 和 `npm test`。本地测试不能作为云端部署的证明。

**阶段 1：媒体存储与采集页**

- 新增 `MediaStore` / `BlobStore` 接口和 D1、R2 实现，以及 `0002_media.sql`。
- `/capture` 登录、上传、关联到日记条目。
- 验收：上传一张 JPEG 后，D1 有元数据，R2 有三个对象；重复上传同一张照片被 sha256 去重；未登录或跨站请求返回 401/403；超过 25 MB 被拒绝；owner 隔离测试通过。

**阶段 2：回忆生成**

- `list_media`、`create_recall`、`update_recall`、`delete_recall`、`share_recall`、`forget_media`，以及 `/r/{id}` 模板。
- 验收：用 MCP 协议客户端完成“搜人物 → 按时间取条目 → 列照片 → 创建回忆 → 打开页面”的完整流程；引用不存在或他人的 ID 时被拒绝；正文中的 `<script>` 被转义；未授权访问照片返回 404；分享令牌过期或撤销后失效。

**阶段 3：生产验证**

- 部署 R2 binding 和迁移；在真实的 Claude 或 ChatGPT 里生成一个使用测试数据的回忆；测试完毕后按 owner、ID 和标记清理测试数据。

**以后：** iOS 快捷指令上传、语义检索、视频、多人共同回忆。

## 6. 待定问题

1. 回忆页面是否需要几种模板风格（时间线、相册、杂志式），还是先只做一种？建议先只做时间线。
2. 是否需要提供原图下载？默认页面只提供 `display` 衍生图。
3. 存储用量提示：是否在 `/capture` 页面显示已用空间，以对照 R2 的 10 GB 免费额度？
