import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpAppServer, memoryStore, sessionIdentity } from '../dist/index.js';
import { pkce } from './pkce.mjs';

const origin = 'https://service.example';
function fixture(connectionInfo) {
  let browserUser = 'alice';
  const config = {
    name: 'example', version: '2.0.0', basePath: '/api', tools: [],
    identity: sessionIdentity(async () => ({ id: browserUser })),
    storage: memoryStore(), origins: { publicOrigin: origin, webOrigin: origin },
    connectionInfo,
  };
  const app = createMcpAppServer(config);
  const send = (path, body, token) => app.fetch(new Request(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const rpc = (method, token, params = {}) => send('/api/mcp', { jsonrpc: '2.0', id: 1, method, params }, token);
  async function authorize(owner) {
    browserUser = owner;
    const client = await (await send('/api/oauth/register', { client_name: `${owner}-client`, redirect_uris: ['http://localhost:9/cb'] })).json();
    const { verifier, challenge } = pkce();
    const consent = await app.fetch(new Request(origin + '/api/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:9/cb', code_challenge: challenge, code_challenge_method: 'S256' })));
    const approved = await (await send('/api/oauth/approve', { ...Object.fromEntries(new URL(consent.headers.get('location')).searchParams), decision: 'approve' })).json();
    return (await send('/api/oauth/token', { grant_type: 'authorization_code', code: new URL(approved.redirect).searchParams.get('code'), code_verifier: verifier, client_id: client.client_id, redirect_uri: 'http://localhost:9/cb' })).json();
  }
  return { app, config, rpc, authorize };
}

test('diagnostics use each verified grant, survive browser switching, and expose only public fields', async () => {
  const seen = [];
  let deleted = false;
  const f = fixture({ resolve: async (ctx) => {
    seen.push(ctx);
    return { user: deleted ? null : { id: 'cannot-override-owner', displayName: ctx.ownerId, email: `${ctx.ownerId}@example.com`, password: 'SECRET', identities: [{ provider: 'firebase', subject: ctx.ownerId + '-uid', issuer: 'test-project', token: 'SECRET' }] }, environment: 'test', dataSource: 'test-db', token: 'SECRET' };
  } });
  const alice = await f.authorize('alice');
  const bob = await f.authorize('bob');
  for (const [owner, issued] of [['alice', alice], ['bob', bob], ['alice', alice]]) {
    const response = await f.rpc('tools/call', issued.access_token, { name: 'get_connection_info', arguments: { ownerId: 'attacker' } });
    const body = await response.json();
    const info = body.result.structuredContent;
    assert.equal(info.user.id, owner);
    assert.equal(info.user.displayName, owner);
    assert.equal(info.user.status, 'active');
    assert.equal(info.connection.clientName, `${owner}-client`);
    assert.equal(info.connection.endpoint, origin + '/api/mcp');
    assert.deepEqual(info.connection.scopes, ['example']);
    assert.equal(info.server.dataSource, 'test-db');
    assert.equal(info.server.version, '2.0.0');
    assert.equal(JSON.stringify(body).includes('SECRET'), false);
    assert.equal(JSON.stringify(body).includes(issued.access_token), false);
    assert.deepEqual(JSON.parse(body.result.content[0].text), info);
    assert.equal('request' in seen.at(-1), false);
  }
  deleted = true;
  const missing = await (await f.rpc('tools/call', alice.access_token, { name: 'get_connection_info', arguments: {} })).json();
  assert.deepEqual(missing.result.structuredContent.user, { id: 'alice', status: 'missing' });
  const [grant] = await f.app.listGrants('alice');
  await f.app.revokeGrant('alice', grant.id);
  assert.equal((await f.rpc('tools/call', alice.access_token, { name: 'get_connection_info', arguments: {} })).status, 401);
});

test('discovery never resolves identity; anonymous calls and invalid tokens are denied', async () => {
  let resolutions = 0;
  const f = fixture({ resolve: async () => { resolutions++; throw new Error('unavailable'); } });
  const discovery = await (await f.rpc('tools/list')).json();
  assert.equal(discovery.result.tools[0].name, 'get_connection_info');
  assert.equal(f.app.describe(new Request(origin)).tools[0].name, 'get_connection_info');
  for (const token of [undefined, 'agt_invalid']) {
    assert.equal((await f.rpc('tools/call', token, { name: 'get_connection_info', arguments: {} })).status, 401);
  }
  assert.equal(resolutions, 0);
  const issued = await f.authorize('alice');
  const failed = await (await f.rpc('tools/call', issued.access_token, { name: 'get_connection_info', arguments: {} })).json();
  assert.equal(resolutions, 1);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent, undefined);
});

test('opt-in, custom name, minimal profile, and collision validation', async () => {
  const disabled = fixture();
  assert.equal(disabled.app.describe(new Request(origin)).tools.length, 0);
  const f = fixture({ toolName: 'example_connection' });
  const issued = await f.authorize('alice');
  const body = await (await f.rpc('tools/call', issued.access_token, { name: 'example_connection', arguments: {} })).json();
  assert.deepEqual(body.result.structuredContent.user, { id: 'alice', status: 'unknown' });
  assert.throws(() => createMcpAppServer({ ...f.config, tools: [{ name: 'example_connection', arguments: {} }] }), /Duplicate/);
  assert.throws(() => fixture({ toolName: 'bad name' }), /Invalid/);
});
