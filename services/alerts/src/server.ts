import { createServer, type ServerResponse } from 'node:http';
import type { StoredAlert } from './store.js';

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** GET /alerts?limit=N returns the newest alerts first. CORS is open because the app is on another origin. */
export function createAlertsServer({ store }: { store: { list(limit: number): Promise<StoredAlert[]> } }) {
  return createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (url.pathname === '/alerts' && req.method === 'GET') {
      const requested = Number(url.searchParams.get('limit') ?? 50);
      const limit = Number.isSafeInteger(requested) && requested >= 1 ? Math.min(requested, 200) : 50;
      try {
        return sendJson(res, 200, { alerts: await store.list(limit) });
      } catch (error) {
        return sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    sendJson(res, 404, { error: 'not found' });
  });
}
