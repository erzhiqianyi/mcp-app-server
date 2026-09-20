# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-21

### Added
- `resources`: static resources (for example MCP Apps `ui://` HTML) listed by `resources/list`, served by `resources/read` with the caller's `ToolContext`, scope-trimmed like tools, and included in the public schema document. `resources/list` counts as anonymous discovery.
- `AgentTool.title` and `AgentTool._meta` pass through to `tools/list`, so a tool can declare `_meta.ui.resourceUri` for MCP Apps hosts.
- `ToolResult.structuredContent` / `_meta` pass through to `tools/call` results.
- Japanese README and guides (`README.ja.md`, `docs/*.ja.md`).

## [0.1.0] - 2026-09-15

Initial release. Extracted from the Career Note monorepo (where it was briefly named `agent-gateway`) and generalised.

### Added
- `createMcpAppServer`: OAuth 2.1 authorization server (RFC 6749 / 7591 / 7636 / 8414 / 8707 / 9728) and MCP Streamable HTTP resource server in one `fetch` handler.
- Identity providers: `sessionIdentity`, `jwtIdentity`, `firebaseIdentity`, `fixedIdentity`.
- Scoped tool table with grant-trimmed `tools/list`, anonymous discovery and a public `/mcp/schema` document. `scopes` is optional: without a catalogue one implicit required scope is used and consent is a plain allow/deny.
- Opaque access tokens (`agt_`) and rotating refresh tokens (`agr_`), hashed at rest, audience-bound; replaying a code or a rotated refresh token revokes the chain.
- `authenticate` / `carriesToken` for accepting agent tokens on host routes; `listGrants` / `revokeGrant` for user-facing management.
- Storage contract `AppServerStore`: the core depends on no database. `memoryStore()` (reference, Maps) ships in the root; `sqlStore(db, tables?)` for Cloudflare D1 and SQLite drivers ships at `@ninomae/mcp-app-server/sql`.
- Rate-limit contract `RateLimiter` for dynamic client registration (`registrationLimit`); `memoryRateLimiter()` is the default, `false` disables.
- `serverJson` helper for the official MCP Registry.
- `@ninomae/mcp-app-server/react`: headless `useAgentConsent` hook.
- Tests: Miniflare + D1 end-to-end, replay/revocation rules on `memoryStore`, `sqlStore` on plain Node `node:sqlite`.

[Unreleased]: https://github.com/erzhiqianyi/mcp-app-server/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/erzhiqianyi/mcp-app-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/erzhiqianyi/mcp-app-server/releases/tag/v0.1.0
