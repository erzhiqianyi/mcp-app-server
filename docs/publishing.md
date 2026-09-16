# Publishing to npm

[中文](./publishing.zh-CN.md) · [日本語](./publishing.ja.md)

The package ships as ESM + `.d.ts` from `dist/`. `npm pack` / `npm publish` build automatically (`prepack`), and `prepublishOnly` refuses to publish if the typecheck or the test suite fails.

## One-time setup

1. **npm account and scope.** The package name is `@ninomae/mcp-app-server`. A scoped name can only be published by the npm user or organisation that owns the scope, so either
   - your npm username is `ninomae`, or
   - create a free organisation called `ninomae` at <https://www.npmjs.com/org/create>, or
   - rename the package (`name` in `package.json`, the `import` paths in `README*.md`, `docs/`, `examples/`) to `@<your-npm-username>/mcp-app-server`.
2. **Sign in locally** (2FA is required for publishing):
   ```bash
   npm login
   npm whoami
   ```
3. **GitHub repository.** Create `erzhiqianyi/mcp-app-server` (or adjust `repository`, `homepage`, `bugs` in `package.json`) and push `main`.
4. **Release credentials for CI**, one of:
   - **Trusted publishing (recommended, no secret).** On npmjs.com open the package → *Settings* → *Trusted publishers* → add GitHub Actions with repository `erzhiqianyi/mcp-app-server` and workflow `release.yml`. The `id-token: write` permission in `.github/workflows/release.yml` is already there; remove the `NODE_AUTH_TOKEN` line. Trusted publishing is only available after the first version exists, so the very first publish is done from your machine (next section).
   - **Automation token.** npmjs.com → *Access Tokens* → *Generate New Token* → *Granular*, packages & scopes: read+write on `@ninomae/mcp-app-server`, and enable "bypass 2FA". Store it as the repository secret `NPM_TOKEN`.

## First release (from your machine)

```bash
npm ci
npm run typecheck
npm test                 # builds dist/ first, then runs the Miniflare and node:sqlite suites
npm pack --dry-run       # inspect exactly what will be uploaded: dist/, README*, LICENSE, CHANGELOG
npm publish --access public
```

Verify:

```bash
npm view @ninomae/mcp-app-server version dist.tarball
mkdir /tmp/gw-check && cd /tmp/gw-check && npm init -y >/dev/null && npm i @ninomae/mcp-app-server @modelcontextprotocol/sdk zod
node -e "import('@ninomae/mcp-app-server').then(m => console.log(Object.keys(m)))"
```

## Every later release

1. Update `CHANGELOG.md` (move items from *Unreleased* under the new version).
2. Bump, tag and push:
   ```bash
   npm version patch      # or minor / major — updates package.json, commits, creates tag vX.Y.Z
   git push --follow-tags
   ```
3. The `Release` workflow runs on the `v*` tag: typecheck → test → `npm publish --provenance --access public` → GitHub Release with generated notes. Provenance links the npm version to the exact commit and workflow run; it is only available from CI, which is why local publishes omit the flag.
4. Check the *Versions* tab on npmjs.com and the *Provenance* badge.

Pre-releases: `npm version prerelease --preid beta` → `0.2.0-beta.0`, and publish with `--tag next` so `npm install` keeps resolving to the stable line. The release workflow publishes to `latest`; for a beta, publish from your machine with `npm publish --tag next`.

## Versioning policy

Semantic versioning. Until 1.0, minor bumps may contain breaking changes and are called out in the changelog with a migration note. Things that count as breaking:

- `McpAppServerConfig`, `AgentTool`, `ToolContext`, `IdentityProvider`, `SqlDatabase` shapes
- default table schema (a change here needs a migration note because hosts already run `ensureSchema`)
- endpoint paths, error codes, token prefixes

## Dependencies

`@modelcontextprotocol/sdk` and `zod` are peer dependencies so hosts control the version they run. When bumping the supported range, update both `peerDependencies` and `devDependencies`, run the tests and note it in the changelog.

## Unpublishing

npm allows `npm unpublish @ninomae/mcp-app-server@X.Y.Z` within 72 hours of publishing if no other package depends on it. After that, publish a fixed patch and `npm deprecate @ninomae/mcp-app-server@X.Y.Z "reason"` the bad one.

## Moving a host from the monorepo workspace to the npm package

Career Note originally kept this code at `packages/agent-gateway` with `"@ninomae/mcp-app-server": "*"` resolved through npm workspaces. After the first release:

```bash
git rm -r packages/agent-gateway
npm pkg delete workspaces
npm install @ninomae/mcp-app-server@^0.1.0
npm test && npm run typecheck
```

Nothing else changes: imports were already `@ninomae/mcp-app-server` and `@ninomae/mcp-app-server/react`. Until the package is published, keep the workspace copy in place — a `file:` or `github:` dependency would break CI on machines that lack the sibling checkout.
