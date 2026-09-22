# MCP Inspector (standalone)

The inspector page is part of the library: set `inspector: true` in `createMcpAppServer` and open `<base>/mcp/inspector` on your server — same origin, no CORS, endpoint pre-filled. That is the recommended way to use it; see the README's "Testing with the inspector".

This folder builds the same source (`src/inspector/page.ts` + `page.css`) as static files for the cases where you cannot change the server: point it at a remote endpoint from `http://127.0.0.1:8787`.

```bash
cd examples/inspector
npm install
npm run build
npm run serve
```

Open <http://127.0.0.1:8787/> and enter the server's MCP endpoint, for example `https://notes.example.com/api/notes/mcp`.

Limitations of this cross-origin mode:

- The target server must answer CORS preflights and send `Access-Control-Allow-Origin` for `POST <base>/oauth/register`, `POST <base>/oauth/token` and `POST <base>/mcp`. `@ninomae/mcp-app-server` accepts loopback `Origin` headers on `/mcp` but does not emit CORS headers, so a stock deployment will be blocked by the browser here; the hosted page avoids the problem entirely.
- OAuth does not permit `file://` redirect URIs, so use the included local server for the complete authorization flow.
- Do not deploy the `dist/` output as a production administration page.
