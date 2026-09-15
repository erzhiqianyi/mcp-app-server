// Runs the built package on plain Node with the built-in `node:sqlite` driver behind the
// SqlDatabase interface — the adapter documented in docs/integration.md, verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAgentGateway, fixedIdentity } from '../dist/index.js';
import { pkce } from './pkce.mjs';

function nodeSqlite(db) {
  const wrap = (sql, values = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
  });
  return { exec: async (sql) => db.exec(sql), prepare: (sql) => wrap(sql) };
}

const origin = 'http://gateway.local';
const gateway = createAgentGateway({
  name: 'node-host',
  basePath: '/api',
  scopes: { 'x:read': { description: 'read', required: true } },
  identity: fixedIdentity('solo'),
  storage: nodeSqlite(new DatabaseSync(':memory:')),
  origins: { publicOrigin: origin, webOrigin: origin },
  tools: [{ name: 'whoami', scope: 'x:read', description: 'owner id', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, handler: async (_a, ctx) => ({ content: [{ type: 'text', text: ctx.ownerId }] }) }],
});
const call = async (path, init = {}) => (await gateway.fetch(new Request(origin + path, init))) ?? new Response('unhandled', { status: 599 });
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

void test('gateway runs on Node + node:sqlite through the SqlDatabase adapter', async () => {
  await gateway.ensureSchema();
  assert.equal((await call('/nope')).status, 599);
  const client = await (await post('/api/oauth/register', { client_name: 'script', redirect_uris: ['http://localhost:9/cb'] })).json();
  const { verifier, challenge } = pkce();
  const consent = await call('/api/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:9/cb', code_challenge: challenge, code_challenge_method: 'S256' }));
  assert.equal(consent.status, 302);
  const approved = await (await post('/api/oauth/approve', { ...Object.fromEntries(new URL(consent.headers.get('location')).searchParams), decision: 'approve' })).json();
  const code = new URL(approved.redirect).searchParams.get('code');
  const issued = await (await post('/api/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'http://localhost:9/cb' })).json();
  assert.match(issued.access_token, /^agt_/);
  const rpc = await post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, { accept: 'application/json, text/event-stream', authorization: 'Bearer ' + issued.access_token });
  assert.equal((await rpc.json()).result.content[0].text, 'solo');
  assert.equal((await gateway.listGrants('solo')).length, 1);
});
