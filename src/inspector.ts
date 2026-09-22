// Development-only inspector page served from the MCP server's own origin, so the browser never
// crosses origins for OAuth or MCP calls and the redirect URI is simply this page's URL.
// Published as `@ninomae/mcp-app-server/inspector` and deliberately not referenced by the core, so
// hosts that never enable it (production workers) do not bundle the inlined page.
import { script, style } from './inspector/bundle.generated.js';

const escapeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function inspectorHtml(mcpPath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>MCP Inspector</title>
    <style>${style}</style>
  </head>
  <body>
    <main id="app"></main>
    <script>window.__MCP_INSPECTOR__ = ${escapeJson({ mcpPath })};</script>
    <script>${script}</script>
  </body>
</html>`;
}

export function inspectorResponse(mcpPath: string): Response {
  return new Response(inspectorHtml(mcpPath), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}
