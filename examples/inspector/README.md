# MCP Inspector example

This is a standalone, development-only browser UI for testing an MCP App Server. It performs OAuth PKCE authorization, lists the authorized tools and resources, calls tools with JSON arguments, and displays `content`, `structuredContent`, and errors.

```bash
cd examples/inspector
npm install
npm run build
npm run serve
```

Open <http://127.0.0.1:8787/> and enter the server's MCP endpoint, for example `https://notes.example.com/api/notes/mcp`.

The UI is emitted as static files in `dist/`. Do not deploy this inspector as a production administration page. OAuth does not permit `file://` redirect URIs, so use the included local server for the complete authorization flow.
