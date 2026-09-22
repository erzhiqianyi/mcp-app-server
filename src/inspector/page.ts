type Json = Record<string, unknown>;
type Tool = { name: string; title?: string; description?: string; inputSchema?: Json; annotations?: Json; _meta?: Json };
type Resource = { uri: string; name: string; title?: string; description?: string; mimeType?: string; _meta?: Json };

// When the server hosts this page (`inspector: true`), it injects its own MCP path so the
// endpoint is pre-filled and same-origin; standalone builds fall back to the last typed value.
declare global { interface Window { __MCP_INSPECTOR__?: { mcpPath?: string } } }
const hosted = window.__MCP_INSPECTOR__?.mcpPath ? location.origin + window.__MCP_INSPECTOR__.mcpPath : '';

const root = document.querySelector<HTMLDivElement>('#app')!;
const state = {
  serverUrl: hosted || localStorage.getItem('mcp-inspector-server') || '',
  clientName: 'MCP Inspector',
  redirectUri: `${location.origin}${location.pathname}`,
  token: sessionStorage.getItem('mcp-inspector-token') || '',
  tools: [] as Tool[],
  resources: [] as Resource[],
  status: '',
  selected: '',                                   // 'tool:<name>' | 'resource:<uri>'
  filter: '',
  args: {} as Record<string, string>,             // JSON argument text per tool, kept across re-renders
  outputs: {} as Record<string, string>,          // last result per selected key
};

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
const pretty = (value: unknown) => escapeHtml(JSON.stringify(value, null, 2));
const endpoint = () => state.serverUrl.replace(/\/+$/, '');
const baseUrl = () => endpoint().replace(/\/mcp$/, '');
const wellKnownUrl = (path: string) => new URL(path, new URL(endpoint()).origin).toString();
const setStatus = (message: string) => { state.status = message; render(); };

function randomString(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json, text/event-stream');
  if (state.token) headers.set('authorization', `Bearer ${state.token}`);
  const response = await fetch(endpoint() + path, { ...init, headers });
  const text = await response.text();
  const data = (text ? JSON.parse(text) : {}) as Json;
  if (!response.ok) throw new Error(String(data.error_description || data.error || response.statusText));
  return data;
}

async function rpc(method: string, params: Json = {}, notification = false) {
  return request('', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: crypto.randomUUID() }), method, params }),
  });
}

async function authorize() {
  if (!endpoint()) throw new Error('Enter an MCP endpoint first.');
  if (location.protocol === 'file:') throw new Error('Run `npm run serve` and open http://127.0.0.1:8787/ for OAuth callbacks.');
  const verifier = randomString(48);
  const stateValue = randomString(24);
  const registered = await fetch(baseUrl() + '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: state.clientName,
      redirect_uris: [state.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const client = await registered.json() as Json;
  if (!registered.ok) throw new Error(String(client.error_description || client.error));
  sessionStorage.setItem('mcp-inspector-oauth', JSON.stringify({ verifier, state: stateValue, clientId: client.client_id }));
  const meta = await fetch(wellKnownUrl('/.well-known/oauth-authorization-server')).then((r) => r.json()) as Json;
  // The resource indicator must match the server's canonical MCP URL (RFC 9728), which can differ
  // from the address this page reaches it through (dev proxy, tunnel, custom publicOrigin).
  const protectedResource = await fetch(wellKnownUrl('/.well-known/oauth-protected-resource')).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Json;
  const url = new URL(String(meta.authorization_endpoint));
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: String(client.client_id),
    redirect_uri: state.redirectUri,
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
    state: stateValue,
    resource: String(protectedResource.resource || endpoint()),
  }).toString();
  location.href = url.toString();
}

async function finishAuthorization() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (params.has('error')) {
    history.replaceState({}, '', location.pathname);
    throw new Error(`Authorization failed: ${params.get('error_description') || params.get('error')}`);
  }
  if (!code) return;
  const saved = JSON.parse(sessionStorage.getItem('mcp-inspector-oauth') || 'null') as { verifier: string; state: string; clientId: string } | null;
  if (!saved || saved.state !== params.get('state')) throw new Error('OAuth state validation failed.');
  const response = await fetch(baseUrl() + '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: saved.verifier, client_id: saved.clientId, redirect_uri: state.redirectUri }),
  });
  const token = await response.json() as Json;
  if (!response.ok) throw new Error(String(token.error_description || token.error));
  state.token = String(token.access_token);
  sessionStorage.setItem('mcp-inspector-token', state.token);
  history.replaceState({}, '', location.pathname);
}

