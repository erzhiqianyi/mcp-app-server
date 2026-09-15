# @erzhiqian/agent-gateway

[![npm](https://img.shields.io/npm/v/@erzhiqian/agent-gateway)](https://www.npmjs.com/package/@erzhiqian/agent-gateway)
[![CI](https://github.com/erzhiqianyi/agent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/erzhiqianyi/agent-gateway/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@erzhiqian/agent-gateway)](./LICENSE)

Expose **your existing app's users and data** to external AI agents (Claude, ChatGPT, Cursor, Claude Code, any MCP client) over standard **MCP + OAuth 2.1**. You do not integrate a model; users bring their own agent, read their data, work on it there, and write results back through tools you define.

[中文文档](./README.zh-CN.md) · [Integration guide](./docs/integration.md) · [Publishing](./docs/publishing.md) · [Changelog](./CHANGELOG.md)

- **Bring your own identity.** Your app already has a login (Firebase, Supabase, Auth0, Clerk, a session cookie, home-grown). You implement one function: `resolve(request) → { id }`.
- **The gateway is the OAuth authorization server.** MCP clients require dynamic client registration (RFC 7591), PKCE, resource indicators (RFC 8707), refresh-token rotation and per-agent revocation. Consumer identity providers rarely offer these, so this layer has to live in your app.
- **A scoped tool table is your product's agent surface.** Each tool declares the scope it needs; `tools/list` is trimmed to what the user actually granted.
- **Publicly discoverable.** `/.well-known/*`, `GET <basePath>/mcp/schema`, and anonymous `initialize` / `tools/list` need no token, so the server can be submitted to the official MCP Registry or a connector directory.
- Runs on Cloudflare Workers + D1 out of the box, or any SQLite driver that satisfies the tiny `SqlDatabase` interface.

## Install

```bash
npm install @erzhiqian/agent-gateway @modelcontextprotocol/sdk zod
```

Optional peers: `jose` (for `jwtIdentity` / `firebaseIdentity`) and `react` (for the `/react` consent hook). Node ≥ 22 or any Web-standard runtime (Cloudflare Workers, Deno, Bun).

## Quick start

```ts
import { z } from 'zod';
import { createAgentGateway, sessionIdentity } from '@erzhiqian/agent-gateway';

const gateway = createAgentGateway({
  name: 'notes',
  basePath: '/api/notes',                 // → /api/notes/mcp, /api/notes/mcp/schema, /api/notes/oauth/*
  consentPath: '/oauth/authorize',        // a page in your front end (see examples/consent-page.tsx)
  scopes: {
    'notes:read':  { description: 'Read your notes', required: true },
    'notes:write': { description: 'Attach AI summaries to notes', default: true },
  },
  identity: sessionIdentity(async (req) => await sessions.userFromCookie(req)), // { id } or null
  storage: env.NOTES_DB,                  // D1 (or any SqlDatabase)
  origins: { publicOrigin: 'https://notes.example.com', webOrigin: 'https://notes.example.com' },
  tools: [
    {
      name: 'notes_list',
      scope: 'notes:read',
      description: 'List the signed-in user’s notes.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async (_args, ctx) => ({ content: [{ type: 'text', text: JSON.stringify(await listNotes(ctx.ownerId)) }] }),
    },
    {
      name: 'notes_summarize',
      scope: 'notes:write',
      description: 'Store an agent-written summary for one note.',
      inputSchema: { id: z.string(), summary: z.string().max(500) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async ({ id, summary }, ctx) => { /* UPDATE … WHERE owner = ctx.ownerId */ },
    },
  ],
});

export default {
  async fetch(request: Request, env: Env) {
    await gateway.ensureSchema();                  // idempotent; four tables
    return (await gateway.fetch(request)) ?? app.fetch(request, env);
  },
};
```

Then connect an agent:

```bash
claude mcp add --transport http notes https://notes.example.com/api/notes/mcp
```

Claude Code opens the browser, your consent page shows the requested scopes, the user approves, and the agent receives a token bound to that user. A full runnable host lives in [`examples/cloudflare-worker`](./examples/cloudflare-worker); the same 60 lines back the end-to-end test in [`tests`](./tests).

## How it works

```
MCP client ──► GET /.well-known/oauth-protected-resource      (RFC 9728)
           ──► GET /.well-known/oauth-authorization-server    (RFC 8414)
           ──► POST <base>/oauth/register                     (RFC 7591, no token)
           ──► GET  <base>/oauth/authorize?…  ─302─► <webOrigin><consentPath>?…
                                                          │ your login + useAgentConsent()
                                                          ▼
           ◄─302 code ◄── POST <base>/oauth/approve       (host identity, never an agent token)
           ──► POST <base>/oauth/token  (PKCE)            → access_token agt_…, refresh_token agr_…
           ──► POST <base>/mcp  Authorization: Bearer agt_… → tools/list (scoped) / tools/call
```

Every access token is bound to `ownerId` + `clientId` + granted scopes + the audience `publicOrigin + mcpPath`. Tool handlers receive that verified context as `ctx`; nothing in `ctx` ever comes from tool input.

## Configuration

| Option | Required | Meaning |
| --- | --- | --- |
| `name` | yes | MCP server name; also used in `server.json`. |
| `basePath` | yes | Where all gateway routes hang: `<basePath>/mcp`, `<basePath>/mcp/schema`, `<basePath>/oauth/*`. |
| `scopes` | yes | Ordered scope catalogue. `required` scopes are always granted; `default` ones are pre-checked on the consent page. |
| `identity` | yes | `IdentityProvider` — see [Identity](#identity). |
| `tools` | yes | `AgentTool[]` — see [Tools](#tools). |
| `storage` | yes | `SqlDatabase` (D1 satisfies it directly). |
| `origins` | yes | `{ publicOrigin, webOrigin }` or a function of the request. `publicOrigin` is written into metadata and token audience; `webOrigin` hosts the consent page. |
| `consentPath` | no | Default `/oauth/authorize`. |
| `accessTokenDays` / `refreshTokenDays` | no | Default 30 / 90. |
| `tokenPrefix` | no | Default `agt_`. Lets your own routes recognise agent tokens. |
| `tables` | no | Override the four table names when adopting an existing schema. |
| `onEvent` | no | Audit hook: `authorized` / `refreshed` / `revoked` / `tool`. Never receives tool payloads. |
| `anonymousDiscovery` | no | Default `true`. Let `initialize` / `tools/list` answer without a token. |
| `contract` | no | Free-text (markdown) data contract published with the schema. |

### Identity

The only contract between your app and the gateway. `id` must be stable and never reused; every token is bound to it.

```ts
import { sessionIdentity, jwtIdentity, firebaseIdentity, fixedIdentity } from '@erzhiqian/agent-gateway';

sessionIdentity(async (req) => await sessions.userFromCookie(req));   // server-side sessions
jwtIdentity({ jwksUrl, issuer, audience });                             // Supabase, Auth0, Clerk, Cognito, any OIDC
firebaseIdentity(projectId);                                            // Firebase Authentication preset
fixedIdentity('local');                                                 // single-user / local dev only
```

Or implement `IdentityProvider` yourself: `{ resolve(request) => Promise<{ id, displayName?, email? }> }`, throwing `GatewayError(401, …)` when nobody is signed in.

### Tools

```ts
interface AgentTool {
  name: string;
  scope?: string;                 // omit for tools every authorised agent may use
  description: string;
  inputSchema: ZodRawShape;       // zod v4 shape; published as JSON Schema
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  handler(args, ctx: ToolContext): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}
interface ToolContext { ownerId; scopes; grantId; clientId; clientName; request }
```

If your tools are thin wrappers over an existing REST API, forward `ctx.request`'s `Authorization` header to your own handlers and let that layer accept agent tokens via `gateway.authenticate(request)`.

### Gateway API

```ts
gateway.fetch(request)                    // Response | null — mount first in your router
gateway.authenticate(request)             // AuthenticatedGrant | null — accept agent tokens on your own routes
gateway.carriesToken(request)             // cheap prefix check
gateway.listGrants(ownerId)               // which agents are connected, with what scopes, last used when
gateway.revokeGrant(ownerId, grantId)     // revoke a grant and its whole refresh chain
gateway.ensureSchema()                    // idempotent table setup
gateway.describe(request)                 // the public schema document
gateway.serverJson(request, 'io.github.you', 'One-line description')  // MCP Registry server.json
gateway.paths                             // { mcp, schema, oauth, consent }
```

### Consent page (React)

```tsx
import { useAgentConsent } from '@erzhiqian/agent-gateway/react';

const { client, chosen, toggle, decide, error, busy, destination, missingClient } = useAgentConsent({
  basePath: '/api/notes',
  authHeaders: () => ({ authorization: 'Bearer ' + session.token }), // or omit and rely on cookies
});
```

The hook is headless: render your own login and layout, map `client.scopeDetails` to checkboxes (`required` ones disabled), and call `decide('approve' | 'deny')`. See [`examples/consent-page.tsx`](./examples/consent-page.tsx). Non-React front ends can call `GET <base>/oauth/client` and `POST <base>/oauth/approve` directly.

## Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource[<mcpPath>]` | none | Resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | none | Authorization server metadata (RFC 8414) |
| `GET <base>/mcp/schema` | none | Server name, endpoint, scopes, JSON Schema of every tool |
| `POST <base>/mcp` (`initialize` / `ping` / `tools/list`) | none | Anonymous discovery; full tool list |
| `POST <base>/mcp` (anything else) | agent token | MCP Streamable HTTP |
| `POST <base>/oauth/register` | none (rate-limited) | Dynamic client registration |
| `GET <base>/oauth/authorize` | none | Validate, then 302 to the consent page |
| `GET <base>/oauth/client` | none | Client + scope descriptions for the consent page |
| `POST <base>/oauth/approve` | **host identity** | User approves/denies → authorization code |
| `POST <base>/oauth/token` | client | Code exchange, refresh rotation |

## Security model

- User identity comes only from `identity.resolve`; an agent token can never approve a grant.
- Authorization codes live 10 minutes and are single-use; replaying one revokes the tokens it issued.
- Refresh tokens rotate; replaying a rotated refresh token cuts the whole chain.
- Tokens are stored as SHA-256 only. Audience is `publicOrigin + mcpPath`, so moving domains invalidates old tokens.
- `tools/call` always requires a token; anonymous discovery exposes tool metadata, never data.
- Cross-site `Origin` headers on MCP requests are rejected (loopback excepted).
- Redirect URIs are classified as `loopback` / `custom` / `https`; anything else is refused at registration.

## Compared with Cloudflare `workers-oauth-provider`

It solves the same OAuth layer with KV storage. This package adds: D1/SQL storage, pluggable host identity, a scoped tool table, grant-trimmed `tools/list`, a public schema with anonymous discovery, a consent-page hook, grant management APIs and a reusable end-to-end test. If you only need OAuth and none of the above, use the official library.

## Development

```bash
npm install
npm run typecheck
npm test          # Miniflare end-to-end: register → authorize → consent → token → tool → refresh → revoke
npm run build     # emits dist/ (ESM + .d.ts)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/publishing.md](./docs/publishing.md).

## License

[MIT](./LICENSE)
