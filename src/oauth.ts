// OAuth 2.1 authorization server for MCP clients (RFC 6749/7591/7636/8414/8707/9728).
// The server is both authorization server and resource server; user identity comes
// from the host app through IdentityProvider and is never derived from input.
import type { AppServerEvent, Origins, ScopeDefinition } from './types.js';
import { AppServerError } from './types.js';
import type { ClientRecord, AppServerStore } from './store.js';
import type { RateLimitConfig } from './rate-limit.js';
import { defaultRateLimitKey } from './rate-limit.js';
import type { TokenStore } from './tokens.js';
import { json, nowIso, parseJsonList, randomSecret, readBody, sha256Hex, str, base64url } from './util.js';

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
const CODE_TTL_MS = 10 * 60 * 1000;
const REFRESH_PREFIX = 'agr_';

export interface OauthRuntime {
  store: AppServerStore;
  origins: Origins;
  mcpPath: string;
  oauthPath: string;
  consentPath: string;
  scopes: Record<string, ScopeDefinition>;
  refreshDays: number;
  tokens: TokenStore;
  onEvent?: (event: AppServerEvent) => Promise<void> | void;
  /** Null disables registration rate limiting. */
  registrationLimit: RateLimitConfig | null;
}

export const mcpResource = (rt: Pick<OauthRuntime, 'origins' | 'mcpPath'>) => rt.origins.publicOrigin + rt.mcpPath;
export const resourceMetadataUrl = (rt: Pick<OauthRuntime, 'origins'>) => rt.origins.publicOrigin + '/.well-known/oauth-protected-resource';
const scopeNames = (rt: Pick<OauthRuntime, 'scopes'>) => Object.keys(rt.scopes);
const requiredScopes = (rt: Pick<OauthRuntime, 'scopes'>) => scopeNames(rt).filter((s) => rt.scopes[s].required);

export function isWellKnownPath(rt: Pick<OauthRuntime, 'mcpPath'>, pathname: string) {
  return (
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-protected-resource' + rt.mcpPath ||
    pathname === '/.well-known/oauth-authorization-server'
  );
}

export function wellKnownResponse(rt: OauthRuntime, pathname: string) {
  const origin = rt.origins.publicOrigin;
  const body = pathname.startsWith('/.well-known/oauth-protected-resource')
    ? { resource: mcpResource(rt), authorization_servers: [origin], scopes_supported: scopeNames(rt), bearer_methods_supported: ['header'] }
    : {
        issuer: origin,
        authorization_endpoint: origin + rt.oauthPath + '/authorize',
        token_endpoint: origin + rt.oauthPath + '/token',
        registration_endpoint: origin + rt.oauthPath + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: [...AUTH_METHODS],
        scopes_supported: scopeNames(rt),
      };
  return json(body, 200, { 'access-control-allow-origin': '*' });
}

export function oauthErrorResponse(error: AppServerError) {
  return json({ error: error.code, error_description: error.message }, error.status);
}

export function challengeResponse(rt: Pick<OauthRuntime, 'origins'>, error: string, description: string, status = 401) {
  return json(
    { error, error_description: description },
    status,
    { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl(rt)}", error="${error}", error_description="${description.replace(/"/g, "'")}"` },
  );
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// Loopback redirects may change port per run (RFC 8252 §7.3); custom schemes serve
// desktop apps; https must match exactly; plain http elsewhere is refused.
export function classifyRedirect(uri: string): 'loopback' | 'custom' | 'https' | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.hash) return null;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : null;
  if (url.protocol === 'https:') return 'https';
  if (['javascript:', 'data:', 'file:', 'blob:', 'vbscript:'].includes(url.protocol)) return null;
  return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) ? 'custom' : null;
}

