# MeMem

MeMem is a personal memory service that keeps its data in a database owned by the person using it. This project runs the existing memory core behind a Cloudflare Worker, D1, and a remote MCP endpoint. The service does not call an AI API; ChatGPT or another MCP client supplies the text to remember and the searches to perform.

The Worker and full OAuth/MCP flow are covered by local Miniflare integration tests. Worker version `01b77180-dd4e-4f05-9cc4-7514f46bf660` (English consent page) is deployed at `https://memem.michaelguan1992.workers.dev`. The one-time production acceptance script passed OAuth DCR/PKCE/consent and MCP create/search/correct/reconnect/delete, then confirmed cleanup of its own test record. Chrome OAuth connected successfully, and real ChatGPT web conversations have now saved a memory in one chat and found it from a separate chat. The ChatGPT acceptance fixture was deleted with an owner-, ID-, and marker-scoped query; D1 reported one deletion and zero remaining matches. The local deployment-token file was deleted, and Cloudflare confirmed that the deployment token has been revoked. Production deployment and ChatGPT web end-to-end acceptance are complete.

## Components

- `src/core/` contains the platform-independent memory rules and `MemoryStore` interface.
- `src/storage/` contains local SQLite and D1 adapters.
- `src/mcp/tools.ts` defines strict `record_memory`, `search_memories`, `get_memory`, `correct_memory`, and `forget_memory` tools.
- `src/worker.ts` serves stateless Streamable HTTP at `/mcp` and OAuth 2.1 authorization, discovery, refresh, and dynamic client registration through the official Cloudflare OAuth provider.
- D1 stores memory records. The separate `OAUTH_KV` binding stores OAuth clients, grants, consent handles, and tokens.

The authenticated owner identity comes from the OAuth provider's verified context. MCP tool arguments cannot choose a user or owner. Read-only tools require `memory:read`; record, correct, and forget require both `memory:read` and `memory:write`. OAuth access tokens last one hour and refresh tokens last 30 days.

## Local development

Use Node.js 24 or newer.

```sh
npm install
node scripts/setup-secrets.mjs
npm run dev
```

The setup script generates a 256-bit owner passphrase. It saves the passphrase to `.secrets/owner-passphrase`, its salted verifier to `.secrets/owner-password-hash`, and the local Worker binding to `.dev.vars`. The script does not print either credential. The `.secrets` directory uses mode `0700`; each credential file uses mode `0600`. Keep the passphrase in a password manager and open the local file when you need to enter it in MeMem's authorization page. Never paste the passphrase into an AI conversation.

`npm run dev` uses local Miniflare D1 and KV bindings. The local D1 migration is `migrations/d1/0001_memories.sql`; the local resource URL is `http://localhost:8787/mcp`. Loopback HTTP is accepted only for local development.

## Checks

```sh
npm run check
npm test
npm run demo
```

`npm test` runs all nine existing core tests and a real Worker integration test under Miniflare. The integration test applies the D1 migration to Miniflare's D1 binding, uses its KV binding, and drives OAuth discovery, DCR, PKCE, consent, token and refresh flows, then uses the official MCP client over Streamable HTTP for reads and writes. It covers cross-client lookups, version conflicts, deletion, read-only scopes, bad audiences and PKCE, and rejected consent submissions. Test data exists only in the local test database.

## Cloudflare deployment

Create a Cloudflare D1 database named `memem` and a KV namespace for OAuth state. Put their IDs in `d1_databases[0].database_id` and `kv_namespaces[0].id` in `wrangler.json`. Set the production `MCP_RESOURCE_URL` to `https://<worker-host>/mcp` and `OAUTH_ISSUER` to the same HTTPS origin without `/mcp`. Replace the URL and resource ID placeholders before deployment.

In the Cloudflare dashboard, create a custom API token for this deployment only. Limit it to your own account, grant **Workers Scripts Edit**, **D1 Edit**, and **Workers KV Storage Edit**, and set a short expiration with no renewal. Then double-click `scripts/save-cloudflare-token.command` in Finder (or run it from Terminal). Paste the token at its hidden prompt; it is saved to `.secrets/cloudflare-api-token` with mode `0600` inside the mode-`0700` `.secrets` directory. The helper refuses to overwrite an existing token file and does not display or log the token.

After setting the production resource IDs and URLs, run:

```sh
node scripts/setup-secrets.mjs
npm run deploy
```

The deploy script runs the type check, full test suite, and Wrangler production dry-run before it checks the production bindings or writes remote state. It then applies D1 migrations, uploads only the salted owner-password verifier as `OWNER_PASSWORD_HASH`, and deploys the Worker. Wrangler runs through `scripts/wrangler-cloudflare.mjs`, which reads the local token and places it only in Wrangler's child-process environment as `CLOUDFLARE_API_TOKEN`; it also selects the verified account ID `8d5a4c2693eb545e17dd38a66492a13e`. The token is not passed as a command-line argument or printed. The deployment script never uploads the owner passphrase. The production Worker rejects HTTP and accepts HTTPS only.

