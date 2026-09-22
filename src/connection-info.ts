import type { AgentTool, ConnectionInfo, ConnectionInfoOptions } from './types.js';

/** Only explicit public fields are serialized, even when a host returns a full database row. */
export function connectionInfoTool(options: ConnectionInfoOptions, server: { name: string; version: string; endpoint: (request: Request) => string }): AgentTool {
  const name = options.toolName ?? 'get_connection_info';
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name)) throw new Error('Invalid connection info tool name');
  return {
    name,
    description: 'Return the account bound to this MCP authorization, client, permissions, service endpoint and host-provided data environment. Use to diagnose account or environment mismatches. Browser account changes do not switch this authorization. This does not verify data synchronization.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async handler(_args, ctx) {
      const details = await options.resolve?.({ ownerId: ctx.ownerId, scopes: [...ctx.scopes], grantId: ctx.grantId, clientId: ctx.clientId, clientName: ctx.clientName });
      const user = details?.user;
      const info: ConnectionInfo = {
        user: {
          id: ctx.ownerId,
          status: details ? (user ? 'active' : 'missing') : 'unknown',
          ...(user?.displayName !== undefined ? { displayName: user.displayName } : {}),
          ...(user?.email !== undefined ? { email: user.email } : {}),
          ...(user?.identities ? { identities: user.identities.map(({ provider, subject, issuer }) => ({ provider, subject, ...(issuer !== undefined ? { issuer } : {}) })) } : {}),
        },
        connection: {
          transport: 'streamable-http', endpoint: server.endpoint(ctx.request),
          clientId: ctx.clientId, clientName: ctx.clientName, grantId: ctx.grantId, scopes: [...ctx.scopes],
        },
        server: {
          name: server.name, version: server.version,
          ...(details?.environment !== undefined ? { environment: details.environment } : {}),
          ...(details?.dataSource !== undefined ? { dataSource: details.dataSource } : {}),
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }], structuredContent: { ...info } };
    },
  };
}
