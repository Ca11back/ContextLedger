import { resolve, sep } from 'node:path';

const { default: app } = await import('./dist/server/index.js' as string);
const publicRoot = resolve('dist/client');
const server = Bun.serve({
  hostname: process.env.LEDGER_HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  maxRequestBodySize: Number(process.env.LEDGER_MAX_BODY_BYTES ?? 1048576),
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/assets/')) {
      let path: string;
      try {
        path = resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
      } catch {
        return new Response(null, { status: 400 });
      }
      if (!path.startsWith(publicRoot + sep)) return new Response(null, { status: 404 });
      const file = Bun.file(path);
      if (await file.exists())
        return new Response(file, {
          headers: {
            'Cache-Control': 'public,max-age=31536000,immutable',
            'X-Content-Type-Options': 'nosniff',
          },
        });
    }
    return app.fetch(request);
  },
});
console.log(JSON.stringify({ event: 'listening', port: server.port }));
process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});
