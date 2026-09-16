# 導入ガイド

[English](./integration.md) · [中文](./integration.zh-CN.md)

読者は二種類：本パッケージを組み込む**ホストアプリ**（第 1 節）と、ホスト公開後に接続する**エージェントクライアント**（第 2 節）。

## 1. アプリに本パッケージを組み込む

本パッケージは `fetch(Request) → Response | null` という一関数と、DB に縛られないストレージインターフェース（`AppServerStore`）だけで、Web 標準の `Request`/`Response` があるランタイムならどこでも動きます。自分のルーティングの**前**に置き、次のパスを本パッケージに取らせます：

- `/.well-known/oauth-protected-resource[<mcpPath>]`、`/.well-known/oauth-authorization-server`
- `<basePath>/mcp`、`<basePath>/mcp/schema`
- `<basePath>/oauth/register|authorize|client|approve|token`

それ以外のパスは `null` を返してあなたに戻します。

### Cloudflare Workers + D1

`@ninomae/mcp-app-server/sql` の `sqlStore` で D1 バインディングを包むだけです。完全なホストは [`examples/cloudflare-worker/worker.ts`](../examples/cloudflare-worker/worker.ts)。

```ts
export default {
  async fetch(request, env) {
    const mcp = createMcpAppServerFor(env);      // createMcpAppServer({ …, storage: sqlStore(env.DB) })
    await mcp.ensureSchema();
    return (await mcp.fetch(request)) ?? app(request, env);
  },
};
```

一つの Worker で複数ホスト名を扱う場合や開発時にトンネルを使う場合、`origins` は関数にできます：

```ts
origins: (request) => {
  const origin = new URL(request.url).origin;
  return { publicOrigin: env.PUBLIC_ORIGIN || origin, webOrigin: env.WEB_ORIGIN || origin };
},
```

`publicOrigin` は安定させてください。トークンの audience なので、変えると発行済みトークンがすべて無効になります。

### Hono（Workers / Node / Bun / Deno）

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

### Node.js + 組み込み `node:sqlite`

Node ≥ 22.5 ならネイティブモジュール不要。以下のアダプタは `tests/node-sqlite.test.mjs` で実際に動かしているものです：

```ts
import { DatabaseSync } from 'node:sqlite';
import { sqlStore, type SqlDatabase } from '@ninomae/mcp-app-server/sql';

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

あとは `storage: sqlStore(nodeSqlite(db))`。`better-sqlite3`、`libsql`、`sql.js` も同じ包み方です。アダプタが使うのは `?1 … ?n` の位置プレースホルダ、`first()`、`all()`、`run().meta.changes` だけ。

### その他任意のデータベース

`AppServerStore` を直接実装します——小さなリポジトリ 4 つ、レコードはプレーンオブジェクト、SQL は関係ありません。`src/store.ts` の `memoryStore()` が参照実装で、`tests/memory-store.test.mjs` はどの実装でも守るべきアトミックな `codes.consume` / `refreshTokens.revoke` の規則を検証します。手早く試す・単一プロセスで運用するなら `storage: memoryStore()` で何も要りません。

HTTP 層は Web 標準サーバーなら何でも（`@hono/node-server`、`srvx`、Bun.serve、Deno.serve）。

### Next.js（App Router）

Route handler が受け取るのは Web `Request` なので、catch-all ルート 2 つで足ります：

```ts
// app/api/notes/[...path]/route.ts  と  app/.well-known/[...path]/route.ts
import { mcp } from '@/lib/mcp-app-server';
const handle = async (request: Request) => (await mcp.fetch(request)) ?? new Response('Not found', { status: 404 });
export { handle as GET, handle as POST };
```

同意画面は `consentPath`（既定 `/oauth/authorize`）に置く普通のクライアントコンポーネントで、`useAgentConsent` を使います——[`examples/consent-page.tsx`](../examples/consent-page.tsx) 参照。Vercel/Node 上のストレージは `sqlStore` + `node:sqlite` か libsql/Turso、あるいは Postgres / Redis / KV で自作した `AppServerStore`。

### 既存 API にエージェントトークンを受け付けさせる

ツールは往々にして既存 REST エンドポイントの薄いラッパーです。それらのエンドポイントに、通常のセッションに加えてエージェントトークンも受け付けさせます：

```ts
const grant = await mcp.authenticate(request);   // agt_ トークンが無いリクエストでは null
const user = grant ? { id: grant.ownerId, scopes: grant.scopes, agent: grant.clientName } : await sessionUser(request);
```

ツール内では呼び出し元の `Authorization` ヘッダーをそのまま転送します：`fetch(origin + '/api/notes', { headers: { authorization: ctx.request.headers.get('authorization')! } })`。scope チェック、検証、テナント分離は一か所に留まります。

### 許可管理 UI

```ts
GET  /settings/agents      → mcp.listGrants(user.id)            // name、scopes、createdAt、lastUsedAt、expiresAt
POST /settings/agents/:id/revoke → mcp.revokeGrant(user.id, id) // そのユーザーの許可でなければ 404
```

### 監査

```ts
onEvent: async (event) => {
  // { type: 'authorized' | 'refreshed' | 'revoked', ownerId, grantId, clientId, clientName, scopes? }
  // { type: 'tool', ownerId, grantId, clientId, clientName, tool, ok }
  await env.DB.prepare('INSERT INTO audit(kind, owner, detail, at) VALUES (?1, ?2, ?3, ?4)').bind(event.type, event.ownerId, JSON.stringify(event), new Date().toISOString()).run();
},
```

ツールの引数と結果は `onEvent` に渡されません。データポリシーが許すなら、ツールハンドラ内で自分で記録してください。

### ローカル開発

- `fixedIdentity('local')` はログインをスキップします。シングルユーザーのワークスペース向け。公開オリジンには絶対に晒さないこと。
- MCP クライアントが登録する redirect URI は `http://localhost:<ランダムポート>`。loopback のポートは RFC 8252 §7.3 に従い緩く照合するので、毎回通ります。
- API がトンネル（`https://x.trycloudflare.com`）、Web が `http://localhost:3000` の場合は `publicOrigin` をトンネル、`webOrigin` を localhost に。同意画面は自分のオリジン上の `basePath` にリクエストするので、開発環境では `<basePath>/*` を API にプロキシしてください。

