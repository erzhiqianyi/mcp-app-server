# @ninomae/mcp-app-server

**把你已有的应用变成一个带 OAuth 2.1 授权的 MCP server。**

[English](./README.md) · [日本語](./README.ja.md) · [接入指南](./docs/integration.md) · [发布流程](./docs/publishing.md) · [变更记录](./CHANGELOG.md)

把**你已有的用户和数据**，以标准 **MCP + OAuth 2.1** 的方式授权给外部 AI Agent（Claude、ChatGPT、Cursor、Claude Code、任何 MCP 客户端）。你不需要自己接 AI 模型：用户带着自己的 Agent 来，读你的数据、在他们那边分析、再通过写工具把结果送回你的应用。

- **身份不绑定任何厂商。** 你的应用已经有登录（Firebase / Supabase / Auth0 / Clerk / session cookie / 自研）——只需实现一个 `resolve(request) → { id }`。
- **框架自己当 OAuth 授权服务器。** MCP 客户端要求的动态注册（RFC 7591）、PKCE、资源指示（RFC 8707）、refresh 轮换、按 Agent 撤销，消费级 IdP 普遍不提供，所以这一层必须在你手里。
- **工具表 = 你的产品的 Agent 面。** 每个工具声明所需 scope，`tools/list` 按用户实际授权裁剪。
- **公开可发现。** `/.well-known/*`、`GET <basePath>/mcp/schema`、匿名 `initialize` / `tools/list` 都不需要 token，可直接提交官方 MCP Registry / Claude 连接器目录。
- **不绑定数据库。** 核心不依赖任何数据库实现；实现一个很小的 `AppServerStore` 接口就能接 SQL、KV、Redis、Mongo 或任意 ORM。包内自带 `memoryStore()`（开发/测试）和 `sqlStore()`（Cloudflare D1、各种 SQLite 驱动）。

## 安装

```bash
npm install @ninomae/mcp-app-server @modelcontextprotocol/sdk zod
```

可选 peer：`jose`（用 `jwtIdentity` / `firebaseIdentity` 时需要）、`react`（用 `/react` 同意页 hook 时需要）。Node ≥ 22 或任何 Web 标准运行时（Cloudflare Workers、Deno、Bun）。

## 接入七步

### 1. 决定 scope

```ts
scopes: {
  'notes:read':  { description: '阅读你的笔记', required: true },   // 锁定，永远授予
  'notes:write': { description: '为笔记附加 AI 摘要', default: true }, // 同意页默认勾选
}
```

`description` 会通过 `GET <basePath>/oauth/client` 交给同意页显示。读一个、写一个起步；写 scope 只允许 Agent 写**它自己的产出物**，不要让它改用户主数据。

### 2. 实现身份

```ts
import { sessionIdentity, jwtIdentity, firebaseIdentity, fixedIdentity } from '@ninomae/mcp-app-server';

// 服务端 session（NextAuth、Rails、Django、Laravel、自研 cookie）
identity: sessionIdentity(async (req) => await mySessions.userFromCookie(req))   // 返回 { id } 或 null

// 前端持有 JWT（Supabase、Auth0、Clerk、Cognito……任何 OIDC）
identity: jwtIdentity({ jwksUrl, issuer, audience })

// Firebase 预设
identity: firebaseIdentity(env.FIREBASE_PROJECT_ID)

// 单用户 / 本机开发（切勿放到公网 origin 后面）
identity: fixedIdentity('local')
```

契约只有一条：`id` 必须稳定、不可重用。之后每个 Agent token 都绑定它，工具 handler 拿到的 `ctx.ownerId` 就是它。

### 3. 定义工具

```ts
import { z } from 'zod';

tools: [
  {
    name: 'notes_list',
    scope: 'notes:read',
    description: '列出当前用户的笔记。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => ({ content: [{ type: 'text', text: JSON.stringify(await listNotes(ctx.ownerId)) }] }),
  },
  {
    name: 'notes_summarize',
    scope: 'notes:write',
    description: '为一条笔记保存 Agent 写的摘要。只写摘要，不改正文。',
    inputSchema: { id: z.string(), summary: z.string().max(500) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async ({ id, summary }, ctx) => { /* UPDATE … WHERE owner = ctx.ownerId */ },
  },
]
```