After confirming deployment, revoke the API token in the Cloudflare dashboard and delete the local copy with `rm .secrets/cloudflare-api-token`. Do not keep the token for future deployments; create a new short-lived token only when another deployment is authorized.

For a one-time production MCP check, run `npm run acceptance:remote`. It reads the owner passphrase from `.secrets/owner-passphrase`, completes OAuth DCR/PKCE/consent and uses the official MCP client against the deployed HTTPS endpoint. It creates a uniquely marked test fact, checks it, corrects it, verifies the corrected text through a second MCP client connection, then deletes it. On failure it searches by its unique marker and makes a best-effort deletion. Output contains only boolean acceptance/cleanup results and, on failure, a fixed stage name or numeric HTTP status; it does not print OAuth codes, tokens, URLs, response bodies, or memory content. This script performs remote writes and should only be run for an authorized deployment check.

Connect an MCP client to the deployed `/mcp` URL. The OAuth authorization page identifies MeMem, the client, and each requested permission. Enter the generated passphrase only on that service page. A client secret is not used. Read permission is required to connect; write permission is separately requested for memory changes. `offline_access` allows the provider's refresh-token flow.

## ChatGPT 接入（Web 端已完成实测）

在 ChatGPT 网页版的同一账号中，打开 **Plugins → Add → Add custom MCP server**，填写名称 `MeMem` 和服务地址 `https://<worker-host>/mcp`，认证方式选择 OAuth。展开 **Advanced OAuth settings**，使用 DCR，并将 **Base scopes** 逐行填写 `memory:read`、`memory:write`、`offline_access`。本用户现有插件已配置，无需重复创建。在 MeMem 授权页核对客户端与权限，并输入本机 `.secrets/owner-passphrase` 文件中的口令；不要把口令发到聊天里。

安装后，在新聊天输入 `@MeMem` 并从列表选择 MeMem。可以这样记录：“请保存：我在 2026-10-08 12:00 America/Los_Angeles 于某餐馆与 Matthew 见面；来源是我的日历。”只有 `record_memory` 工具成功返回后，才表示记忆确已保存。查询时提供姓名、短关键词或日期；如果没找到，尝试拆成更短的关键词或分几次查询。MeMem 当前按字面关键词和日期筛选，不做向量或语义检索。更正前先查到现有记忆，再要求按当前版本更正；以更正成功后的内容为准。

已在两个独立 ChatGPT 网页聊天中实际验证保存和跨聊天查找。iPhone 原生 ChatGPT App 未验证；官方 FAQ 目前说明 MCP apps 不适用于 mobile。iPhone Safari 网页版也未实测，只有在你自己的 ChatGPT 界面能选择 `MeMem` 时才能尝试使用。参见 [ChatGPT MCP apps FAQ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。ChatGPT 验收记录已按 ID、owner 和标记精确删除，D1 返回删除 1 条、剩余 0 条。本地部署 token 文件已删除，Cloudflare 已确认云端 token 撤销。生产部署和 ChatGPT 网页端端到端验收均已完成。

## Claude 接入（已实测）

MeMem 是标准远程 MCP 服务，Claude 无需单独接口。在 claude.ai 打开 **Settings → Connectors → Add custom connector**，名称填 `MeMem`，URL 填 `https://<worker-host>/mcp`，OAuth Client ID/Secret 留空（使用 DCR）。Claude 会按 401 响应和受保护资源元数据申请 `memory:read memory:write`；在 MeMem 授权页核对权限并输入口令。同一连接器会同步到 Claude 桌面端和移动端。

服务端已同时声明读写权限，已部署于版本 `5cfcee9a-1501-40d9-8b35-be462543309f`，curl 确认 401 响应与元数据均为 `memory:read memory:write`；2026-10-09 通过 Claude 自定义连接器实测：保存、搜索、按 ID 读取、按版本更正、删除全部成功，验收记录已删除且按标记搜索剩余 0 条。Claude 跨对话查找未单独验证。

## Memory behavior

Memory text is stored as provided, with an optional source and an ISO 8601 `occurredAt` timestamp that must include a timezone. For people and places, search first and associate an existing record only when the identity is clear. Associations are explicit `relatedIds`; MeMem does not infer relationships or perform semantic search.

Search is literal substring matching with optional date, relationship, and pagination filters. If a search misses, try several short terms and look up a person's record before querying its related memories. Correcting a record uses its current version and replaces the current contents. The first text remains in storage as historical `originalText`, but MCP responses expose only current text. Deletion removes the record and its historical original from D1.

## Dependency advisory

The installed `agents@0.28.0` peer requirements retain `@modelcontextprotocol/client@2.0.0` and `@modelcontextprotocol/sdk@1.30.0`, which match the published OAuth client credential-selection advisory GHSA-6qxp-vccf-f47h. The production Wrangler bundle was inspected: neither client package nor its OAuth-client code is present in the 182-source bundle map. The dependency-tree advisory remains visible and should be rechecked when Agents updates its peer versions; it has not been marked fixed.