## 2. エージェントクライアントを接続する

ホスト公開後に共有する URL は一つだけ：`https://<publicOrigin><basePath>/mcp`。以下のどのクライアントも、そこから OAuth サーバーを発見し、自動登録し、同意画面を開き、トークンを保存します。ユーザーが秘密値をコピーすることはありません。

### Claude Code

```bash
claude mcp add --transport http notes https://notes.example.com/api/notes/mcp
```

その後 Claude Code 内で `/mcp` → サーバーを選択 → **Authenticate**。チームで共有するなら `.mcp.json` をコミット：

```json
{ "mcpServers": { "notes": { "type": "http", "url": "https://notes.example.com/api/notes/mcp" } } }
```

### Claude.ai と Claude Desktop

*Settings → Connectors → Add custom connector* → MCP URL を貼り付け。Claude は動的登録と OAuth を自動で行います。組織管理者はワークスペース全体に一度で追加できます。Claude の公開コネクタディレクトリへの掲載は別途手動申請（固定 HTTPS URL、プライバシーポリシー、サポート連絡先）。

### ChatGPT

*Settings → Connectors → Advanced → Developer mode*（または *Apps SDK* の開発者設定）→ **Create** → MCP URL、認証は **OAuth**。ChatGPT は動的登録して同意画面へリダイレクトします。Deep research 用コネクタはさらに `search` と `fetch` ツールを要求しますが、通常のツール利用にその要件はありません。

### Cursor

`.cursor/mcp.json`（プロジェクト）または `~/.cursor/mcp.json`（グローバル）：

```json
{ "mcpServers": { "notes": { "url": "https://notes.example.com/api/notes/mcp" } } }
```

Cursor に **Needs login** バッジが出るので、クリックすると同意画面が開きます。

### VS Code（GitHub Copilot エージェントモード）

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

### 自作スクリプト（TypeScript）

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://notes.example.com/api/notes/mcp'), {
  authProvider,   // OAuthClientProvider：クライアント情報とトークンを保存し、redirectUrl をブラウザで開く
});
const client = new Client({ name: 'my-script', version: '1.0.0' });
await client.connect(transport);            // 初回は UnauthorizedError → OAuth を完了して再接続
console.log(await client.listTools());
console.log(await client.callTool({ name: 'notes_list', arguments: {} }));
```

SDK の `OAuthClientProvider`（`@modelcontextprotocol/sdk/client/auth.js`）がディスカバリ、動的登録、PKCE を担当し、あなたは永続化とブラウザ遷移だけ用意します。SDK に依存したくなければ、本パッケージのエンドツーエンドテストが生の `fetch` 約 30 行で同じフローを通しています：[`tests/worker.test.mjs`](../tests/worker.test.mjs)。

### 生の HTTP で一巡する

```bash
BASE=https://notes.example.com/api/notes
curl -s $BASE/mcp/schema | jq .tools[].name                      # サーバーが提供するもの
curl -s https://notes.example.com/.well-known/oauth-authorization-server | jq .
curl -s -X POST $BASE/oauth/register -H 'content-type: application/json' \
  -d '{"client_name":"curl","redirect_uris":["http://localhost:8976/cb"]}'
# ブラウザで $BASE/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256 を開く
# 同意すると redirect_uri?code=… に着地
curl -s -X POST $BASE/oauth/token -d grant_type=authorization_code -d code=… -d code_verifier=… -d client_id=… -d redirect_uri=…
curl -s -X POST $BASE/mcp -H "authorization: Bearer agt_…" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"notes_list","arguments":{}}}'
```

### 公式 MCP Registry への掲載

```ts
// 例：アプリ内で GET /api/notes/server.json を提供
return Response.json(mcp.serverJson(request, 'io.github.<githubユーザー名>', '一行の説明'));
```

`server.json` として保存し：

```bash
mcp-publisher login github
mcp-publisher publish
```

Registry は GitHub ログインで `io.github.<user>` 名前空間を検証し、本パッケージが既に許可している匿名の `initialize` / `tools/list` からサーバーメタデータを読み取ります。

## 3. 公開前チェックリスト

- [ ] `publicOrigin` が最終的な HTTPS ホスト名になっている（トークンはこれに紐づく）。
- [ ] 書き込み scope はエージェント**自身の成果物**だけを書かせる。ユーザーの主データは読み取り専用か、明示的なオプトイン scope（`default: false`）の後ろに置く。
- [ ] すべてのツールハンドラが `ctx.ownerId` でフィルタしている。エンドツーエンドテストのクロステナント assertion が写すべきパターン。
- [ ] 同意画面が `clientName`、`destination`、各 scope の `description` を表示し、拒否ボタンが動く。
- [ ] ユーザーが許可を確認・失効できる（`listGrants` / `revokeGrant`）。
- [ ] `onEvent` が監査ログに繋がっている。
- [ ] 悪用が予想されるなら、組み込みの IP 別スロットルに加えて `POST <base>/oauth/register` の前段にもう一層レート制限を置く。
