# 接入指南

[English](./integration.md)

两类读者：**宿主应用**把网关挂进来（第 1 节）；**Agent 客户端**在宿主上线后连接（第 2 节）。

## 1. 在你的应用里挂载网关

网关就是一个 `fetch(Request) → Response | null` 函数加一个 SQLite 形状的存储接口，任何有 Web 标准 `Request`/`Response` 的运行时都能跑。把它挂在你自己的路由**之前**，让它认领这些路径：

- `/.well-known/oauth-protected-resource[<mcpPath>]`、`/.well-known/oauth-authorization-server`
- `<basePath>/mcp`、`<basePath>/mcp/schema`
- `<basePath>/oauth/register|authorize|client|approve|token`

其他路径返回 `null`，交回给你。

### Cloudflare Workers + D1

D1 直接满足 `SqlDatabase`。完整宿主见 [`examples/cloudflare-worker/worker.ts`](../examples/cloudflare-worker/worker.ts)。

```ts
export default {
  async fetch(request, env) {
    const gateway = createGateway(env);      // createAgentGateway({ …, storage: env.DB })
    await gateway.ensureSchema();
    return (await gateway.fetch(request)) ?? app(request, env);
  },
};
```

同一个 Worker 服务多个域名、或开发时走隧道，`origins` 可以是函数：

```ts
origins: (request) => {
  const origin = new URL(request.url).origin;
  return { publicOrigin: env.PUBLIC_ORIGIN || origin, webOrigin: env.WEB_ORIGIN || origin };
},
```

`publicOrigin` 要保持稳定：它是 token 的 audience，改了就等于作废所有已签发的 token。

### Hono（Workers / Node / Bun / Deno）

```ts
import { Hono } from 'hono';
const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  const gateway = createGateway(c.env);
  await gateway.ensureSchema();
  const handled = await gateway.fetch(c.req.raw);
  return handled ?? next();
});
```

### Node.js + 内置 `node:sqlite`

Node ≥ 22.5 不需要任何原生模块。下面的适配器就是 `tests/node-sqlite.test.mjs` 里跑的那份：

```ts
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase } from '@erzhiqian/agent-gateway';

export function nodeSqlite(db: DatabaseSync): SqlDatabase {
  const wrap = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => wrap(sql, next),
    first: async () => (db.prepare(sql).get(...values) as any) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) as any[] }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
  });
  return { exec: async (sql) => void db.exec(sql), prepare: (sql) => wrap(sql) };
}
```

`better-sqlite3`、`libsql`、`sql.js` 同样包法：网关只用 `?1 … ?n` 位置占位符、`first()`、`all()` 和 `run().meta.changes`。

HTTP 层用任何 Web 标准服务器都行（`@hono/node-server`、`srvx`、Bun.serve、Deno.serve）。

### Next.js（App Router）

Route handler 收到的就是 Web `Request`，两个 catch-all 路由即可：

```ts
// app/api/notes/[...path]/route.ts  以及  app/.well-known/[...path]/route.ts
import { gateway } from '@/lib/agent-gateway';
const handle = async (request: Request) => (await gateway.fetch(request)) ?? new Response('Not found', { status: 404 });
export { handle as GET, handle as POST };
```

同意页是挂在 `consentPath`（默认 `/oauth/authorize`）上的普通客户端组件，用 `useAgentConsent`——见 [`examples/consent-page.tsx`](../examples/consent-page.tsx)。Vercel/Node 上的存储可以是 `node:sqlite`、libsql/Turso，或通过 Cloudflare 适配器用 D1。

### 让已有 API 接受 Agent token

工具往往只是你已有 REST 端点的薄包装。让这些端点在普通 session 之外也接受 Agent token：

```ts
const grant = await gateway.authenticate(request);   // 请求没带 agt_ token 时为 null
const user = grant ? { id: grant.ownerId, scopes: grant.scopes, agent: grant.clientName } : await sessionUser(request);
```

工具内部把调用方的 `Authorization` 头原样转发：`fetch(origin + '/api/notes', { headers: { authorization: ctx.request.headers.get('authorization')! } })`。scope 检查、校验、租户隔离都留在一处。

### 授权管理界面

```ts
GET  /settings/agents      → gateway.listGrants(user.id)            // name、scopes、createdAt、lastUsedAt、expiresAt
POST /settings/agents/:id/revoke → gateway.revokeGrant(user.id, id) // 不是该用户的授权 → 404
```

### 审计

```ts
onEvent: async (event) => {
  // { type: 'authorized' | 'refreshed' | 'revoked', ownerId, grantId, clientId, clientName, scopes? }
  // { type: 'tool', ownerId, grantId, clientId, clientName, tool, ok }
  await env.DB.prepare('INSERT INTO audit(kind, owner, detail, at) VALUES (?1, ?2, ?3, ?4)').bind(event.type, event.ownerId, JSON.stringify(event), new Date().toISOString()).run();
},
```

工具的入参和结果永远不会传给 `onEvent`；如果数据政策允许，在工具 handler 里自己记。

### 本机开发

- `fixedIdentity('local')` 跳过登录，适合单用户工作区。绝不要暴露在公网 origin 上。
- MCP 客户端注册的 redirect URI 是 `http://localhost:<随机端口>`；loopback 端口按 RFC 8252 §7.3 宽松匹配，每次运行都能通过。
- API 走隧道（`https://x.trycloudflare.com`）、网页在 `http://localhost:3000` 时，`publicOrigin` 设为隧道、`webOrigin` 设为 localhost；同意页会往它自己 origin 上的 `basePath` 发请求，所以开发环境要把 `<basePath>/*` 代理到 API。

