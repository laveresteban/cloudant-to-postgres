import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Status } from './status.js';
import { sendEventPage, streamEvents, type FeedOptions } from './feed.js';

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export interface StatusServerOptions {
  status: Status;
  publicDir: string;
  /** Enables /events and /events/stream. Omit to serve only the dashboard and status. */
  feed?: FeedOptions;
}

/**
 * Serves /health, /status, the dashboard, and (when configured) the change feed.
 * CORS is open on every route because the app runs on another origin. Put the
 * feed behind auth before exposing it outside a demo network.
 */
export function createStatusServer({ status, publicDir, feed }: StatusServerOptions): Server {
  return createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (pathname === '/health') return sendJson(res, 200, { ok: true });
    if (pathname === '/status') return sendJson(res, 200, status.snapshot());

    if (feed && pathname === '/events' && req.method === 'GET') {
      try {
        return await sendEventPage(url, res, feed.reader);
      } catch (error) {
        return sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (feed && pathname === '/events/stream' && req.method === 'GET') {
      return streamEvents(req, res, url, feed);
    }

    if (pathname === '/') {
      try {
        const html = await readFile(join(publicDir, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        return sendJson(res, 500, { error: 'dashboard missing' });
      }
    }
    sendJson(res, 404, { error: 'not found' });
  });
}
