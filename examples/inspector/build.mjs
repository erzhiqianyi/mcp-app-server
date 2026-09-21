import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  outfile: 'dist/app.js',
});

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MCP Inspector</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <main id="app"></main>
    <script src="app.js"></script>
  </body>
</html>`;

await import('node:fs/promises').then(async (fs) => {
  await fs.mkdir('dist', { recursive: true });
  await fs.writeFile('dist/index.html', html);
  await fs.copyFile('src/style.css', 'dist/style.css');
});
