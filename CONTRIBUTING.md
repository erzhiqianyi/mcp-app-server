# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/erzhiqianyi/mcp-app-server.git
cd mcp-app-server
npm install
npm run typecheck
npm test
```

`npm test` builds `dist/` first, then runs three suites: a Miniflare end-to-end flow against a Cloudflare Worker host with D1 (`tests/worker.test.mjs`), the replay/revocation rules on `memoryStore()` with no database (`tests/memory-store.test.mjs`), and the `sqlStore` adapter on plain Node with `node:sqlite` (`tests/node-sqlite.test.mjs`). Node ≥ 22 is required.

## Pull requests

- Keep the public surface small; new options need a line in the README table and a changelog entry under *Unreleased*.
- Anything touching OAuth or token handling needs a test that exercises the failure path (replay, wrong audience, cross-tenant access), not only the happy path.
- Run `npm run typecheck && npm test` before pushing; CI runs the same on Node 22 and 24.
- Do not bump the version in a PR; maintainers release with `npm version` (see `docs/publishing.md`).

## Security

Please report vulnerabilities privately through GitHub's *Security → Report a vulnerability* rather than a public issue.
