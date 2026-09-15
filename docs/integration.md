# Integration guide

[中文](./integration.zh-CN.md)

Two audiences: **host apps** that mount the server (section 1), and **agent clients** that connect to a host once it is deployed (section 2).

## 1. Mounting the server in your app

The server is a single `fetch(Request) → Response | null` function plus a storage interface (`AppServerStore`) with no database dependency, so it runs anywhere Web-standard `Request`/`Response` exist. Mount it **before** your own routing and let it claim its paths:

- `/.well-known/oauth-protected-resource[<mcpPath>]`, `/.well-known/oauth-authorization-server`
- `<basePath>/mcp`, `<basePath>/mcp/schema`
- `<basePath>/oauth/register|authorize|client|approve|token`

Everything else returns `null` and falls through to you.

### Cloudflare Workers + D1

Wrap the D1 binding with `sqlStore` from `@erzhiqian/mcp-app-server/sql`. Complete host: [`examples/cloudflare-worker/worker.ts`](../examples/cloudflare-worker/worker.ts).

```ts
export default {
  async fetch(request, env) {
    const mcp = createMcpAppServerFor(env);      // createMcpAppServer({ …, storage: sqlStore(env.DB) })
    await mcp.ensureSchema();
    return (await mcp.fetch(request)) ?? app(request, env);
  },
};
```

`origins` may be a function when the same Worker serves several hostnames or a tunnel during development:

```ts
origins: (request) => {
  const origin = new URL(request.url).origin;
  return { publicOrigin: env.PUBLIC_ORIGIN || origin, webOrigin: env.WEB_ORIGIN || origin };
},
```

Keep `publicOrigin` stable: it is the token audience, so changing it invalidates every issued token.

### Hono (Workers, Node, Bun, Deno)

```ts
import { Hono } from 'hono';
const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  const mcp = createMcpAppServerFor(c.env);
  await mcp.ensureSchema();
  const handled = await mcp.fetch(c.req.raw);
  return handled ?? next();
});
```

### Node.js with the built-in `node:sqlite`

No native module needed on Node ≥ 22.5. The adapter below is exercised by `tests/node-sqlite.test.mjs`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { sqlStore, type SqlDatabase } from '@erzhiqian/mcp-app-server/sql';

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

Then `storage: sqlStore(nodeSqlite(db))`. `better-sqlite3`, `libsql` and `sql.js` wrap the same way: the adapter only uses `?1 … ?n` positional placeholders, `first()`, `all()` and `run().meta.changes`.

### Any other database

Implement `AppServerStore` directly — four small repositories over plain records, no SQL involved. `memoryStore()` in `src/store.ts` is the reference; `tests/memory-store.test.mjs` verifies the atomic `codes.consume` / `refreshTokens.revoke` rules any implementation must keep. For a quick start or a single-process server, `storage: memoryStore()` needs nothing at all.

