// The server on plain Node with no database at all: memoryStore() is the reference AppServerStore.
// Beyond the happy path this exercises the replay and revocation rules that depend on the store's
// atomic `codes.consume` / `refreshTokens.revoke` semantics, so any custom store can copy this file
// and swap the constructor to check its own implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpAppServer, fixedIdentity, memoryStore, memoryRateLimiter } from '../dist/index.js';
import { pkce } from './pkce.mjs';

const origin = 'http://app.local';
const events = [];
const mcp = createMcpAppServer({
  name: 'memory-host',
  basePath: '/api',
  scopes: { 'x:read': { description: 'read', required: true } },
  identity: fixedIdentity('solo'),
  storage: memoryStore(),
  origins: { publicOrigin: origin, webOrigin: origin },
  onEvent: (event) => events.push(event.type),
  tools: [{ name: 'whoami', scope: 'x:read', description: 'owner id', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, handler: async (_a, ctx) => ({ content: [{ type: 'text', text: ctx.ownerId }] }) }],
});
const call = async (path, init = {}) => (await mcp.fetch(new Request(origin + path, init))) ?? new Response('unhandled', { status: 599 });
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const rpc = (token) => post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, { accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token });

async function authorize() {
  const client = await (await post('/api/oauth/register', { client_name: 'script', redirect_uris: ['http://localhost:9/cb'] })).json();
  const { verifier, challenge } = pkce();
  const consent = await call('/api/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:9/cb', code_challenge: challenge, code_challenge_method: 'S256' }));
  assert.equal(consent.status, 302);
  const approved = await (await post('/api/oauth/approve', { ...Object.fromEntries(new URL(consent.headers.get('location')).searchParams), decision: 'approve' })).json();
  const code = new URL(approved.redirect).searchParams.get('code');
  const exchange = () => post('/api/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'http://localhost:9/cb' });
  return { client, exchange };
}

void test('memoryStore: full flow without a database', async () => {
  await mcp.ensureSchema(); // no-op for stores without ensureSchema
  const { exchange } = await authorize();
  const issued = await (await exchange()).json();
  assert.match(issued.access_token, /^agt_/);
  assert.equal((await (await rpc(issued.access_token)).json()).result.content[0].text, 'solo');
  const grants = await mcp.listGrants('solo');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].name, 'script');
  await mcp.revokeGrant('solo', grants[0].id);
  assert.equal((await rpc(issued.access_token)).status, 401);
  assert.deepEqual(events.splice(0), ['authorized', 'tool', 'revoked']);
});

void test('memoryStore: replaying an authorization code revokes the token it produced', async () => {
  const { exchange } = await authorize();
  const issued = await (await exchange()).json();
  assert.equal((await rpc(issued.access_token)).status, 200);
  const replay = await exchange();
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
  assert.equal((await rpc(issued.access_token)).status, 401);
});

void test('memoryStore: replaying a rotated refresh token cuts the whole chain', async () => {
  const { client, exchange } = await authorize();
  const first = await (await exchange()).json();
  const refresh = (token) => post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id });
  const second = await (await refresh(first.refresh_token)).json();
  const third = await (await refresh(second.refresh_token)).json();
  assert.equal((await rpc(third.access_token)).status, 200);
  // The first refresh token was rotated away; presenting it again is a leak signal.
  assert.equal((await refresh(first.refresh_token)).status, 400);
  assert.equal((await rpc(third.access_token)).status, 401);
  assert.equal((await refresh(third.refresh_token)).status, 400);
});

void test('memoryStore: an unknown grant cannot be revoked by another owner', async () => {
  const { exchange } = await authorize();
  await (await exchange()).json();
  const [grant] = (await mcp.listGrants('solo')).filter((g) => !g.revoked);
  await assert.rejects(mcp.revokeGrant('someone-else', grant.id), /Grant not found/);
});

void test('scopes are optional: a host without a scope model gets one implicit grant', async () => {
  const bare = createMcpAppServer({
    name: 'bare',
    basePath: '/api',
    identity: fixedIdentity('solo'),
    storage: memoryStore(),
    origins: { publicOrigin: origin, webOrigin: origin },
    tools: [{ name: 'whoami', description: 'owner id', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, handler: async (_a, ctx) => ({ content: [{ type: 'text', text: ctx.ownerId }] }) }],
  });
  const fetch = async (path, init) => (await bare.fetch(new Request(origin + path, init))) ?? new Response('unhandled', { status: 599 });
  const send = (path, body, headers = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const meta = await (await fetch('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(meta.scopes_supported, ['bare']);
  const client = await (await send('/api/oauth/register', { client_name: 'script', redirect_uris: ['http://localhost:9/cb'] })).json();
  const { verifier, challenge } = pkce();
  const consent = await fetch('/api/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:9/cb', code_challenge: challenge, code_challenge_method: 'S256' }));
  const info = await (await fetch('/api/oauth/client?client_id=' + client.client_id)).json();
  assert.equal(info.scopeDetails.length, 1);
  assert.equal(info.scopeDetails[0].required, true);
  const approved = await (await send('/api/oauth/approve', { ...Object.fromEntries(new URL(consent.headers.get('location')).searchParams), decision: 'approve' })).json();
  const code = new URL(approved.redirect).searchParams.get('code');
  const issued = await (await send('/api/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id })).json();
  assert.equal(issued.scope, 'bare');
  const result = await send('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, { accept: 'application/json, text/event-stream', authorization: 'Bearer ' + issued.access_token });
  assert.equal((await result.json()).result.content[0].text, 'solo');
});

void test('registrationLimit: a host-supplied limiter decides who may register', async () => {
  const seen = [];
  const make = (limiter) => createMcpAppServer({
    name: 'limited', basePath: '/api', identity: fixedIdentity('solo'), storage: memoryStore(), origins: { publicOrigin: origin, webOrigin: origin }, tools: [],
    registrationLimit: { limiter, key: (request) => request.headers.get('x-client') || 'anon' },
  });
  const register = (gw, headers = {}) => gw.fetch(new Request(origin + '/api/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ redirect_uris: ['http://localhost:9/cb'] }) }));
  const closed = make({ allow: async (key) => (seen.push(key), false) });
  const refused = await register(closed, { 'x-client': 'bot' });
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).error, 'too_many_requests');
  assert.deepEqual(seen, ['bot']);
  // The reference limiter: two allowed per window, the third refused, independent per key.
  const windowed = make(memoryRateLimiter({ limit: 2, windowMs: 60_000 }));
  assert.equal((await register(windowed, { 'x-client': 'a' })).status, 201);
  assert.equal((await register(windowed, { 'x-client': 'a' })).status, 201);
  assert.equal((await register(windowed, { 'x-client': 'a' })).status, 429);
  assert.equal((await register(windowed, { 'x-client': 'b' })).status, 201);
  // Disabled entirely.
  const open = createMcpAppServer({ name: 'open', basePath: '/api', identity: fixedIdentity('solo'), storage: memoryStore(), origins: { publicOrigin: origin, webOrigin: origin }, tools: [], registrationLimit: false });
  for (let i = 0; i < 25; i++) assert.equal((await register(open)).status, 201);
});
