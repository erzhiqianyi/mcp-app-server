// Turn an existing app's users and data into a standard MCP server that external AI agents
// can connect to through OAuth 2.1. The host supplies identity, tools and storage; the gateway
// supplies discovery, authorization, token lifecycle and the MCP transport.
import type { AuthenticatedGrant, GatewayConfig, Grant, Origins, TableNames, ToolContext } from './types.js';
import { GatewayError } from './types.js';
import { createTokenStore, ensureTokenSchema } from './tokens.js';
import * as oauth from './oauth.js';
import { describeServer, isDiscoveryRequest, registryEntry, serveMcp } from './mcp.js';

export * from './types.js';
export * from './identity.js';
export { classifyRedirect } from './oauth.js';

export interface AgentGateway {
  /** Handle a request if it belongs to the gateway; returns null for every other path. */
  fetch(request: Request): Promise<Response | null>;
  /** Verify an agent access token carried by any request (e.g. the host's own REST routes). Null when the request carries no gateway token. */
  authenticate(request: Request): Promise<AuthenticatedGrant | null>;
  /** True when the bearer token on this request looks like a gateway-issued token. */
  carriesToken(request: Request): boolean;
  listGrants(ownerId: string): Promise<Grant[]>;
  /** Revoke one grant and every token rotated from it. Throws 404 when the owner does not hold it. */
  revokeGrant(ownerId: string, grantId: string): Promise<void>;
  /** Idempotent schema setup; call once per request path or at deploy time. */
  ensureSchema(): Promise<void>;
  /** Public schema document (same as GET <basePath>/mcp/schema). */
  describe(request: Request): ReturnType<typeof describeServer>;
  /** `server.json` for the official MCP registry. */
  serverJson(request: Request, namespace: string, description: string): ReturnType<typeof registryEntry>;
  origins(request: Request): Origins;
  paths: { mcp: string; schema: string; oauth: string; consent: string };
}

const DEFAULT_TABLES: TableNames = { clients: 'agent_clients', codes: 'agent_codes', refreshTokens: 'agent_refresh_tokens', accessTokens: 'agent_access_tokens' };

function days(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value as number) > 0 && (value as number) <= 365 ? (value as number) : fallback;
}

