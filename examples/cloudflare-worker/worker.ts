// A complete host: Cloudflare Worker + D1, a cookie session, one table of notes, two tools.
// Deploy with `wrangler deploy`, then connect any MCP client to https://<your-domain>/api/notes/mcp.
import { z } from 'zod';
import { createMcpAppServer, sessionIdentity } from '@erzhiqian/mcp-app-server';
import { sqlStore, type SqlDatabase } from '@erzhiqian/mcp-app-server/sql';

type Env = { NOTES_DB: SqlDatabase; PUBLIC_ORIGIN: string };

export default {
  async fetch(request: Request, env: Env) {
    const db = env.NOTES_DB;
    await db.exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, summary TEXT);');

    const mcp = createMcpAppServer({
      name: 'notes',
      basePath: '/api/notes',
      consentPath: '/oauth/authorize',
      scopes: {
        'notes:read': { description: 'Read your notes', required: true },
        'notes:write': { description: 'Attach AI summaries to notes', default: true },
      },
      // Your own login. Replace with jwtIdentity(...) / firebaseIdentity(...) as needed.
      identity: sessionIdentity(async (req) => {
        const match = /session=([a-z0-9]+)/.exec(req.headers.get('cookie') || '');
        return match ? { id: 'user-' + match[1] } : null;
      }),
      storage: sqlStore(db),
      origins: { publicOrigin: env.PUBLIC_ORIGIN, webOrigin: env.PUBLIC_ORIGIN },
      onEvent: (event) => console.log(JSON.stringify(event)),
      tools: [
        {
          name: 'notes_list',
          scope: 'notes:read',
          description: 'List the signed-in user’s notes.',
          inputSchema: {},
          annotations: { readOnlyHint: true, openWorldHint: false },
          handler: async (_args, ctx) => {
            const rows = (await db.prepare('SELECT id, text, summary FROM notes WHERE owner = ?1').bind(ctx.ownerId).all()).results || [];
            return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
          },
        },
        {
          name: 'notes_summarize',
          scope: 'notes:write',
          description: 'Store an agent-written summary for one note.',
          inputSchema: { id: z.string(), summary: z.string().max(500) },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
          handler: async ({ id, summary }, ctx) => {
            const result = await db.prepare('UPDATE notes SET summary = ?1 WHERE id = ?2 AND owner = ?3').bind(summary, id, ctx.ownerId).run();
            return { content: [{ type: 'text', text: JSON.stringify({ updated: result.meta.changes }) }], isError: !result.meta.changes };
          },
        },
      ],
    });

    await mcp.ensureSchema();
    const handled = await mcp.fetch(request);
    if (handled) return handled;

    // Everything below is your existing app. Agent tokens are also accepted on your own routes:
    const grant = await mcp.authenticate(request);
    if (grant) return new Response(`agent ${grant.clientName} acting for ${grant.ownerId}`);
    return new Response('not found', { status: 404 });
  },
};
