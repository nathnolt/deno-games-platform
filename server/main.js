// One Deno process: serves the client files AND the WebSocket endpoint on the same port.
// Deno has WebSocket servers built in (Deno.upgradeWebSocket), so no `ws` package is needed.
import { Platform } from './platform.js';
import { games } from './games.js';

const platform = new Platform(games);
const port = Number(Deno.env.get('PORT') ?? 8000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const PUBLIC_DIRS = ['/client/', '/shared/', '/games/'];

async function serveStatic(pathname) {
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (pathname === '/') pathname = '/client/index.html';
  const allowed =
    PUBLIC_DIRS.some((d) => pathname.startsWith(d)) && !pathname.includes('..') && !pathname.endsWith('/server.js');
  if (!allowed) return new Response('Not found', { status: 404 });
  try {
    const data = await Deno.readFile(new URL(`..${pathname}`, import.meta.url));
    const ext = pathname.slice(pathname.lastIndexOf('.'));
    return new Response(data, {
      headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

Deno.serve(
  { port, onListen: ({ port }) => console.log(`Games platform on http://localhost:${port}  (games: ${[...games.keys()].join(', ')})`) },
  (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const { socket, response } = Deno.upgradeWebSocket(req);
      platform.connect(socket);
      return response;
    }
    return serveStatic(url.pathname);
  },
);