async function loadSurface() {
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: state.clientName, version: '0.1.0' } });
  await rpc('notifications/initialized', {}, true);
  const tools = await rpc('tools/list');
  const resources = await rpc('resources/list').catch(() => ({ result: { resources: [] } }));
  state.tools = ((tools.result as Json)?.tools || []) as Tool[];
  state.resources = ((resources.result as Json)?.resources || []) as Resource[];
  const first = state.tools[0] ? `tool:${state.tools[0].name}` : state.resources[0] ? `resource:${state.resources[0].uri}` : '';
  if (!state.selected || !findSelected()) state.selected = first;
  setStatus(`Connected to ${String((initialized.result as Json)?.serverInfo ? ((initialized.result as Json).serverInfo as Json).name : 'MCP server')}.`);
}

// Tools are split by their MCP annotations: `readOnlyHint: true` is a read; anything else is
// treated as a write (an unannotated tool may mutate, so it is never shown as safe).
type Kind = 'read' | 'write' | 'destructive';
const kindOf = (tool: Tool): Kind => {
  const a = tool.annotations || {};
  if (a.readOnlyHint === true) return 'read';
  return a.destructiveHint === true ? 'destructive' : 'write';
};
const kindLabel: Record<Kind, string> = { read: 'Read', write: 'Write', destructive: 'Destructive write' };

