# npm への公開

[English](./publishing.md) · [中文](./publishing.zh-CN.md)

パッケージは `dist/` から ESM + `.d.ts` として配布されます。`npm pack` / `npm publish` は自動でビルドし（`prepack`）、`prepublishOnly` は型チェックかテストが失敗すると公開を拒否します。

## 一度だけの準備

1. **npm アカウントと scope。** パッケージ名は `@ninomae/mcp-app-server`。scope 付きの名前は、その scope を所有する npm ユーザーまたは組織しか公開できません。次のいずれか：
   - npm ユーザー名が `ninomae` である。または
   - <https://www.npmjs.com/org/create> で `ninomae` という無料組織を作る。または
   - パッケージ名を `@<あなたのnpmユーザー名>/mcp-app-server` に変える（`package.json` の `name`、および `README*.md`、`docs/`、`examples/` 内の import パス）。
2. **ローカルでサインイン**（公開には 2FA が必須）：
   ```bash
   npm login
   npm whoami
   ```
3. **GitHub リポジトリ。** `erzhiqianyi/mcp-app-server` を作る（または `package.json` の `repository` / `homepage` / `bugs` を変更）し、`main` を push。
4. **CI 用の公開クレデンシャル**、どちらか一つ：
   - **Trusted publishing（推奨。secret 不要）。** npmjs.com でパッケージを開く → *Settings* → *Trusted publishers* → GitHub Actions を追加。リポジトリ `erzhiqianyi/mcp-app-server`、ワークフロー `release.yml`。`.github/workflows/release.yml` には既に `id-token: write` 権限があるので、`NODE_AUTH_TOKEN` の行を削除するだけ。Trusted publishing は最初のバージョンが存在してから設定できるため、**初回の公開は手元のマシンで行います**（次節）。
   - **Automation token。** npmjs.com → *Access Tokens* → *Generate New Token* → *Granular*。`@ninomae/mcp-app-server` に read+write を付与し、"bypass 2FA" を有効化。リポジトリ secret `NPM_TOKEN` として保存。

## 初回リリース（手元のマシンから）

```bash
npm ci
npm run typecheck
npm test                 # まず dist/ をビルドし、Miniflare と node:sqlite の 2 スイートを実行
npm pack --dry-run       # 何がアップロードされるか確認：dist/、README*、LICENSE、CHANGELOG
npm publish --access public
```

確認：

```bash
npm view @ninomae/mcp-app-server version dist.tarball
mkdir /tmp/gw-check && cd /tmp/gw-check && npm init -y >/dev/null && npm i @ninomae/mcp-app-server @modelcontextprotocol/sdk zod
node -e "import('@ninomae/mcp-app-server').then(m => console.log(Object.keys(m)))"
```

ログインせずにパッケージの中身を見る場所：npmjs.com のパッケージページ（*Code* タブでファイルを閲覧可能）、<https://unpkg.com/@ninomae/mcp-app-server/>、<https://cdn.jsdelivr.net/npm/@ninomae/mcp-app-server/>（末尾の `/` でディレクトリ一覧）。

## 以降のリリース

1. `CHANGELOG.md` を更新（*Unreleased* の項目を新バージョンの下へ移す）。
2. バージョンを上げ、タグを打ち、push：
   ```bash
   npm version patch      # または minor / major — package.json を更新し、コミットし、vX.Y.Z タグを作る
   git push --follow-tags
   ```
3. `Release` ワークフローが `v*` タグで起動：typecheck → test → `npm publish --provenance --access public` → 生成ノート付き GitHub Release。Provenance は npm のバージョンを特定のコミットとワークフロー実行に紐づけます。CI からしか生成できないので、ローカル公開ではこのフラグを付けません。
4. npmjs.com の *Versions* タブと *Provenance* バッジを確認。

プレリリース：`npm version prerelease --preid beta` → `0.2.0-beta.0`。`npm install` が安定版を解決し続けるよう、`--tag next` で公開します。Release ワークフローは `latest` にしか公開しないので、beta は手元から `npm publish --tag next`。

## バージョン方針

セマンティックバージョニング。1.0 までは minor に破壊的変更が含まれることがあり、その場合は changelog に移行メモを書きます。破壊的変更とみなすもの：

- `McpAppServerConfig`、`AgentTool`、`ToolContext`、`IdentityProvider`、`AppServerStore` / `SqlDatabase` の形
- デフォルトのテーブルスキーマ（ホストは既に `ensureSchema` を実行しているので、変更には移行メモが必要）
- エンドポイントのパス、エラーコード、トークンのプレフィックス

## 依存関係

`@modelcontextprotocol/sdk` と `zod` は peer 依存で、実行するバージョンはホストが決めます。対応範囲を上げるときは `peerDependencies` と `devDependencies` の両方を更新し、テストを実行し、changelog に記載します。

## 取り下げ

公開から 72 時間以内で、他のパッケージが依存していなければ `npm unpublish @ninomae/mcp-app-server@X.Y.Z` が可能です。それ以降は修正版のパッチを公開し、問題のあるバージョンを `npm deprecate @ninomae/mcp-app-server@X.Y.Z "理由"` します。

## ホストを monorepo の workspace から npm パッケージへ切り替える

Career Note は当初このコードを `packages/agent-gateway` に置き、npm workspaces で `"@ninomae/mcp-app-server": "*"` を解決していました。初回リリース後：

```bash
git rm -r packages/agent-gateway
npm pkg delete workspaces
npm install @ninomae/mcp-app-server@^0.1.0
npm test && npm run typecheck
```

他は変更不要：import は既に `@ninomae/mcp-app-server` と `@ninomae/mcp-app-server/react` です。公開前は workspace のコピーを残しておいてください——`file:` や `github:` 依存は、隣に checkout が無いマシン（CI など）でインストールに失敗します。
