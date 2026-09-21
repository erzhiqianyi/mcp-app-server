type Json = Record<string, unknown>;
type Tool = { name: string; title?: string; description?: string; inputSchema?: Json; annotations?: Json; _meta?: Json };
type Resource = { uri: string; name: string; title?: string; description?: string; mimeType?: string; _meta?: Json };

const root = document.querySelector<HTMLDivElement>('#app')!;
const state = {
  serverUrl: localStorage.getItem('mcp-inspector-server') || '',
  clientName: 'MCP Inspector',
  redirectUri: `${location.origin}${location.pathname}`,
  token: sessionStorage.getItem('mcp-inspector-token') || '',
  tools: [] as Tool[],
  resources: [] as Resource[],
  status: '',
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
  const data = await response.json() as Json;
  if (!response.ok) throw new Error(String(data.error_description || data.error || response.statusText));
  return data;
}

async function rpc(method: string, params: Json = {}) {
  return request('', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
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
  const url = new URL(String(meta.authorization_endpoint));
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: String(client.client_id),
    redirect_uri: state.redirectUri,
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
    state: stateValue,
    resource: endpoint(),
  }).toString();
  location.href = url.toString();
}

async function finishAuthorization() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
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
  await fetch(endpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) });
  const tools = await rpc('tools/list');
  const resources = await rpc('resources/list').catch(() => ({ result: { resources: [] } }));
  state.tools = ((tools.result as Json)?.tools || []) as Tool[];
  state.resources = ((resources.result as Json)?.resources || []) as Resource[];
  setStatus(`Connected to ${String((initialized.result as Json)?.serverInfo ? ((initialized.result as Json).serverInfo as Json).name : 'MCP server')}.`);
}

async function callTool(name: string, form: HTMLFormElement, output: HTMLElement) {
  try {
    const raw = form.elements.namedItem('arguments') as HTMLTextAreaElement;
    const result = await rpc('tools/call', { name, arguments: raw.value.trim() ? JSON.parse(raw.value) : {} });
    output.textContent = JSON.stringify(result.result ?? result, null, 2);
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : String(error);
  }
}

function toolCard(tool: Tool) {
  const schema = tool.inputSchema || { type: 'object', properties: {} };
  return `<article class="card"><h3>${escapeHtml(tool.title || tool.name)}</h3>
    <p>${escapeHtml(tool.description)}</p><small>${escapeHtml(tool.name)}${tool._meta ? ` · _meta ${pretty(tool._meta)}` : ''}</small>
    <details><summary>Input schema</summary><pre>${pretty(schema)}</pre></details>
    <form data-tool="${escapeHtml(tool.name)}"><textarea name="arguments" rows="4" placeholder='JSON arguments, e.g. {"query":"hello"}'></textarea><button>Call tool</button></form>
    <pre class="output" data-output="${escapeHtml(tool.name)}">No call yet.</pre></article>`;
}

function render() {
  root.innerHTML = `<header><h1>MCP Inspector</h1><p>Development-only OAuth and MCP surface tester.</p></header>
    <section class="panel"><label>MCP endpoint <input id="server" value="${escapeHtml(state.serverUrl)}" placeholder="https://example.com/api/mcp"></label>
    <button id="authorize">${state.token ? 'Reconnect' : 'Authorize'}</button><button id="inspect" ${state.token ? '' : 'disabled'}>Inspect server</button>
    <button id="clear">Clear token</button><p class="status">${escapeHtml(state.status)}</p></section>
    <section><h2>Tools (${state.tools.length})</h2>${state.tools.length ? state.tools.map(toolCard).join('') : '<p>Authorize and inspect the server to list tools.</p>'}</section>
    <section><h2>Resources (${state.resources.length})</h2>${state.resources.length ? state.resources.map((resource) => `<article class="card"><h3>${escapeHtml(resource.title || resource.name)}</h3><p>${escapeHtml(resource.description)}</p><code>${escapeHtml(resource.uri)}</code><button data-resource="${escapeHtml(resource.uri)}">Read resource</button><pre class="output" data-resource-output="${escapeHtml(resource.uri)}"></pre></article>`).join('') : '<p>No resources advertised.</p>'}</section>`;
  root.querySelector<HTMLInputElement>('#server')!.onchange = (event) => { state.serverUrl = (event.target as HTMLInputElement).value.trim(); localStorage.setItem('mcp-inspector-server', state.serverUrl); };
  root.querySelector('#authorize')!.addEventListener('click', () => void authorize().catch((error) => setStatus(error.message)));
  root.querySelector('#inspect')!.addEventListener('click', () => void loadSurface().catch((error) => setStatus(error.message)));
  root.querySelector('#clear')!.addEventListener('click', () => { state.token = ''; sessionStorage.removeItem('mcp-inspector-token'); render(); });
  root.querySelectorAll<HTMLFormElement>('form[data-tool]').forEach((form) => form.onsubmit = (event) => { event.preventDefault(); void callTool(form.dataset.tool!, form, form.nextElementSibling!); });
  root.querySelectorAll<HTMLButtonElement>('button[data-resource]').forEach((button) => button.onclick = async () => {
    try { const result = await rpc('resources/read', { uri: button.dataset.resource }); root.querySelector(`[data-resource-output="${CSS.escape(button.dataset.resource!)}"]`)!.textContent = JSON.stringify(result.result ?? result, null, 2); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  });
}

void finishAuthorization().then(() => render()).catch((error) => { state.status = error.message; render(); });
