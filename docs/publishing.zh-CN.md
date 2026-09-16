# 发布到 npm

[English](./publishing.md)

包以 ESM + `.d.ts` 的形式从 `dist/` 发布。`npm pack` / `npm publish` 会自动构建（`prepack`），`prepublishOnly` 在类型检查或测试失败时拒绝发布。

## 一次性准备

1. **npm 账号与 scope。** 包名是 `@ninomae/mcp-app-server`。带 scope 的包只能由拥有该 scope 的 npm 用户或组织发布，所以三选一：
   - 你的 npm 用户名就是 `ninomae`；或
   - 在 <https://www.npmjs.com/org/create> 免费创建一个叫 `ninomae` 的组织；或
   - 把包改名为 `@<你的npm用户名>/mcp-app-server`（改 `package.json` 的 `name`，以及 `README*.md`、`docs/`、`examples/` 里的 import 路径）。
2. **本机登录**（发布必须开 2FA）：
   ```bash
   npm login
   npm whoami
   ```
3. **GitHub 仓库。** 创建 `erzhiqianyi/mcp-app-server`（或改 `package.json` 里的 `repository` / `homepage` / `bugs`），推送 `main`。
4. **CI 发布凭据**，二选一：
   - **Trusted publishing（推荐，不需要 secret）。** npmjs.com 打开包 → *Settings* → *Trusted publishers* → 添加 GitHub Actions，仓库 `erzhiqianyi/mcp-app-server`，workflow `release.yml`。`.github/workflows/release.yml` 已带 `id-token: write` 权限；把 `NODE_AUTH_TOKEN` 那一行删掉即可。Trusted publishing 要在第一个版本存在之后才能配置，所以**第一次发布在本机做**（下一节）。
   - **Automation token。** npmjs.com → *Access Tokens* → *Generate New Token* → *Granular*，对 `@ninomae/mcp-app-server` 授 read+write，勾选 "bypass 2FA"。存为仓库 secret `NPM_TOKEN`。

## 第一次发布（本机）

```bash
npm ci
npm run typecheck
npm test                 # 先构建 dist/，再跑 Miniflare 与 node:sqlite 两套测试
npm pack --dry-run       # 看清楚会上传什么：dist/、README*、LICENSE、CHANGELOG
npm publish --access public
```

验证：

```bash
npm view @ninomae/mcp-app-server version dist.tarball
mkdir /tmp/gw-check && cd /tmp/gw-check && npm init -y >/dev/null && npm i @ninomae/mcp-app-server @modelcontextprotocol/sdk zod
node -e "import('@ninomae/mcp-app-server').then(m => console.log(Object.keys(m)))"
```

## 之后每次发布

1. 更新 `CHANGELOG.md`（把 *Unreleased* 下的条目挪到新版本号下）。
2. 升版本、打 tag、推送：
   ```bash
   npm version patch      # 或 minor / major —— 改 package.json、提交、打 vX.Y.Z tag
   git push --follow-tags
   ```
3. `Release` workflow 在 `v*` tag 上触发：typecheck → test → `npm publish --provenance --access public` → 自动生成 GitHub Release。Provenance 会把 npm 版本和具体 commit / workflow run 绑定，只能在 CI 里生成，所以本机发布不带这个参数。
4. 到 npmjs.com 的 *Versions* 页确认，并检查 *Provenance* 标记。

预发布：`npm version prerelease --preid beta` → `0.2.0-beta.0`，本机 `npm publish --tag next` 发布，这样 `npm install` 默认仍解析到稳定版。Release workflow 只发 `latest`。

## 版本策略

语义化版本。1.0 之前 minor 可能包含破坏性变更，会在 changelog 里写迁移说明。以下算破坏性变更：

- `McpAppServerConfig`、`AgentTool`、`ToolContext`、`IdentityProvider`、`SqlDatabase` 的形状
- 默认表结构（宿主已经跑过 `ensureSchema`，改这里必须附迁移说明）
- 端点路径、错误码、token 前缀

## 依赖

`@modelcontextprotocol/sdk` 与 `zod` 是 peer 依赖，版本由宿主控制。调整支持范围时同时改 `peerDependencies` 和 `devDependencies`，跑测试，写进 changelog。

## 撤回

发布 72 小时内且没有其他包依赖时可以 `npm unpublish @ninomae/mcp-app-server@X.Y.Z`。超过之后，发一个修复版本并 `npm deprecate @ninomae/mcp-app-server@X.Y.Z "原因"`。

## 把宿主从 monorepo workspace 切到 npm 包

Career Note 原来把代码放在 `packages/agent-gateway`，通过 npm workspaces 解析 `"@ninomae/mcp-app-server": "*"`。第一次发布之后：

```bash
git rm -r packages/agent-gateway
npm pkg delete workspaces
npm install @ninomae/mcp-app-server@^0.1.0
npm test && npm run typecheck
```

其他不用动：import 早已是 `@ninomae/mcp-app-server` 和 `@ninomae/mcp-app-server/react`。在发布之前保留 workspace 副本——`file:` 或 `github:` 依赖会让没有同级 checkout 的机器（比如 CI）装不上。
