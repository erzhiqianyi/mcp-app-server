# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-15

Initial release, extracted from the Career Note monorepo.

### Added
- `createAgentGateway`: OAuth 2.1 authorization server (RFC 6749 / 7591 / 7636 / 8414 / 8707 / 9728) and MCP Streamable HTTP resource server in one `fetch` handler.
- Identity providers: `sessionIdentity`, `jwtIdentity`, `firebaseIdentity`, `fixedIdentity`.
- Scoped tool table with grant-trimmed `tools/list`, anonymous discovery and a public `/mcp/schema` document.
- Opaque access tokens (`agt_`) and rotating refresh tokens (`agr_`), hashed at rest, audience-bound; replay detection revokes the chain.
- `authenticate` / `carriesToken` for accepting agent tokens on host routes; `listGrants` / `revokeGrant` for user-facing management.
- `serverJson` helper for the official MCP Registry.
- `@erzhiqian/agent-gateway/react`: headless `useAgentConsent` hook.
- `SqlDatabase` storage interface; Cloudflare D1 works directly, `node:sqlite` via a documented adapter.
- Miniflare end-to-end test and a plain-Node `node:sqlite` test.

[Unreleased]: https://github.com/erzhiqianyi/agent-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/erzhiqianyi/agent-gateway/releases/tag/v0.1.0
