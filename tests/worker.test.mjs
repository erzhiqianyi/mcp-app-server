import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { pkce } from './pkce.mjs';

const origin = 'http://notes.local';
const bundled = await build({ entryPoints: ['tests/fixtures/notes-host.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
async function host(t) {
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-05-22', d1Databases: ['NOTES_DB'] });
  t.after(() => mf.dispose());
  return mf;
}
const json = async (response, status = 200) => { const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data; };
const post = (mf, path, body, headers = {}) => mf.dispatchFetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const rpc = (mf, body, token) => post(mf, '/api/notes/mcp', body, { accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) });

// Full grant against a host whose only identity is a session cookie — no Firebase, no JWT.
async function grant(mf, cookie, scopes) {
  const client = await json(await post(mf, '/api/notes/oauth/register', { client_name: 'Cookie agent', redirect_uris: ['http://localhost:7000/cb'] }), 201);
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:7001/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });
  const authorize = await mf.dispatchFetch(origin + '/api/notes/oauth/authorize?' + params, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const consent = new URL(authorize.headers.get('location'));
  assert.equal(consent.pathname, '/oauth/authorize');
  const approved = await json(await post(mf, '/api/notes/oauth/approve', { ...Object.fromEntries(consent.searchParams), decision: 'approve', ...(scopes ? { scopes } : {}) }, { cookie }));
  const code = new URL(approved.redirect).searchParams.get('code');
  const issued = await json(await post(mf, '/api/notes/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: params.get('redirect_uri') }));
  return { ...issued, client_id: client.client_id };
}

void test('worker: discovery, cookie-session consent, scoped tools and tenant isolation with no Firebase', async (t) => {
  const mf = await host(t);
  const meta = await json(await mf.dispatchFetch(origin + '/.well-known/oauth-authorization-server'));
  assert.equal(meta.registration_endpoint, origin + '/api/notes/oauth/register');
  assert.deepEqual(meta.scopes_supported, ['notes:read', 'notes:write']);
  const schema = await json(await mf.dispatchFetch(origin + '/api/notes/mcp/schema'));
  assert.deepEqual(schema.tools.map((tool) => tool.name), ['notes_list', 'notes_summarize', 'get_connection_info']);
  assert.equal((await json(await rpc(mf, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))).result.tools.length, 3);

  // Hosted inspector: same-origin HTML with the MCP path injected, never cached or indexed.
  const inspector = await mf.dispatchFetch(origin + '/api/notes/mcp/inspector');
  assert.equal(inspector.status, 200);
  assert.match(inspector.headers.get('content-type'), /^text\/html/);
  assert.equal(inspector.headers.get('cache-control'), 'no-store');
  assert.match(await inspector.text(), /window\.__MCP_INSPECTOR__ = \{"mcpPath":"\/api\/notes\/mcp"\}/);

  await post(mf, '/seed', { owner: 'user-alice', id: 'n1', text: 'alice note' });
  await post(mf, '/seed', { owner: 'user-bob', id: 'n2', text: 'bob note' });

  // Nobody signed in → the identity provider refuses the approval.
  const anonymousClient = await json(await post(mf, '/api/notes/oauth/register', { client_name: 'x', redirect_uris: ['http://localhost:7000/cb'] }), 201);
  const refused = await post(mf, '/api/notes/oauth/approve', { client_id: anonymousClient.client_id, redirect_uri: 'http://localhost:7000/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', decision: 'approve' });
  assert.equal(refused.status, 401);

  const alice = await grant(mf, 'session=alice');
  assert.equal(alice.scope, 'notes:read notes:write');
  const listed = await json(await rpc(mf, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'notes_list', arguments: {} } }, alice.access_token));
  assert.deepEqual(JSON.parse(listed.result.content[0].text).map((row) => row.id), ['n1']);

  // Writing through the tool lands in the host's table and only for the token owner.
  const ok = await json(await rpc(mf, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notes_summarize', arguments: { id: 'n1', summary: 'short' } } }, alice.access_token));
  assert.equal(JSON.parse(ok.result.content[0].text).updated, 1);
  const cross = await json(await rpc(mf, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'notes_summarize', arguments: { id: 'n2', summary: 'nope' } } }, alice.access_token));
  assert.equal(cross.result.isError, true);

  // A read-only grant does not even see the write tool.
  const bob = await grant(mf, 'session=bob', ['notes:read']);
  assert.equal(bob.scope, 'notes:read');
  const bobTools = (await json(await rpc(mf, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, bob.access_token))).result.tools.map((tool) => tool.name);
  assert.deepEqual(bobTools, ['notes_list', 'get_connection_info']);
  for (const [owner, token] of [['user-alice', alice.access_token], ['user-bob', bob.access_token]]) {
    const diagnostic = await json(await rpc(mf, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_connection_info', arguments: {} } }, token));
    assert.equal(diagnostic.result.structuredContent.user.id, owner);
    assert.equal(diagnostic.result.structuredContent.server.dataSource, 'notes-d1');
  }

  // Refresh rotates; the previous access token is dead afterwards.
  const rotated = await json(await post(mf, '/api/notes/oauth/token', { grant_type: 'refresh_token', refresh_token: alice.refresh_token, client_id: alice.client_id }));
  assert.match(rotated.refresh_token, /^agr_/);
  assert.equal((await rpc(mf, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, alice.access_token)).status, 401);
  assert.equal((await rpc(mf, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, rotated.access_token)).status, 200);
});
