// Minimal host app for the server tests: a cookie session, one table of notes, two tools.
// Any host app takes this shape: your login, your tables, your tools.
import { z } from 'zod';
import { createMcpAppServer, sessionIdentity } from '../../src/index.js';
import { sqlStore, type SqlDatabase } from '../../src/sql.js';
import { inspectorResponse } from '../../src/inspector.js';

type Env = { NOTES_DB: SqlDatabase };

export default {
  async fetch(request: Request, env: Env) {
    const db = env.NOTES_DB;
    await db.exec('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, summary TEXT);');
    const mcp = createMcpAppServer({
      name: 'notes',
      basePath: '/api/notes',
      scopes: {
        'notes:read': { description: 'Read your notes', required: true },
        'notes:write': { description: 'Attach AI summaries to notes', default: true },
      },
      // The host's own login: a session cookie mapped to a user id.
      identity: sessionIdentity(async (req) => {
        const match = /session=([a-z0-9]+)/.exec(req.headers.get('cookie') || '');
        return match ? { id: 'user-' + match[1] } : null;
      }),
      connectionInfo: {
        resolve: async ({ ownerId }) => ({ user: { displayName: ownerId }, environment: 'test', dataSource: 'notes-d1' }),
      },
      storage: sqlStore(db),
      inspector: inspectorResponse,
      origins: { publicOrigin: 'http://notes.local', webOrigin: 'http://notes.local' },
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
    // Host route used by the test to seed data.
    if (new URL(request.url).pathname === '/seed' && request.method === 'POST') {
      const { owner, id, text } = (await request.json()) as { owner: string; id: string; text: string };
      await db.prepare('INSERT INTO notes(id, owner, text) VALUES (?1, ?2, ?3)').bind(id, owner, text).run();
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
};