function redirectMatches(registered: string, requested: string) {
  if (registered === requested) return true;
  if (classifyRedirect(registered) !== 'loopback' || classifyRedirect(requested) !== 'loopback') return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

async function throttleRegistration(rt: OauthRuntime, request: Request) {
  if (!rt.registrationLimit) return;
  const key = (rt.registrationLimit.key || defaultRateLimitKey)(request);
  if (!(await rt.registrationLimit.limiter.allow(key))) throw new AppServerError(429, 'Registration rate limit exceeded', 'too_many_requests');
}

async function loadClient(rt: OauthRuntime, clientId: string) {
  if (!clientId) throw new AppServerError(400, 'client_id is required', 'invalid_client');
  const client = await rt.store.clients.get(clientId);
  if (!client) throw new AppServerError(400, 'Unknown client_id', 'invalid_client');
  return client;
}

function requestedScopes(rt: OauthRuntime, client: ClientRecord, scopeParam: string): string[] {
  const raw = scopeParam ? scopeParam.split(/\s+/) : parseJsonList(client.scope);
  const known = scopeNames(rt).filter((s) => raw.includes(s));
  const scopes = known.length ? known : scopeNames(rt);
  for (const required of requiredScopes(rt)) if (!scopes.includes(required)) scopes.unshift(required);
  return scopes;
}

export async function register(rt: OauthRuntime, request: Request) {
  await throttleRegistration(rt, request);
  const body = await readBody(request);
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(str).filter(Boolean) : [];
  if (!uris.length) throw new AppServerError(400, 'redirect_uris is required', 'invalid_redirect_uri');
  for (const uri of uris) {
    if (uri.length > 2000 || !classifyRedirect(uri)) throw new AppServerError(400, `Unsupported redirect_uri: ${uri}`, 'invalid_redirect_uri');
  }
  const method = str(body.token_endpoint_auth_method) || 'none';
  if (!(AUTH_METHODS as readonly string[]).includes(method)) throw new AppServerError(400, 'Unsupported token_endpoint_auth_method', 'invalid_client_metadata');
  const grants = Array.isArray(body.grant_types) ? body.grant_types.map(str) : ['authorization_code'];
  if (grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) throw new AppServerError(400, 'Unsupported grant_types', 'invalid_client_metadata');
  const name = (str(body.client_name) || 'MCP client').slice(0, 200);
  const scope = str(body.scope).slice(0, 500) || null;
  const clientId = crypto.randomUUID();
  const secret = method === 'none' ? null : randomSecret();
  const createdAt = nowIso();
  await rt.store.clients.create({ id: clientId, secretHash: secret ? await sha256Hex(secret) : null, name, redirectUris: uris, tokenEndpointAuthMethod: method, scope, createdAt, lastUsedAt: null });
  return json(
    {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(scope ? { scope } : {}),
    },
    201,
  );
}

type AuthorizeParams = { clientId: string; redirectUri: string; codeChallenge: string; state: string; scope: string; resource: string };
type ParamSource = URLSearchParams | Record<string, unknown>;
const reader = (source: ParamSource) => (key: string) => (source instanceof URLSearchParams ? source.get(key) || '' : str(source[key]));

function readAuthorizeParams(source: ParamSource): AuthorizeParams {
  const get = reader(source);
  return { clientId: get('client_id'), redirectUri: get('redirect_uri'), codeChallenge: get('code_challenge'), state: get('state'), scope: get('scope'), resource: get('resource') };
}

async function validateAuthorize(rt: OauthRuntime, params: AuthorizeParams, source: ParamSource) {
  const get = reader(source);
  const client = await loadClient(rt, params.clientId);
  const registered = client.redirectUris;
  if (!params.redirectUri || !registered.some((uri) => redirectMatches(uri, params.redirectUri)))
    throw new AppServerError(400, 'redirect_uri does not match the registered value');
  // Beyond this point the redirect target is trusted, so errors may be sent back to it.
  const responseType = get('response_type');
  if (responseType && responseType !== 'code') throw new AppServerError(400, 'Only response_type=code is supported', 'unsupported_response_type');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(params.codeChallenge)) throw new AppServerError(400, 'PKCE code_challenge is required');
  if (get('code_challenge_method') !== 'S256') throw new AppServerError(400, 'code_challenge_method must be S256');
  if (params.resource && params.resource !== mcpResource(rt)) throw new AppServerError(400, 'resource must be ' + mcpResource(rt), 'invalid_target');
  return client;
}

function appendQuery(uri: string, entries: Record<string, string>) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(entries)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