`ctx` 里有 `ownerId / scopes / grantId / clientId / clientName / request`——全部来自已验证的 token，绝不来自工具输入。如果你的工具只是已有 REST API 的薄包装，可以用 `ctx.request` 的 `Authorization` 头把请求转回自己的 handler，并用 `mcp.authenticate(request)` 让 REST 层接受 Agent token。

### 4. 创建 server 并挂路由

```ts
import { createMcpAppServer } from '@ninomae/mcp-app-server';
import { sqlStore } from '@ninomae/mcp-app-server/sql';

const mcp = createMcpAppServer({
  name: 'notes',
  basePath: '/api/notes',           // → /api/notes/mcp, /api/notes/mcp/schema, /api/notes/oauth/*
  consentPath: '/oauth/authorize',  // 你的前端页面
  scopes, identity, tools,
  storage: sqlStore(env.NOTES_DB),  // 或 memoryStore()，或你自己实现的 AppServerStore
  origins: { publicOrigin: 'https://notes.example.com', webOrigin: 'https://notes.example.com' },
  onEvent: (e) => audit.write(e),   // authorized / refreshed / revoked / tool（不含 payload）
});

export default {
  async fetch(request, env) {
    await mcp.ensureSchema();               // 幂等，转发给 store
    const handled = await mcp.fetch(request);
    if (handled) return handled;                // well-known / oauth / mcp / schema
    // …你原有的路由
  },
};
```

**存储。** 本包需要记住注册过的客户端、一次性授权码、refresh token 链和 access token（密钥一律只存 SHA-256）。它只通过 `AppServerStore` 这个普通对象仓储接口访问它们：

```ts
interface AppServerStore {
  clients:       { create; get; touch };
  codes:         { create; get; consume /* 原子，只有第一个调用者得到 true */; setIssuedToken };
  refreshTokens: { create; get; getByAccessToken; revoke /* 原子 */; revokeByAccessToken; setSuccessor };
  accessTokens:  { create; get; getByHash; listByOwner; touch; revoke };
  prune?(now): Promise<void>;        // 可选：清理过期 code / refresh token
  ensureSchema?(): Promise<void>;    // 可选：幂等建表，对应 mcp.ensureSchema()
}
```

自带两个实现：`memoryStore()`（Map，开发/测试/单进程）和 `@ninomae/mcp-app-server/sql` 里的 `sqlStore(db, tables?)`（D1 直接传，node:sqlite / better-sqlite3 / libsql 包十行适配器）。要接 Postgres、Redis、KV、Mongo、Prisma、Drizzle，就自己实现这个接口（约 150 行，[`src/store.ts`](./src/store.ts) 是参考实现）。标"原子"的两个方法是防重放的关键：`codes.consume` 和 `refreshTokens.revoke` 必须恰好对一个调用者返回 `true`。把 [`tests/memory-store.test.mjs`](./tests/memory-store.test.mjs) 复制一份、换成你的 store，就能验证。

**注册限流。** `POST /oauth/register` 无需认证但会写存储，所以有限流。和存储一样只定义契约：`registrationLimit: { limiter: { allow(key) => Promise<boolean> }, key?: (request) => string }`，`false` 关闭。默认 `memoryRateLimiter()`（每 IP 每小时 20 次，进程内计数）——单进程服务器正确，**Workers / Lambda 等多实例环境无效**，请接平台的共享计数器，例如 Cloudflare 的 rate-limiting binding：`{ limiter: { allow: async (key) => (await env.REGISTER_LIMIT.limit({ key })).success } }`。

其他可选项：`accessTokenDays`（默认 30）、`refreshTokenDays`（默认 90）、`tokenPrefix`（默认 `agt_`，用于在自己的路由里识别 Agent token）、`anonymousDiscovery`（默认 true）、`contract`（随 schema 一起发布的数据契约 markdown）。

### 5. 同意页

授权服务器会把用户 302 到 `webOrigin + consentPath`（原样带 query）。页面用你自己的登录，用 headless hook 完成其余部分：

```tsx
import { useAgentConsent } from '@ninomae/mcp-app-server/react';

const { client, chosen, toggle, decide, error, busy, destination, missingClient } = useAgentConsent({
  basePath: '/api/notes',
  authHeaders: () => ({ authorization: 'Bearer ' + session.token }), // 或留空，靠 cookie
});
// client.scopeDetails → 渲染复选框（required 的禁用）；decide('approve' | 'deny') 会跳回 Agent
```