async function runTool(tool: Tool) {
  const key = `tool:${tool.name}`;
  const kind = kindOf(tool);
  if (kind === 'destructive' && !confirm(`"${tool.name}" is annotated as destructive. Run it?`)) return;
  state.outputs[key] = 'Running…';
  render();
  try {
    const raw = state.args[tool.name] || '';
    const result = await rpc('tools/call', { name: tool.name, arguments: raw.trim() ? JSON.parse(raw) : {} });
    state.outputs[key] = JSON.stringify(result.result ?? result, null, 2);
  } catch (error) {
    state.outputs[key] = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function readResource(resource: Resource) {
  const key = `resource:${resource.uri}`;
  state.outputs[key] = 'Reading…';
  render();
  try {
    const result = await rpc('resources/read', { uri: resource.uri });
    state.outputs[key] = JSON.stringify(result.result ?? result, null, 2);
  } catch (error) {
    state.outputs[key] = error instanceof Error ? error.message : String(error);
  }
  render();
}

function findSelected(): { tool: Tool } | { resource: Resource } | null {
  const [type, ...rest] = state.selected.split(':');
  const id = rest.join(':');
  if (type === 'tool') { const tool = state.tools.find((t) => t.name === id); return tool ? { tool } : null; }
  if (type === 'resource') { const resource = state.resources.find((r) => r.uri === id); return resource ? { resource } : null; }
  return null;
}

const matches = (text: string) => !state.filter || text.toLowerCase().includes(state.filter.toLowerCase());

function navItem(key: string, label: string, badge: string, kind: Kind | 'resource') {
  return `<li><button class="nav-item ${kind} ${state.selected === key ? 'active' : ''}" data-select="${escapeHtml(key)}"><span class="badge ${kind}">${badge}</span><span class="nav-label">${escapeHtml(label)}</span></button></li>`;
}

function navSection(title: string, items: string[]) {
  return `<section class="nav-section"><h2>${title} <span class="count">${items.length}</span></h2>${items.length ? `<ul>${items.join('')}</ul>` : '<p class="muted">None</p>'}</section>`;
}

function sidebar() {
  if (!state.tools.length && !state.resources.length) return '<p class="muted">Authorize and inspect the server to list its tools and resources.</p>';
  const tools = state.tools.filter((t) => matches(`${t.name} ${t.title || ''}`));
  const reads = tools.filter((t) => kindOf(t) === 'read').map((t) => navItem(`tool:${t.name}`, t.name, 'R', 'read'));
  const writes = tools.filter((t) => kindOf(t) !== 'read').map((t) => navItem(`tool:${t.name}`, t.name, kindOf(t) === 'destructive' ? 'W!' : 'W', kindOf(t)));
  const resources = state.resources.filter((r) => matches(`${r.uri} ${r.name} ${r.title || ''}`)).map((r) => navItem(`resource:${r.uri}`, r.title || r.name, 'res', 'resource'));
  return `<input id="filter" type="search" placeholder="Filter…" value="${escapeHtml(state.filter)}">
    ${navSection('Read tools', reads)}${navSection('Write tools', writes)}${navSection('Resources', resources)}`;
}

function annotationBadges(tool: Tool) {
  const a = tool.annotations || {};
  const kind = kindOf(tool);
  const extra = [
    a.idempotentHint === true ? 'idempotent' : '',
    a.openWorldHint === true ? 'open world' : '',
    tool.annotations ? '' : 'unannotated',
  ].filter(Boolean);
  return `<span class="badge ${kind}">${kindLabel[kind]}</span>${extra.map((e) => `<span class="badge plain">${e}</span>`).join('')}`;
}

function toolDetail(tool: Tool) {
  const kind = kindOf(tool);
  const key = `tool:${tool.name}`;
  const schema = tool.inputSchema || { type: 'object', properties: {} };
  const action = { read: 'Read (tools/call)', write: 'Write (tools/call)', destructive: 'Run destructive write (tools/call)' }[kind];
  return `<header class="detail-head"><h2>${escapeHtml(tool.title || tool.name)}</h2><code>${escapeHtml(tool.name)}</code><div class="badges">${annotationBadges(tool)}</div></header>
    <p>${escapeHtml(tool.description)}</p>
    ${tool._meta ? `<details><summary>_meta</summary><pre>${pretty(tool._meta)}</pre></details>` : ''}
    <details open><summary>Input schema</summary><pre>${pretty(schema)}</pre></details>
    <form data-tool="${escapeHtml(tool.name)}"><label class="stack">Arguments (JSON)<textarea name="arguments" rows="6" placeholder='{"query":"hello"}'>${escapeHtml(state.args[tool.name] || '')}</textarea></label>
    <button class="run ${kind}">${action}</button>${kind === 'read' ? '<span class="muted">Annotated read-only: safe to repeat.</span>' : '<span class="muted">This tool may change data on the server.</span>'}</form>
    <h3>Result</h3><pre class="output">${escapeHtml(state.outputs[key] ?? 'No call yet.')}</pre>`;
}

function resourceDetail(resource: Resource) {
  const key = `resource:${resource.uri}`;
  return `<header class="detail-head"><h2>${escapeHtml(resource.title || resource.name)}</h2><code>${escapeHtml(resource.uri)}</code><div class="badges"><span class="badge resource">Resource</span>${resource.mimeType ? `<span class="badge plain">${escapeHtml(resource.mimeType)}</span>` : ''}</div></header>
    <p>${escapeHtml(resource.description)}</p>
    ${resource._meta ? `<details><summary>_meta</summary><pre>${pretty(resource._meta)}</pre></details>` : ''}
    <button class="run read" data-resource="${escapeHtml(resource.uri)}">Read (resources/read)</button>
    <h3>Result</h3><pre class="output">${escapeHtml(state.outputs[key] ?? 'Not read yet.')}</pre>`;
}

function detail() {
  const selected = findSelected();
  if (!selected) return '<p class="muted">Select a tool or resource on the left.</p>';
  return 'tool' in selected ? toolDetail(selected.tool) : resourceDetail(selected.resource);
}

function render() {
  root.innerHTML = `<header class="topbar"><div><h1>MCP Inspector</h1><p class="muted">Development-only OAuth and MCP surface tester.</p></div>
    <form class="connect" id="connect"><input id="server" value="${escapeHtml(state.serverUrl)}" placeholder="https://example.com/api/mcp" aria-label="MCP endpoint">
    <button type="button" id="authorize">${state.token ? 'Reconnect' : 'Authorize'}</button><button type="button" id="inspect" ${state.token ? '' : 'disabled'}>Inspect server</button>
    <button type="button" id="clear" class="secondary">Clear token</button></form><p class="status">${escapeHtml(state.status)}</p></header>
    <div class="layout"><nav class="sidebar">${sidebar()}</nav><section class="detail">${detail()}</section></div>`;
  root.querySelector<HTMLInputElement>('#server')!.onchange = (event) => { state.serverUrl = (event.target as HTMLInputElement).value.trim(); localStorage.setItem('mcp-inspector-server', state.serverUrl); };
  root.querySelector('#connect')!.addEventListener('submit', (event) => event.preventDefault());
  root.querySelector('#authorize')!.addEventListener('click', () => void authorize().catch((error) => setStatus(error.message)));
  root.querySelector('#inspect')!.addEventListener('click', () => void loadSurface().catch((error) => setStatus(error.message)));
  root.querySelector('#clear')!.addEventListener('click', () => { state.token = ''; sessionStorage.removeItem('mcp-inspector-token'); render(); });
  const filter = root.querySelector<HTMLInputElement>('#filter');
  if (filter) filter.oninput = () => { state.filter = filter.value; const pos = filter.selectionStart; render(); const next = root.querySelector<HTMLInputElement>('#filter')!; next.focus(); next.setSelectionRange(pos, pos); };
  root.querySelectorAll<HTMLButtonElement>('[data-select]').forEach((button) => button.onclick = () => { state.selected = button.dataset.select!; render(); });
  root.querySelectorAll<HTMLFormElement>('form[data-tool]').forEach((form) => {
    const tool = state.tools.find((t) => t.name === form.dataset.tool)!;
    (form.elements.namedItem('arguments') as HTMLTextAreaElement).oninput = (event) => { state.args[tool.name] = (event.target as HTMLTextAreaElement).value; };
    form.onsubmit = (event) => { event.preventDefault(); void runTool(tool); };
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-resource]').forEach((button) => button.onclick = () => void readResource(state.resources.find((r) => r.uri === button.dataset.resource)!));
}

void finishAuthorization().then(() => render()).catch((error) => { state.status = error.message; render(); });

export {};