// GET <oauth>/authorize: validate, then hand the user to the host's consent page.
export async function authorize(rt: OauthRuntime, request: Request) {
  const query = new URL(request.url).searchParams;
  const params = readAuthorizeParams(query);
  try {
    await validateAuthorize(rt, params, query);
  } catch (error) {
    if (!(error instanceof AppServerError)) throw error;
    const trusted = error.code !== 'invalid_client' && !error.message.startsWith('redirect_uri');
    if (trusted) return Response.redirect(appendQuery(params.redirectUri, { error: error.code, error_description: error.message, state: params.state }), 302);
    throw error;
  }
  const target = new URL(rt.consentPath, rt.origins.webOrigin);
  target.search = query.toString();
  return Response.redirect(target.toString(), 302);
}

// GET <oauth>/client: the consent page shows who is asking, where it returns, and what each scope means.
export async function clientInfo(rt: OauthRuntime, request: Request) {
  const query = new URL(request.url).searchParams;
  const client = await loadClient(rt, query.get('client_id') || '');
  const redirectHosts = client.redirectUris.map((uri) => {
    const kind = classifyRedirect(uri);
    if (kind === 'loopback') return 'localhost';
    try {
      return kind === 'custom' ? new URL(uri).protocol.replace(/:$/, '://') : new URL(uri).host;
    } catch {
      return uri;
    }
  });
  const scopes = requestedScopes(rt, client, query.get('scope') || '');
  return json({
    clientId: client.id,
    clientName: client.name,
    redirectHosts: [...new Set(redirectHosts)],
    scopes,
    scopesSupported: scopeNames(rt),
    scopeDetails: scopes.map((name) => ({ name, description: rt.scopes[name].description, required: !!rt.scopes[name].required, default: !!(rt.scopes[name].required || rt.scopes[name].default) })),
  });
}

// POST <oauth>/approve: the identified user consents (or refuses).
export async function approve(rt: OauthRuntime, request: Request, ownerId: string) {
  const body = await readBody(request);
  const params = readAuthorizeParams(body);
  const client = await validateAuthorize(rt, params, body);
  const decision = str(body.decision);
  if (decision === 'deny') return json({ redirect: appendQuery(params.redirectUri, { error: 'access_denied', error_description: 'The user refused the request', state: params.state }) });
  if (decision !== 'approve') throw new AppServerError(400, 'decision must be approve or deny');
  const allowed = requestedScopes(rt, client, params.scope);
  const chosen = Array.isArray(body.scopes) ? body.scopes.map(str).filter((s) => allowed.includes(s)) : allowed;
  for (const required of requiredScopes(rt)) if (!chosen.includes(required)) chosen.unshift(required);
  const code = randomSecret();
  await rt.store.codes.create({ hash: await sha256Hex(code), clientId: client.id, ownerId, redirectUri: params.redirectUri, scopes: chosen, codeChallenge: params.codeChallenge, resource: params.resource || null, expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(), usedAt: null, issuedTokenId: null });
  return json({ redirect: appendQuery(params.redirectUri, { code, state: params.state }) });
}

async function authenticateClient(rt: OauthRuntime, request: Request, body: Record<string, unknown>) {
  let clientId = str(body.client_id);
  let secret = str(body.client_secret);
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const [id, ...rest] = atob(header.slice(6)).split(':');
      clientId = decodeURIComponent(id);
      secret = decodeURIComponent(rest.join(':'));
    } catch {
      throw new AppServerError(401, 'Malformed Basic credentials', 'invalid_client');
    }
  }
  const client = await loadClient(rt, clientId);
  if (client.tokenEndpointAuthMethod !== 'none') {
    if (!secret || (await sha256Hex(secret)) !== client.secretHash) throw new AppServerError(401, 'Client authentication failed', 'invalid_client');
  }
  return client;
}

async function issuePair(rt: OauthRuntime, client: ClientRecord, ownerId: string, scopes: string[], type: 'authorized' | 'refreshed') {
  const access = await rt.tokens.issue({ ownerId, clientId: client.id, clientName: client.name, scopes, audience: mcpResource(rt) });
  await rt.onEvent?.({ type, ownerId, grantId: access.id, clientId: client.id, clientName: client.name, scopes });
  const refresh = randomSecret(REFRESH_PREFIX);
  await rt.store.refreshTokens.create({ hash: await sha256Hex(refresh), clientId: client.id, ownerId, accessTokenId: access.id, scopes, expiresAt: new Date(Date.now() + rt.refreshDays * 86400 * 1000).toISOString(), revoked: false, successorId: null });
  await rt.store.clients.touch(client.id, nowIso());
  const response = json({
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: Math.max(0, Math.floor((Date.parse(access.expiresAt) - Date.now()) / 1000)),
    refresh_token: refresh,
    scope: scopes.join(' '),
  });
  return { response, accessId: access.id };
}

