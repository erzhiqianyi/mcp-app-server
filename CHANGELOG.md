# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-09-22

### Changed
- **Breaking:** `inspector` no longer takes a boolean. Pass `inspectorResponse` from the new `@ninomae/mcp-app-server/inspector` subpath (`inspector: dev && inspectorResponse`); the core never imports the page module, so a build that leaves the option out (or passes `false`) does not carry the inspector bundle. Migration: replace `inspector: flag` with `inspector: flag && inspectorResponse`.
- Inspector page: two-pane layout with a catalogue on the left (tools grouped into read / write by their MCP annotations, plus resources, with a filter) and the selected item's details on the right. Tool buttons now name the operation — **Read**, **Write** or **Run destructive write** (with a confirmation) — instead of a uniform "Call tool"; unannotated tools are listed as writes and flagged. Results and typed arguments persist per entry while navigating.
- README: the inspector is documented as development/testing only and must not be enabled in production.

## [0.3.0] - 2026-09-22

### Added
- Opt-in `inspector: true` serves a development inspector page at `GET <basePath>/mcp/inspector`: same-origin OAuth PKCE flow, `tools/list` / `resources/list`, tool calls and resource reads from the browser. The page is bundled into `dist/` at build time (`npm run build:inspector`); `examples/inspector` builds the same source as a standalone page. The page sends the `resource` indicator announced by `/.well-known/oauth-protected-resource`, so it also works when it is reached through a dev proxy or tunnel whose origin differs from `publicOrigin`, and OAuth errors returned to the callback are shown instead of ignored.
- Opt-in `connectionInfo` configuration registers an authenticated, read-only `get_connection_info` tool, with live host profile/environment lookup, verified grant context, explicit user status, and allowlisted structured output.
- Multi-account, browser-switch, anonymous access, revoked grant, deleted user, and resolver-failure coverage.

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

[Unreleased]: https://github.com/erzhiqianyi/mcp-app-server/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/erzhiqianyi/mcp-app-server/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/erzhiqianyi/mcp-app-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/erzhiqianyi/mcp-app-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/erzhiqianyi/mcp-app-server/releases/tag/v0.1.0