## 2. 连接 Agent 客户端

宿主上线后只需分享一个地址：`https://<publicOrigin><basePath>/mcp`。下面每个客户端都会从它发现 OAuth 服务器、自动注册、打开同意页、保存 token；用户不需要复制任何密钥。

### Claude Code

```bash
claude mcp add --transport http notes https://notes.example.com/api/notes/mcp
```

然后在 Claude Code 里 `/mcp` → 选中服务器 → **Authenticate**。团队共用可提交 `.mcp.json`：

```json
{ "mcpServers": { "notes": { "type": "http", "url": "https://notes.example.com/api/notes/mcp" } } }
```

### Claude.ai 与 Claude Desktop

*Settings → Connectors → Add custom connector* → 粘贴 MCP 地址。Claude 自动走动态注册和 OAuth。组织管理员可以为整个工作区添加一次。上架 Claude 公共连接器目录需另行人工提交（固定 HTTPS 地址、隐私政策、支持联系方式）。

### ChatGPT

*Settings → Connectors → Advanced → Developer mode*（或 *Apps SDK* 开发者设置）→ **Create** → 填 MCP 地址，认证选 **OAuth**。ChatGPT 会动态注册并跳到同意页。Deep research 类连接器额外要求 `search` 和 `fetch` 工具；普通工具调用没有这个要求。

### Cursor

`.cursor/mcp.json`（项目）或 `~/.cursor/mcp.json`（全局）：

```json
{ "mcpServers": { "notes": { "url": "https://notes.example.com/api/notes/mcp" } } }
```

Cursor 会显示 **Needs login**，点击即打开同意页。

### VS Code（GitHub Copilot agent 模式）

`.vscode/mcp.json`：

```json
{ "servers": { "notes": { "type": "http", "url": "https://notes.example.com/api/notes/mcp" } } }
```

### OpenAI Codex CLI

```bash
codex mcp add notes --url https://notes.example.com/api/notes/mcp
codex mcp login notes
```

### Gemini CLI

```bash
gemini mcp add --transport http notes https://notes.example.com/api/notes/mcp
```

### 自己写脚本（TypeScript）

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://notes.example.com/api/notes/mcp'), {
  authProvider,   // 一个 OAuthClientProvider：保存 client 信息和 token，把 redirectUrl 打开到浏览器
});
const client = new Client({ name: 'my-script', version: '1.0.0' });
await client.connect(transport);            // 第一次会抛 UnauthorizedError → 走完 OAuth 再重连
console.log(await client.listTools());
console.log(await client.callTool({ name: 'notes_list', arguments: {} }));
```

SDK 的 `OAuthClientProvider`（`@modelcontextprotocol/sdk/client/auth.js`）负责发现、动态注册和 PKCE，你只提供持久化和浏览器跳转。不想依赖 SDK 的话，网关的端到端测试用裸 `fetch` 三十来行走完了同一流程：[`tests/gateway.test.mjs`](../tests/gateway.test.mjs)。

### 裸 HTTP 走一遍

```bash
BASE=https://notes.example.com/api/notes
curl -s $BASE/mcp/schema | jq .tools[].name                      # 服务器提供什么
curl -s https://notes.example.com/.well-known/oauth-authorization-server | jq .
curl -s -X POST $BASE/oauth/register -H 'content-type: application/json' \
  -d '{"client_name":"curl","redirect_uris":["http://localhost:8976/cb"]}'
# 浏览器打开 $BASE/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256
# 同意后落到 redirect_uri?code=…
curl -s -X POST $BASE/oauth/token -d grant_type=authorization_code -d code=… -d code_verifier=… -d client_id=… -d redirect_uri=…
curl -s -X POST $BASE/mcp -H "authorization: Bearer agt_…" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"notes_list","arguments":{}}}'
```

### 上架官方 MCP Registry

```ts
// 例如在你的应用里提供 GET /api/notes/server.json
return Response.json(gateway.serverJson(request, 'io.github.<github用户名>', '一句话描述'));
```

存为 `server.json`，然后：

```bash
mcp-publisher login github
mcp-publisher publish
```

Registry 通过 GitHub 登录验证 `io.github.<user>` 命名空间，并从网关已允许的匿名 `initialize` / `tools/list` 读取服务器元数据。

## 3. 公开前检查清单

- [ ] `publicOrigin` 是最终的 HTTPS 域名（token 与它绑定）。
- [ ] 写 scope 只允许 Agent 写**它自己的产出物**；用户主数据只读，或放在需要显式勾选的 scope 后面（`default: false`）。
- [ ] 每个工具 handler 都按 `ctx.ownerId` 过滤；端到端测试里的跨租户断言就是要照抄的模式。
- [ ] 同意页展示 `clientName`、`destination` 和每个 scope 的 `description`；拒绝按钮可用。
- [ ] 用户能查看并撤销授权（`listGrants` / `revokeGrant`）。
- [ ] `onEvent` 接到审计日志。
- [ ] 如果预期会被滥用，在内置的按 IP 限速之外给 `POST <base>/oauth/register` 再加一层限流。