完整示例见 [`examples/consent-page.tsx`](./examples/consent-page.tsx)。非 React 前端直接调 `GET <base>/oauth/client` 和 `POST <base>/oauth/approve` 即可。

### 6. 让用户管理授权

```ts
mcp.listGrants(ownerId)             // 哪些 Agent 连着我、什么权限、最后使用时间
mcp.revokeGrant(ownerId, grantId)   // 撤销并切断整条 refresh 链
```

### 7. 验证与发布

- `npm test` 里的 Miniflare 端到端（注册 → 授权 → 同意 → 换 token → 调工具 → 刷新 → 撤销）就是模板；fixture 在 `tests/fixtures/notes-host.ts`，60 行就是一个完整宿主。
- 真连一次：`claude mcp add --transport http notes https://notes.example.com/api/notes/mcp`，然后在 Claude Code 里 `/mcp` → Authenticate。
- `mcp.serverJson(request, 'io.github.<you>', '一句话描述')` 生成官方 MCP Registry 的 `server.json`；`mcp-publisher publish` 即可上架。Claude / ChatGPT 连接器目录另需人工提交（固定 HTTPS 地址、隐私政策）。

各类客户端（Claude Code、Claude.ai、ChatGPT、Cursor、自写脚本）的具体接入步骤见 [docs/integration.md](./docs/integration.md)。

## 端点一览

| 路径 | 认证 | 作用 |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource[<mcpPath>]` | 无 | 资源元数据（RFC 9728） |
| `GET /.well-known/oauth-authorization-server` | 无 | 授权服务器元数据（RFC 8414） |
| `GET <base>/mcp/schema` | 无 | 服务器名、端点、scope、全部工具的 JSON Schema |
| `POST <base>/mcp`（`initialize`/`ping`/`tools/list`） | 无 | 匿名发现；返回全量工具 |
| `POST <base>/mcp`（其他） | Agent token | MCP Streamable HTTP |
| `POST <base>/oauth/register` | 无（限速） | 动态客户端注册 |
| `GET <base>/oauth/authorize` | 无 | 校验后 302 到同意页 |
| `GET <base>/oauth/client` | 无 | 同意页读取客户端与 scope 说明 |
| `POST <base>/oauth/approve` | **宿主身份** | 用户同意/拒绝 → 授权码 |
| `POST <base>/oauth/token` | 客户端 | 授权码换 token、refresh 轮换 |

## 本包不做什么

它是桥接，不是权限系统。它从不判断某个用户能不能看某条记录：`ctx.ownerId` 是验证过的用户，你的 handler 用它执行**原有**的规则——直接调你的 service 层传这个 id，或者带上 `ctx.request` 的 `Authorization` 头回调你自己的 REST API，在那里用 `mcp.authenticate()` 认出用户，其余逻辑和浏览器会话一模一样。scope 是"授权委托"而不是"权限"：它只收窄*这个 agent* 能替用户做的事，`scopes` 可以完全省略（本包会用一个隐式 scope，同意页变成单纯的允许/拒绝）。

## 安全边界

- 用户身份只来自 `identity.resolve`；Agent token 不能用来 approve。
- 授权码 10 分钟、一次性；重放会吊销它签发的 token。refresh 轮换；重放已轮换的 refresh 会切断整条链。
- token 只存 SHA-256；audience 绑定 `publicOrigin + mcpPath`，换域名后旧 token 自动失效。
- `tools/call` 永远要 token；匿名发现只暴露工具元数据，不暴露数据。
- 跨站 `Origin` 的 MCP 请求被拒绝（loopback 除外）。
- redirect_uri 只接受 loopback / 自定义 scheme / https，注册时即拒绝其他形式。

## 与 Cloudflare `workers-oauth-provider` 的区别

它解决同一层的 OAuth 问题（KV 存储）。本包多出：可插拔存储（任意数据库，含 D1）、可插拔宿主身份、scope 化工具表、按授权裁剪的 `tools/list`、公开 schema 与匿名发现、同意页 hook、授权管理 API、以及一套可复用的端到端测试。如果你只需要 OAuth 而不需要以上任何一项，用官方库即可。

## 开发

```bash
npm install
npm run typecheck
npm test          # Miniflare 端到端
npm run build     # 产出 dist/（ESM + .d.ts）
```

发布到 npm 的完整步骤见 [docs/publishing.md](./docs/publishing.md)。

## 许可

[MIT](./LICENSE)
