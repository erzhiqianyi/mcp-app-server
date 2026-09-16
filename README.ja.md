# @ninomae/mcp-app-server

**既存のアプリを、OAuth 2.1 で保護された MCP サーバーにする。**

[English](./README.md) · [中文](./README.zh-CN.md) · [導入ガイド](./docs/integration.ja.md) · [公開手順](./docs/publishing.ja.md) · [変更履歴](./CHANGELOG.md)

**既存アプリのユーザーとデータ**を、標準の **MCP + OAuth 2.1** で外部 AI エージェント（Claude、ChatGPT、Cursor、Claude Code、任意の MCP クライアント）に開放します。モデルを自分で組み込む必要はありません。ユーザーは自分のエージェントを連れてきて、自分のデータを読み、エージェント側で分析し、あなたが定義した書き込みツールで結果をアプリへ戻します。

- **ID はどのベンダーにも縛られない。** アプリには既にログインがあるはず（Firebase / Supabase / Auth0 / Clerk / セッション Cookie / 自前）。実装するのは `resolve(request) → { id }` の一関数だけ。
- **本パッケージ自身が OAuth 認可サーバー。** MCP クライアントが要求する動的クライアント登録（RFC 7591）、PKCE、リソースインジケーター（RFC 8707）、リフレッシュトークンのローテーション、エージェント単位の失効は、一般向け IdP にはまず無い機能なので、この層はアプリ側に置く必要があります。
- **ツール表 = プロダクトのエージェント向け窓口。** 各ツールは必要な scope を宣言し、`tools/list` はユーザーが実際に許可した範囲に絞られます。
- **公開ディスカバリ。** `/.well-known/*`、`GET <basePath>/mcp/schema`、匿名の `initialize` / `tools/list` はトークン不要なので、公式 MCP Registry や Claude のコネクタディレクトリにそのまま提出できます。
- **データベースに縛られない。** コアはどの DB 実装にも依存しません。小さな `AppServerStore` インターフェースを実装すれば SQL、KV、Redis、Mongo、任意の ORM が使えます。同梱は `memoryStore()`（開発・テスト用）と `sqlStore()`（Cloudflare D1 と各種 SQLite ドライバ）。

## インストール

```bash
npm install @ninomae/mcp-app-server @modelcontextprotocol/sdk zod
```

任意の peer 依存：`jose`（`jwtIdentity` / `firebaseIdentity` を使う場合）、`react`（`/react` の同意画面 hook を使う場合）。Node ≥ 22、または Web 標準ランタイム（Cloudflare Workers、Deno、Bun）。

## 導入 7 ステップ

### 1. scope を決める

```ts
scopes: {
  'notes:read':  { description: 'ノートを読む', required: true },      // 固定。常に付与される
  'notes:write': { description: 'ノートに AI 要約を付ける', default: true }, // 同意画面で初期チェック済み
}
```

`description` は `GET <basePath>/oauth/client` 経由で同意画面に渡されます。読み取り 1 つ・書き込み 1 つから始めるのが目安。書き込み scope はエージェント**自身の成果物**だけを書かせ、ユーザーの主データは触らせないでください。

### 2. ID を実装する

```ts
import { sessionIdentity, jwtIdentity, firebaseIdentity, fixedIdentity } from '@ninomae/mcp-app-server';

// サーバー側セッション（NextAuth、Rails、Django、Laravel、自前 Cookie）
identity: sessionIdentity(async (req) => await mySessions.userFromCookie(req))   // { id } または null を返す

// フロントエンドが JWT を持つ（Supabase、Auth0、Clerk、Cognito… 任意の OIDC）
identity: jwtIdentity({ jwksUrl, issuer, audience })

// Firebase プリセット
identity: firebaseIdentity(env.FIREBASE_PROJECT_ID)

// シングルユーザー / ローカル開発（公開オリジンの背後には絶対に置かない）
identity: fixedIdentity('local')
```

契約は一つだけ：`id` は安定していて再利用されないこと。以降すべてのエージェントトークンはこの id に紐づき、ツールハンドラが受け取る `ctx.ownerId` がそれです。

### 3. ツールを定義する

```ts
import { z } from 'zod';

tools: [
  {
    name: 'notes_list',
    scope: 'notes:read',
    description: 'サインイン中ユーザーのノート一覧。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) => ({ content: [{ type: 'text', text: JSON.stringify(await listNotes(ctx.ownerId)) }] }),
  },
  {
    name: 'notes_summarize',
    scope: 'notes:write',
    description: 'エージェントが書いた要約を 1 件のノートに保存する。要約のみ。本文は変更しない。',
    inputSchema: { id: z.string(), summary: z.string().max(500) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async ({ id, summary }, ctx) => { /* UPDATE … WHERE owner = ctx.ownerId */ },
  },
]
```