// POST <oauth>/token
export async function token(rt: OauthRuntime, request: Request) {
  const body = await readBody(request);
  const client = await authenticateClient(rt, request, body);
  const grant = str(body.grant_type);
  const now = nowIso();
  if (grant === 'authorization_code') {
    const code = str(body.code);
    if (!code) throw new AppServerError(400, 'code is required', 'invalid_grant');
    const row = await rt.store.codes.get(await sha256Hex(code));
    if (!row || row.clientId !== client.id) throw new AppServerError(400, 'Unknown authorization code', 'invalid_grant');
    if (row.usedAt) {
      // Replay of a consumed code: revoke what it produced (RFC 6819 §5.2.1.1).
      if (row.issuedTokenId) await revokeChain(rt, row.issuedTokenId);
      throw new AppServerError(400, 'Authorization code already used', 'invalid_grant');
    }
    if (row.expiresAt < now) throw new AppServerError(400, 'Authorization code expired', 'invalid_grant');
    if (str(body.redirect_uri) && str(body.redirect_uri) !== row.redirectUri) throw new AppServerError(400, 'redirect_uri mismatch', 'invalid_grant');
    const verifier = str(body.code_verifier);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await pkceChallenge(verifier)) !== row.codeChallenge) throw new AppServerError(400, 'PKCE verification failed', 'invalid_grant');
    const resource = str(body.resource);
    if (resource && resource !== mcpResource(rt)) throw new AppServerError(400, 'resource mismatch', 'invalid_target');
    // Consume the code before issuing so a concurrent replay cannot win a second token.
    if (!(await rt.store.codes.consume(row.hash, now))) throw new AppServerError(400, 'Authorization code already used', 'invalid_grant');
    const issued = await issuePair(rt, client, row.ownerId, row.scopes, 'authorized');
    await rt.store.codes.setIssuedToken(row.hash, issued.accessId);
    return issued.response;
  }
  if (grant === 'refresh_token') {
    const refresh = str(body.refresh_token);
    if (!refresh.startsWith(REFRESH_PREFIX)) throw new AppServerError(400, 'refresh_token is required', 'invalid_grant');
    const row = await rt.store.refreshTokens.get(await sha256Hex(refresh));
    if (!row || row.clientId !== client.id) throw new AppServerError(400, 'Unknown refresh token', 'invalid_grant');
    if (row.revoked) {
      // A rotated refresh token being replayed means the chain leaked; cut every successor.
      await revokeChain(rt, row.accessTokenId);
      throw new AppServerError(400, 'Refresh token revoked', 'invalid_grant');
    }
    if (row.expiresAt < now) throw new AppServerError(400, 'Refresh token expired', 'invalid_grant');
    if (!(await rt.store.refreshTokens.revoke(row.hash))) throw new AppServerError(400, 'Refresh token revoked', 'invalid_grant');
    await revokeAccess(rt, row.accessTokenId);
    const issued = await issuePair(rt, client, row.ownerId, row.scopes, 'refreshed');
    await rt.store.refreshTokens.setSuccessor(row.hash, issued.accessId);
    return issued.response;
  }
  throw new AppServerError(400, 'grant_type must be authorization_code or refresh_token', 'unsupported_grant_type');
}

async function revokeAccess(rt: OauthRuntime, id: string) {
  const revoked = await rt.tokens.revoke(id);
  if (revoked) await rt.onEvent?.({ type: 'revoked', ownerId: revoked.ownerId, grantId: id, clientId: revoked.clientId, clientName: revoked.clientName });
}

// Revokes an access token, its refresh token, and every pair rotated from it.
export async function revokeChain(rt: OauthRuntime, accessTokenId: string) {
  const seen = new Set<string>();
  let current: string | null = accessTokenId;
  while (current && !seen.has(current)) {
    seen.add(current);
    await revokeAccess(rt, current);
    const row = await rt.store.refreshTokens.getByAccessToken(current);
    await rt.store.refreshTokens.revokeByAccessToken(current);
    current = row?.successorId ?? null;
  }
}

export async function pruneOauth(rt: OauthRuntime) {
  await rt.store.prune?.(nowIso());
}
