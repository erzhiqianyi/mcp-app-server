import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { AgentResource, AgentTool, Origins, ToolContext } from './types.js';

const DISCOVERY_METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'resources/list', 'resources/templates/list']);

/** True when every JSON-RPC message in the body is a metadata method that reveals no user data. */
export async function isDiscoveryRequest(request: Request) {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  const messages = Array.isArray(body) ? body : [body];
  return messages.length > 0 && messages.every((m) => m && typeof m === 'object' && DISCOVERY_METHODS.has(String((m as { method?: unknown }).method)));
}

export function visibleTools<T extends { scope?: string }>(tools: readonly T[], scopes: readonly string[]) {
  return tools.filter((tool) => !tool.scope || scopes.includes(tool.scope));
}

/** Public, unauthenticated description of the MCP surface. Contains no user data. */
export function describeServer(input: { name: string; version: string; origins: Origins; mcpPath: string; scopes: string[]; tools: readonly AgentTool[]; resources?: readonly AgentResource[]; contract?: string }) {
  const publicOrigin = input.origins.publicOrigin;
  return {
    name: input.name,
    version: input.version,
    transport: 'streamable-http',
    endpoint: publicOrigin + input.mcpPath,
    authorization: { type: 'oauth2', resourceMetadata: publicOrigin + '/.well-known/oauth-protected-resource', scopes: input.scopes },
    tools: input.tools.map((tool) => ({
      name: tool.name,
      scope: tool.scope ?? null,
      description: tool.description,
      inputSchema: z.toJSONSchema(z.object(tool.inputSchema), { unrepresentable: 'any' }),
      annotations: tool.annotations,
      ...(tool._meta ? { _meta: tool._meta } : {}),
    })),
    ...(input.resources?.length
      ? { resources: input.resources.map((resource) => ({ uri: resource.uri, name: resource.name, scope: resource.scope ?? null, mimeType: resource.mimeType ?? null, ...(resource._meta ? { _meta: resource._meta } : {}) })) }
      : {}),
    ...(input.contract ? { contract: input.contract } : {}),
  };
}

/** Minimal `server.json` for the official MCP registry. Namespace is the host's (e.g. `io.github.<user>/<name>`). */
export function registryEntry(input: { namespace: string; name: string; version: string; description: string; origins: Origins; mcpPath: string }) {
  return {
    name: `${input.namespace}/${input.name}`,
    description: input.description,
    version: input.version,
    remotes: [{ type: 'streamable-http', url: input.origins.publicOrigin + input.mcpPath }],
  };
}

/**
 * Serves one MCP request. `ctx` is null for anonymous discovery, in which case every tool is listed
 * but the handler is never reachable because tools/call is rejected before this point.
 */
export async function serveMcp(input: { name: string; version: string; tools: readonly AgentTool[]; resources?: readonly AgentResource[]; request: Request; ctx: ToolContext | null }) {
  const { request } = input;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return new Response('Origin denied', { status: 403 });
  const server = new McpServer({ name: input.name, version: input.version });
  const scopes = input.ctx ? input.ctx.scopes : [...input.tools, ...(input.resources ?? [])].map((entry) => entry.scope || '').filter(Boolean);
  for (const tool of visibleTools(input.tools, scopes)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations, _meta: tool._meta }, async (payload) => {
      if (!input.ctx) return { content: [{ type: 'text' as const, text: 'Authorize this agent with OAuth first' }], isError: true };
      const result = await tool.handler((payload ?? {}) as Record<string, unknown>, input.ctx);
      return { ...result };
    });
  }
  for (const resource of visibleTools(input.resources ?? [], scopes)) {
    server.registerResource(resource.name, resource.uri, { title: resource.title, description: resource.description, mimeType: resource.mimeType, _meta: resource._meta }, async () => {
      if (!input.ctx) throw new Error('Authorize this agent with OAuth first');
      return { contents: await resource.read(input.ctx) };
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
