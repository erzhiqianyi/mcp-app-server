import type { ZodRawShape } from 'zod';

/**
 * Minimal SQL surface the gateway needs. Cloudflare D1 satisfies it directly;
 * other SQLite-compatible drivers can be adapted with a thin wrapper.
 */
export interface SqlDatabase {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): SqlStatement;
}
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

/** The user the host app recognizes on the consent page. `id` must be stable and never reused. */
export interface Identity {
  id: string;
  displayName?: string;
  email?: string;
}

/**
 * The only contract between the host app and the gateway: given the consent-page request
 * (whatever credential the host's own login puts on it), say who the current user is.
 * Throw `GatewayError(401, …)` when nobody is signed in.
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
  /** Scope required to see and call the tool; omit for tools any authorized agent may use. */
  scope?: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface Origins {
  /** Where agents reach the gateway; written into metadata, `resource` and token audience. */
  publicOrigin: string;
  /** Where the consent page lives (may differ from publicOrigin during local development). */
  webOrigin: string;
}

export type GatewayEvent =
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

export interface GatewayConfig {
  /** MCP server name; also used in server.json. */
  name: string;
  version?: string;
  /** All gateway routes hang here: `<basePath>/mcp`, `<basePath>/mcp/schema`, `<basePath>/oauth/*`. */
  basePath: string;
  /** Path on `webOrigin` that renders the consent page. Default `/oauth/authorize`. */
  consentPath?: string;
  /** Ordered scope catalogue. Order is preserved in metadata and on the consent page. */
  scopes: Record<string, ScopeDefinition>;
  identity: IdentityProvider;
  tools: readonly AgentTool[];
  storage: SqlDatabase;
  /** Static origins or derived per request (e.g. from Host + env). */
  origins: Origins | ((request: Request) => Origins);
  /** Access token lifetime in days (default 30) and refresh token lifetime (default 90). */
  accessTokenDays?: number;
  refreshTokenDays?: number;
  /** Prefix for issued access tokens; lets the host recognize them on its own routes. Default `agt_`. */
  tokenPrefix?: string;
  /** Table names; override only when adopting an existing schema. */
  tables?: Partial<TableNames>;
  /** Audit hook. Never receives tool payloads. */
  onEvent?: (event: GatewayEvent) => Promise<void> | void;
  /** Let `initialize` / `tools/list` answer without a token so registries can inspect the server. Default true. */
  anonymousDiscovery?: boolean;
  /** Optional free-text contract (markdown) published with the schema and via a `*_get_contract`-style tool if the host wants one. */
  contract?: string;
}

export interface TableNames {
  clients: string;
  codes: string;
  refreshTokens: string;
  accessTokens: string;
}

export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
    /** OAuth error code when the failure is reported through an OAuth response. */
    public code: string = status === 401 ? 'invalid_token' : 'invalid_request',
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