export function createAgentGateway(config: GatewayConfig): AgentGateway {
  const basePath = config.basePath.replace(/\/+$/, '');
  const paths = { mcp: basePath + '/mcp', schema: basePath + '/mcp/schema', oauth: basePath + '/oauth', consent: config.consentPath || '/oauth/authorize' };
  const tables = { ...DEFAULT_TABLES, ...config.tables };
  const tokenPrefix = config.tokenPrefix || 'agt_';
  const scopeNames = Object.keys(config.scopes);
  const version = config.version || '1.0.0';
  const tokens = createTokenStore(config.storage, tables.accessTokens, tokenPrefix, days(config.accessTokenDays, 30), scopeNames);
  const origins = (request: Request) => (typeof config.origins === 'function' ? config.origins(request) : config.origins);
  const runtime = (request: Request): oauth.OauthRuntime => ({
    db: config.storage,
    tables,
    origins: origins(request),
    mcpPath: paths.mcp,
    oauthPath: paths.oauth,
    consentPath: paths.consent,
    scopes: config.scopes,
    refreshDays: days(config.refreshTokenDays, 90),
    tokens,
    onEvent: config.onEvent,
  });
  const carriesToken = (request: Request) => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim().startsWith(tokenPrefix);

  async function authenticate(request: Request) {
    if (!carriesToken(request)) return null;
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    return tokens.verify(token, oauth.mcpResource(runtime(request)));
  }

  async function handleOauth(rt: oauth.OauthRuntime, request: Request, pathname: string) {
    const method = request.method.toUpperCase();
    try {
      if (pathname === paths.oauth + '/register' && method === 'POST') return await oauth.register(rt, request);
      if (pathname === paths.oauth + '/authorize' && method === 'GET') return await oauth.authorize(rt, request);
      if (pathname === paths.oauth + '/client' && method === 'GET') return await oauth.clientInfo(rt, request);
      if (pathname === paths.oauth + '/token' && method === 'POST') {
        await oauth.pruneOauth(rt);
        return await oauth.token(rt, request);
      }
      if (pathname === paths.oauth + '/approve' && method === 'POST') {
        // The consent page posts with whatever credential the host's own login uses; only the host can read it.
        if (carriesToken(request)) throw new GatewayError(403, 'Agents cannot approve grants', 'access_denied');
        const identity = await config.identity.resolve(request);
        return await oauth.approve(rt, request, identity.id);
      }
      throw new GatewayError(404, 'Unknown OAuth endpoint');
    } catch (error) {
      if (error instanceof GatewayError) return oauth.oauthErrorResponse(error);
      throw error;
    }
  }

  async function handleMcp(rt: oauth.OauthRuntime, request: Request) {
    const method = request.method.toUpperCase();
    const anonymous = !request.headers.has('authorization');
    if (anonymous && method === 'POST' && config.anonymousDiscovery !== false && (await isDiscoveryRequest(request))) {
      return serveMcp({ name: config.name, version, tools: config.tools, request, ctx: null });
    }
    let grant: AuthenticatedGrant | null;
    try {
      grant = await authenticate(request);
    } catch (error) {
      if (error instanceof GatewayError) return oauth.challengeResponse(rt, error.code, error.message, error.status);
      throw error;
    }
    if (!grant) return oauth.challengeResponse(rt, 'invalid_token', 'Authorize this agent with OAuth first');
    const ctx: ToolContext = { ownerId: grant.ownerId, scopes: grant.scopes, grantId: grant.grantId, clientId: grant.clientId, clientName: grant.clientName, request };
    const tools = config.tools.map((tool) => ({
      ...tool,
      handler: async (args: Record<string, unknown>, c: ToolContext) => {
        const result = await tool.handler(args, c);
        await config.onEvent?.({ type: 'tool', ownerId: c.ownerId, grantId: c.grantId, clientId: c.clientId, clientName: c.clientName, tool: tool.name, ok: !result.isError });
        return result;
      },
    }));
    return serveMcp({ name: config.name, version, tools, request, ctx });
  }

  return {
    paths,
    origins,
    carriesToken,
    authenticate,
    async ensureSchema() {
      await ensureTokenSchema(config.storage, tables.accessTokens);
      await oauth.ensureOauthSchema(config.storage, tables);
    },
    describe: (request) => describeServer({ name: config.name, version, origins: origins(request), mcpPath: paths.mcp, scopes: scopeNames, tools: config.tools, contract: config.contract }),
    serverJson: (request, namespace, description) => registryEntry({ namespace, name: config.name, version, description, origins: origins(request), mcpPath: paths.mcp }),
    listGrants: (ownerId) => tokens.list(ownerId),
    async revokeGrant(ownerId, grantId) {
      if (!(await tokens.owns(ownerId, grantId))) throw new GatewayError(404, 'Grant not found');
      // Origins are irrelevant for revocation; a placeholder runtime keeps the signature simple.
      await oauth.revokeChain(runtime(new Request('http://gateway.local/')), grantId);
    },
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const method = request.method.toUpperCase();
      const rt = runtime(request);
      if (oauth.isWellKnownPath(rt, pathname) && method === 'GET') return oauth.wellKnownResponse(rt, pathname);
      if (pathname === paths.schema && method === 'GET') {
        return new Response(JSON.stringify(this.describe(request)), { headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' } });
      }
      if (pathname.startsWith(paths.oauth + '/')) return handleOauth(rt, request, pathname);
      if (pathname === paths.mcp) return handleMcp(rt, request);
      return null;
    },
  };
}
