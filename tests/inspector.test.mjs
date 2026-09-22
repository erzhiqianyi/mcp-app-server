// The inspector is opt-in: without an `inspector` handler the route is not the server's and falls
// through to the host (null), so a production deployment that never enabled it exposes nothing —
// and, because the core never imports the page module, does not even ship it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMcpAppServer, fixedIdentity, memoryStore } from '../dist/index.js';
import { inspectorResponse } from '../dist/inspector.js';

const origin = 'http://app.local';
const server = (inspector) => createMcpAppServer({
  name: 'inspector-host',
  basePath: '/api',
  identity: fixedIdentity('solo'),
  storage: memoryStore(),
  origins: { publicOrigin: origin, webOrigin: origin },
  tools: [],
  ...(inspector === undefined ? {} : { inspector }),
});

void test('inspector: disabled by default and only answers GET', async () => {
  assert.equal(await server().fetch(new Request(origin + '/api/mcp/inspector')), null);
  assert.equal(await server(false).fetch(new Request(origin + '/api/mcp/inspector')), null);
  assert.equal(await server(inspectorResponse).fetch(new Request(origin + '/api/mcp/inspector', { method: 'POST' })), null);
});

void test('inspector: the core entry never references the page module', async () => {
  for (const file of ['index.js', 'mcp.js', 'oauth.js']) {
    assert.doesNotMatch(await readFile(new URL('../dist/' + file, import.meta.url), 'utf8'), /inspector\.js|bundle\.generated/, file);
  }
});

void test('inspector: serves a self-contained page pointing at this server', async () => {
  const mcp = server(inspectorResponse);
  assert.equal(mcp.paths.inspector, '/api/mcp/inspector');
  const response = await mcp.fetch(new Request(origin + '/api/mcp/inspector'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /<style>[^]*<\/style>/);
  assert.match(html, /window\.__MCP_INSPECTOR__ = \{"mcpPath":"\/api\/mcp"\}/);
  assert.doesNotMatch(html, /<script src=/, 'no external assets: everything is inlined');
  assert.match(html, /oauth\/register/, 'bundle contains the OAuth flow');
  assert.match(html, /oauth-protected-resource/, 'resource indicator comes from the server, not from the page origin');
});