Serve with any Web-standard server (`@hono/node-server`, `srvx`, Node 22's `http` + `Request` conversion, Bun.serve, Deno.serve).

### Next.js (App Router)

Route handlers receive Web `Request`s, so two catch-all routes are enough:

```ts
// app/api/notes/[...path]/route.ts  and  app/.well-known/[...path]/route.ts
import { mcp } from '@/lib/mcp-app-server';
const handle = async (request: Request) => (await mcp.fetch(request)) ?? new Response('Not found', { status: 404 });
export { handle as GET, handle as POST };
```

The consent page is an ordinary client component at `consentPath` (default `/oauth/authorize`) using `useAgentConsent` — see [`examples/consent-page.tsx`](../examples/consent-page.tsx). Storage on Vercel/Node can be `sqlStore` over `node:sqlite` or libsql/Turso, or your own `AppServerStore` over Postgres / Redis / KV.

### Accepting agent tokens on your existing API

Tools are often thin wrappers over REST endpoints you already have. Let those endpoints accept agent tokens next to your normal session:

```ts
const grant = await mcp.authenticate(request);   // null when the request carries no agt_ token
const user = grant ? { id: grant.ownerId, scopes: grant.scopes, agent: grant.clientName } : await sessionUser(request);
```

Then inside a tool, forward the caller's `Authorization` header: `fetch(origin + '/api/notes', { headers: { authorization: ctx.request.headers.get('authorization')! } })`. Scope checks, validation and tenancy stay in one place.

### Grant management UI

```ts
GET  /settings/agents      → mcp.listGrants(user.id)            // name, scopes, createdAt, lastUsedAt, expiresAt
POST /settings/agents/:id/revoke → mcp.revokeGrant(user.id, id) // 404 when the grant is not the user's
```

### Auditing

```ts
onEvent: async (event) => {
  // { type: 'authorized' | 'refreshed' | 'revoked', ownerId, grantId, clientId, clientName, scopes? }
  // { type: 'tool', ownerId, grantId, clientId, clientName, tool, ok }
  await env.DB.prepare('INSERT INTO audit(kind, owner, detail, at) VALUES (?1, ?2, ?3, ?4)').bind(event.type, event.ownerId, JSON.stringify(event), new Date().toISOString()).run();
},
```

Tool arguments and results are never passed to `onEvent`; log them in the tool handler if your data policy allows it.

### Local development

- `fixedIdentity('local')` skips login for a single-user workspace. Never expose it on a public origin.
- MCP clients register redirect URIs on `http://localhost:<random port>`; loopback ports are matched loosely (RFC 8252 §7.3) so every run works.
- When the API runs on a tunnel (`https://x.trycloudflare.com`) and the web app on `http://localhost:3000`, set `publicOrigin` to the tunnel and `webOrigin` to localhost; the consent page posts back to `basePath` on its own origin, so proxy `<basePath>/*` to the API in dev.

## 2. Connecting agent clients

A deployed host exposes one URL to share: `https://<publicOrigin><basePath>/mcp`. Every client below discovers the OAuth server from it, registers itself, opens the consent page and stores the tokens; users never copy secrets.

### Claude Code

```bash
claude mcp add --transport http notes https://notes.example.com/api/notes/mcp
```

Then `/mcp` inside Claude Code → select the server → **Authenticate**. Team-wide: commit a `.mcp.json`:

```json
{ "mcpServers": { "notes": { "type": "http", "url": "https://notes.example.com/api/notes/mcp" } } }
```

### Claude.ai and Claude Desktop

*Settings → Connectors → Add custom connector* → paste the MCP URL. Claude uses dynamic registration and the OAuth flow automatically. Organisation admins can add it once for the whole workspace. Listing in Claude's public connector directory is a separate manual submission (stable HTTPS URL, privacy policy, support contact).

### ChatGPT

*Settings → Connectors → Advanced → Developer mode* (or the *Apps SDK* developer settings) → **Create** → MCP server URL, authentication **OAuth**. ChatGPT registers dynamically and redirects to the consent page. Deep-research connectors additionally expect `search` and `fetch` tools; ordinary tool use has no such requirement.

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{ "mcpServers": { "notes": { "url": "https://notes.example.com/api/notes/mcp" } } }
```

Cursor shows a **Needs login** badge; clicking it opens the consent page.

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:

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

### Your own script (TypeScript)

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://notes.example.com/api/notes/mcp'), {
  authProvider,   // an OAuthClientProvider: stores client info + tokens, opens redirectUrl in a browser
});
const client = new Client({ name: 'my-script', version: '1.0.0' });
await client.connect(transport);            // throws UnauthorizedError the first time → run the OAuth flow, then reconnect
console.log(await client.listTools());
console.log(await client.callTool({ name: 'notes_list', arguments: {} }));
```

The SDK's `OAuthClientProvider` interface (`@modelcontextprotocol/sdk/client/auth.js`) handles discovery, dynamic registration and PKCE; you supply persistence and the browser hop. The server's end-to-end test drives the same flow with raw `fetch` in ~30 lines if you want a reference without the SDK: [`tests/worker.test.mjs`](../tests/worker.test.mjs).

### Raw HTTP walkthrough

```bash
BASE=https://notes.example.com/api/notes
curl -s $BASE/mcp/schema | jq .tools[].name                      # what the server offers
curl -s https://notes.example.com/.well-known/oauth-authorization-server | jq .
curl -s -X POST $BASE/oauth/register -H 'content-type: application/json' \
  -d '{"client_name":"curl","redirect_uris":["http://localhost:8976/cb"]}'
# open $BASE/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256
# approve → browser lands on redirect_uri?code=…
curl -s -X POST $BASE/oauth/token -d grant_type=authorization_code -d code=… -d code_verifier=… -d client_id=… -d redirect_uri=…
curl -s -X POST $BASE/mcp -H "authorization: Bearer agt_…" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"notes_list","arguments":{}}}'
```

### Listing in the official MCP Registry

```ts
// e.g. GET /api/notes/server.json in your app
return Response.json(mcp.serverJson(request, 'io.github.<github-user>', 'Your notes, readable by any MCP agent.'));
```

Save it as `server.json`, then:

```bash
mcp-publisher login github
mcp-publisher publish
```

The registry verifies the `io.github.<user>` namespace through GitHub login and reads the server metadata from the anonymous `initialize` / `tools/list` that this server already allows.

## 3. Checklist before going public

- [ ] `publicOrigin` is the final HTTPS hostname (tokens are bound to it).
- [ ] Write scopes only let agents write **their own artefacts**; primary user data stays read-only or behind an explicit opt-in scope (`default: false`).
- [ ] Every tool handler filters by `ctx.ownerId`; the end-to-end test's cross-tenant assertion is the pattern to copy.
- [ ] Consent page shows `clientName`, `destination` and each scope's `description`; the deny button works.
- [ ] Users can see and revoke grants (`listGrants` / `revokeGrant`).
- [ ] `onEvent` feeds an audit log.
- [ ] Rate limiting exists in front of `POST <base>/oauth/register` beyond the built-in per-IP throttle if you expect abuse.
