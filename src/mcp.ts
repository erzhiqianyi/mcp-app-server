import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { AgentTool, Origins, ToolContext } from './types.js';

const DISCOVERY_METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list']);

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

export function visibleTools(tools: readonly AgentTool[], scopes: readonly string[]) {
  return tools.filter((tool) => !tool.scope || scopes.includes(tool.scope));
}

/** Public, unauthenticated description of the MCP surface. Contains no user data. */
export function describeServer(input: { name: string; version: string; origins: Origins; mcpPath: string; scopes: string[]; tools: readonly AgentTool[]; contract?: string }) {
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
    })),
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
export async function serveMcp(input: { name: string; version: string; tools: readonly AgentTool[]; request: Request; ctx: ToolContext | null }) {
  const { request } = input;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return new Response('Origin denied', { status: 403 });
  const server = new McpServer({ name: input.name, version: input.version });
  const scopes = input.ctx ? input.ctx.scopes : input.tools.map((tool) => tool.scope || '').filter(Boolean);
  for (const tool of visibleTools(input.tools, scopes)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }, async (payload) => {
      if (!input.ctx) return { content: [{ type: 'text' as const, text: 'Authorize this agent with OAuth first' }], isError: true };
      const result = await tool.handler((payload ?? {}) as Record<string, unknown>, input.ctx);
      return { ...result };
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