`ctx` には `ownerId / scopes / grantId / clientId / clientName / request` が入ります。すべて検証済みトークン由来で、ツール入力からは決して取りません。ツールが既存 REST API の薄いラッパーなら、`ctx.request` の `Authorization` ヘッダーを自分のハンドラへ転送し、REST 層では `mcp.authenticate(request)` でエージェントトークンを受け付けてください。

### 4. サーバーを作りルーティングに載せる

```ts
import { createMcpAppServer } from '@ninomae/mcp-app-server';
import { sqlStore } from '@ninomae/mcp-app-server/sql';

const mcp = createMcpAppServer({
  name: 'notes',
  basePath: '/api/notes',           // → /api/notes/mcp, /api/notes/mcp/schema, /api/notes/oauth/*
  consentPath: '/oauth/authorize',  // あなたのフロントエンドのページ
  scopes, identity, tools,
  storage: sqlStore(env.NOTES_DB),  // または memoryStore()、または自前の AppServerStore
  origins: { publicOrigin: 'https://notes.example.com', webOrigin: 'https://notes.example.com' },
  onEvent: (e) => audit.write(e),   // authorized / refreshed / revoked / tool（payload は含まない）
});

export default {
  async fetch(request, env) {
    await mcp.ensureSchema();               // 冪等。store に委譲
    const handled = await mcp.fetch(request);
    if (handled) return handled;                // well-known / oauth / mcp / schema
    // …既存のルーティング
  },
};
```

**ストレージ。** 本パッケージは登録済みクライアント、使い捨て認可コード、リフレッシュトークンの連鎖、アクセストークンを記憶する必要があります（秘密値は常に SHA-256 のみ保存）。それらへのアクセスは、プレーンオブジェクトのリポジトリである `AppServerStore` インターフェースだけを通ります：

```ts
interface AppServerStore {
  clients:       { create; get; touch };
  codes:         { create; get; consume /* アトミック。最初の呼び出し元だけが true */; setIssuedToken };
  refreshTokens: { create; get; getByAccessToken; revoke /* アトミック */; revokeByAccessToken; setSuccessor };
  accessTokens:  { create; get; getByHash; listByOwner; touch; revoke };
  prune?(now): Promise<void>;        // 任意：期限切れ code / refresh token の掃除
  ensureSchema?(): Promise<void>;    // 任意：冪等なテーブル作成。mcp.ensureSchema() に対応
}
```

同梱実装は 2 つ：`memoryStore()`（Map。開発・テスト・単一プロセス向け）と `@ninomae/mcp-app-server/sql` の `sqlStore(db, tables?)`（D1 はそのまま渡せる。node:sqlite / better-sqlite3 / libsql は 10 行のアダプタで）。Postgres、Redis、KV、Mongo、Prisma、Drizzle に繋ぐならこのインターフェースを自分で実装します（約 150 行。[`src/store.ts`](./src/store.ts) が参照実装）。「アトミック」と書いた 2 メソッドがリプレイ防止の要で、`codes.consume` と `refreshTokens.revoke` は必ずちょうど一人の呼び出し元にだけ `true` を返す必要があります。[`tests/memory-store.test.mjs`](./tests/memory-store.test.mjs) をコピーして store を差し替えれば検証できます。

**登録のレート制限。** `POST /oauth/register` は認証不要でストレージに書くため、レート制限がかかります。ストレージ同様、契約だけを定義します：`registrationLimit: { limiter: { allow(key) => Promise<boolean> }, key?: (request) => string }`、`false` で無効化。デフォルトは `memoryRateLimiter()`（IP ごと 1 時間 20 回、プロセス内カウント）で、単一プロセスのサーバーでは正しく動きますが、**Workers / Lambda などマルチインスタンス環境では効きません**。プラットフォームの共有カウンタに繋いでください。例：Cloudflare の rate-limiting binding なら `{ limiter: { allow: async (key) => (await env.REGISTER_LIMIT.limit({ key })).success } }`。

その他のオプション：`accessTokenDays`（既定 30）、`refreshTokenDays`（既定 90）、`tokenPrefix`（既定 `agt_`。自分のルートでエージェントトークンを見分けるため）、`anonymousDiscovery`（既定 true）、`contract`（schema と一緒に公開するデータ契約の markdown）。

### 5. 同意画面

認可サーバーはユーザーを `webOrigin + consentPath` へ 302 します（クエリはそのまま）。ページでは自分のログインを使い、残りは headless hook に任せます：

```tsx
import { useAgentConsent } from '@ninomae/mcp-app-server/react';

const { client, chosen, toggle, decide, error, busy, destination, missingClient } = useAgentConsent({
  basePath: '/api/notes',
  authHeaders: () => ({ authorization: 'Bearer ' + session.token }), // Cookie 運用なら省略可
});
// client.scopeDetails → チェックボックスを描画（required は無効化）。decide('approve' | 'deny') でエージェントへ戻る
```

