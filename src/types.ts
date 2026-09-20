import type { ZodRawShape } from 'zod';
import type { AppServerStore } from './store.js';
import type { RateLimitConfig } from './rate-limit.js';

/** The user the host app recognizes on the consent page. `id` must be stable and never reused. */
export interface Identity {
  id: string;
  displayName?: string;
  email?: string;
}

/**
 * The only contract between the host app and the server: given the consent-page request
 * (whatever credential the host's own login puts on it), say who the current user is.
 * Throw `AppServerError(401, …)` when nobody is signed in.
 */
export interface IdentityProvider {
  resolve(request: Request): Promise<Identity>;
}

export interface ScopeDefinition {
  /** Human-readable meaning shown on the consent page. */
  description: string;
  /** Always granted; the consent page cannot uncheck it (typically the read scope). */
  required?: boolean;
  /** Pre-checked on the consent page. Required scopes are always on. */
  default?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  /** Machine-readable copy of the result; MCP Apps hosts hand it to the tool's UI resource. */
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

/** Everything a tool handler may know about the caller. Nothing here comes from tool input. */
export interface ToolContext {
  ownerId: string;
  scopes: string[];
  grantId: string;
  clientId: string;
  clientName: string;
  /** The MCP request; hosts that route tools through their own REST API can forward its Authorization header. */
  request: Request;
}

export interface AgentTool {
  name: string;
  title?: string;
  /** Scope required to see and call the tool; omit for tools any authorized agent may use. */
  scope?: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  /** Passed through to `tools/list`; MCP Apps put `{ ui: { resourceUri: 'ui://…' } }` here. */
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** One content item of a `resources/read` response. */
export type ResourceContent =
  | { uri: string; mimeType?: string; text: string; _meta?: Record<string, unknown> }
  | { uri: string; mimeType?: string; blob: string; _meta?: Record<string, unknown> };

/**
 * A static resource (fixed URI) the server lists and serves. MCP Apps register their HTML here
 * under a `ui://` URI with mimeType `text/html;profile=mcp-app`, and point tools at it through
 * `_meta.ui.resourceUri`. The reader receives the caller's context for authorization; keep the
 * content user-independent, since hosts may cache `ui://` resources across reads.
 */
export interface AgentResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** Scope required to see and read the resource; omit for resources any authorized agent may read. */
  scope?: string;
  _meta?: Record<string, unknown>;
  read: (ctx: ToolContext) => Promise<ResourceContent[]>;
}

export interface Origins {
  /** Where agents reach the server; written into metadata, `resource` and token audience. */
  publicOrigin: string;
  /** Where the consent page lives (may differ from publicOrigin during local development). */
  webOrigin: string;
}

export type AppServerEvent =
  | { type: 'authorized' | 'refreshed' | 'revoked'; ownerId: string; grantId: string; clientId: string; clientName: string; scopes?: string[] }
  | { type: 'tool'; ownerId: string; grantId: string; clientId: string; clientName: string; tool: string; ok: boolean };

export interface Grant {
  id: string;
  name: string;
  ownerId: string;
  scopes: string[];
  clientId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revoked: boolean;
  expired: boolean;
  prefix: string;
}

/** Result of verifying an agent access token on any request (MCP or the host's own API). */
export interface AuthenticatedGrant {
  grantId: string;
  ownerId: string;
  scopes: string[];
  clientId: string;
  clientName: string;
  audience: string;
}

export interface McpAppServerConfig {
  /** MCP server name; also used in server.json. */
  name: string;
  version?: string;
  /** All server routes hang here: `<basePath>/mcp`, `<basePath>/mcp/schema`, `<basePath>/oauth/*`. */
  basePath: string;
  /** Path on `webOrigin` that renders the consent page. Default `/oauth/authorize`. */
  consentPath?: string;
  /**
   * Ordered scope catalogue; order is preserved in metadata and on the consent page. Optional:
   * omit it when your app has no notion of delegated scopes — the server then uses one implicit
   * required scope named after the server, the consent page is a plain allow/deny, and every
   * tool is visible to every authorized agent. Authorization stays entirely in your handlers.
   */
  scopes?: Record<string, ScopeDefinition>;
  identity: IdentityProvider;
  tools: readonly AgentTool[];
  /** Static resources (for example MCP Apps `ui://` HTML). Default: none, and `resources/list` is not advertised. */
  resources?: readonly AgentResource[];
  /**
   * Where clients, codes and tokens live. Implement `AppServerStore` over your own database, or use
   * `memoryStore()` (dev/tests) or `sqlStore()` from `@ninomae/mcp-app-server/sql` (D1, SQLite).
   */
  storage: AppServerStore;
  /** Static origins or derived per request (e.g. from Host + env). */
  origins: Origins | ((request: Request) => Origins);
  /** Access token lifetime in days (default 30) and refresh token lifetime (default 90). */
  accessTokenDays?: number;
  refreshTokenDays?: number;
  /** Prefix for issued access tokens; lets the host recognize them on its own routes. Default `agt_`. */
  tokenPrefix?: string;
  /**
   * Rate limit for `POST <base>/oauth/register`, the one unauthenticated endpoint that writes.
   * Default: `memoryRateLimiter()` (20 per hour per IP, per process). Pass your platform's shared
   * counter on multi-instance runtimes, or `false` to disable.
   */
  registrationLimit?: RateLimitConfig | false;
  /** Audit hook. Never receives tool payloads. */
  onEvent?: (event: AppServerEvent) => Promise<void> | void;
  /** Let `initialize` / `tools/list` answer without a token so registries can inspect the server. Default true. */
  anonymousDiscovery?: boolean;
  /** Optional free-text contract (markdown) published with the schema and via a `*_get_contract`-style tool if the host wants one. */
  contract?: string;
}

export class AppServerError extends Error {
  constructor(
    public status: number,
    message: string,
    /** OAuth error code when the failure is reported through an OAuth response. */
    public code: string = status === 401 ? 'invalid_token' : 'invalid_request',
  ) {
    super(message);
    this.name = 'AppServerError';
  }
}