完全な例は [`examples/consent-page.tsx`](./examples/consent-page.tsx)。React 以外のフロントエンドは `GET <base>/oauth/client` と `POST <base>/oauth/approve` を直接呼べば十分です。

### 6. ユーザーに許可を管理させる

```ts
mcp.listGrants(ownerId)             // どのエージェントが、どの権限で、いつ最後に使ったか
mcp.revokeGrant(ownerId, grantId)   // 失効させ、リフレッシュの連鎖ごと切る
```

### 7. 検証と公開

- `npm test` の Miniflare エンドツーエンド（登録 → 認可 → 同意 → トークン交換 → ツール呼び出し → リフレッシュ → 失効）がテンプレート。フィクスチャは `tests/fixtures/notes-host.ts`、60 行で完全なホストです。
- 実際に繋ぐ：`claude mcp add --transport http notes https://notes.example.com/api/notes/mcp`、その後 Claude Code で `/mcp` → Authenticate。
- `mcp.serverJson(request, 'io.github.<you>', '一行の説明')` が公式 MCP Registry 用の `server.json` を生成します。`mcp-publisher publish` で掲載。Claude / ChatGPT のコネクタディレクトリは別途手動申請（固定 HTTPS URL、プライバシーポリシー）。

各クライアント（Claude Code、Claude.ai、ChatGPT、Cursor、自作スクリプト）の具体的な接続手順は [docs/integration.ja.md](./docs/integration.ja.md) を参照。

## エンドポイント一覧

| パス | 認証 | 役割 |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource[<mcpPath>]` | なし | リソースメタデータ（RFC 9728） |
| `GET /.well-known/oauth-authorization-server` | なし | 認可サーバーメタデータ（RFC 8414） |
| `GET <base>/mcp/schema` | なし | サーバー名、エンドポイント、scope、全ツールの JSON Schema |
| `POST <base>/mcp`（`initialize`/`ping`/`tools/list`） | なし | 匿名ディスカバリ。全ツールを返す |
| `POST <base>/mcp`（その他） | エージェントトークン | MCP Streamable HTTP |
| `POST <base>/oauth/register` | なし（レート制限あり） | 動的クライアント登録 |
| `GET <base>/oauth/authorize` | なし | 検証後、同意画面へ 302 |
| `GET <base>/oauth/client` | なし | 同意画面がクライアント情報と scope 説明を取得 |
| `POST <base>/oauth/approve` | **ホストの ID** | ユーザーの許可/拒否 → 認可コード |
| `POST <base>/oauth/token` | クライアント | コード交換、リフレッシュのローテーション |

## 本パッケージがやらないこと

これは橋渡しであって、権限システムではありません。あるユーザーがあるレコードを見てよいかは一切判断しません。`ctx.ownerId` は検証済みのユーザーであり、ハンドラはそれを使って**既存の**ルールを実行します——この id を渡してサービス層を直接呼ぶか、`ctx.request` の `Authorization` ヘッダーを付けて自分の REST API を呼び返し、そこで `mcp.authenticate()` でユーザーを識別すれば、残りはブラウザセッションと全く同じです。scope は「権限」ではなく「委任」です。*このエージェントが*ユーザーの代わりにできることを狭めるだけで、`scopes` は丸ごと省略もできます（暗黙の scope が 1 つ使われ、同意画面は単純な許可/拒否になります）。

## セキュリティ境界

- ユーザー ID は `identity.resolve` からのみ。エージェントトークンで approve はできない。
- 認可コードは 10 分・使い捨て。リプレイすると、そのコードが発行したトークンを失効させる。リフレッシュはローテーションし、ローテーション済みリフレッシュのリプレイは連鎖全体を切る。
- トークンは SHA-256 のみ保存。audience は `publicOrigin + mcpPath` に紐づき、ドメインを変えると旧トークンは自動で失効。
- `tools/call` は常にトークン必須。匿名ディスカバリが晒すのはツールのメタデータだけで、データは晒さない。
- クロスサイト `Origin` の MCP リクエストは拒否（loopback を除く）。
- redirect_uri は loopback / カスタムスキーム / https のみ受け付け、それ以外は登録時点で拒否。

## Cloudflare `workers-oauth-provider` との違い

同じ層の OAuth 問題を KV ストレージで解くものです。本パッケージはそれに加えて、差し替え可能なストレージ（D1 を含む任意の DB）、差し替え可能なホスト ID、scope 付きツール表、許可に応じて絞られる `tools/list`、公開 schema と匿名ディスカバリ、同意画面 hook、許可管理 API、再利用できるエンドツーエンドテストを提供します。OAuth だけ必要で上記のどれも要らないなら、公式ライブラリで十分です。

## 開発

```bash
npm install
npm run typecheck
npm test          # Miniflare エンドツーエンド
npm run build     # dist/ を生成（ESM + .d.ts）
```

npm への公開手順は [docs/publishing.ja.md](./docs/publishing.ja.md)。

## ライセンス

[MIT](./LICENSE)
