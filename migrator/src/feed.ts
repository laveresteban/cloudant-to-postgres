import type { IncomingMessage, ServerResponse } from 'node:http';

/** One committed change, as read from the change_events outbox table. */
export interface ChangeEvent {
  event_id: number;
  doc_id: string;
  rev: string;
  op: 'create' | 'update' | 'delete';
  body: Record<string, unknown>;
  created_at: string;
}

/** Reads events after a cursor. Implemented by createEventReader for Postgres. */
export interface EventReader {
  read(after: number, limit: number): Promise<ChangeEvent[]>;
}

export interface FeedOptions {
  reader: EventReader;
  /** How long the stream waits before polling again when there is nothing new. */
  pollMs: number;
  heartbeatMs: number;
}

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function createEventReader(db: Queryable): EventReader {
  return {
    async read(after, limit) {
      const { rows } = await db.query(
        `SELECT event_id, doc_id, rev, op, body, created_at
         FROM change_events
         WHERE event_id > $1
         ORDER BY event_id
         LIMIT $2`,
        [after, limit],
      );
      // node-postgres returns BIGINT as a string. Comparing string cursors with > is a silent bug.
      return rows.map((r) => ({
        event_id: Number(r.event_id),
        doc_id: r.doc_id as string,
        rev: r.rev as string,
        op: r.op as ChangeEvent['op'],
        body: r.body as Record<string, unknown>,
        created_at: (r.created_at as Date).toISOString(),
      }));
    },
  };
}

/** Cursors are event ids. Anything that is not a non-negative integer starts from zero. */
export function parseCursor(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function parseLimit(value: string | null): number {
  const n = Number(value ?? 100);
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, 500) : 100;
}

/** GET /events?after=N&limit=M: a JSON page for services that pull. */
export async function sendEventPage(
  url: URL,
  res: ServerResponse,
  reader: EventReader,
): Promise<void> {
  const after = parseCursor(url.searchParams.get('after'));
  const limit = parseLimit(url.searchParams.get('limit'));
  const events = await reader.read(after, limit);
  const next = events.length > 0 ? events[events.length - 1].event_id : after;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ events, next }));
}

/**
 * GET /events/stream: Server-Sent Events for browsers. The cursor comes from
 * Last-Event-ID (sent automatically on reconnect) or from ?after=. The loop
 * stops when the client disconnects. A database error ends the stream, and
 * EventSource reconnects with the last id it saw.
 */
export function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { reader, pollMs, heartbeatMs }: FeedOptions,
): void {
  let cursor = parseCursor(
    (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('after'),
  );
  const abort = new AbortController();
  const { signal } = abort;
  res.on('close', () => abort.abort());

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const heartbeat = setInterval(() => {
    if (!signal.aborted) res.write(': keep-alive\n\n');
  }, heartbeatMs);

  (async () => {
    try {
      while (!signal.aborted) {
        const events = await reader.read(cursor, 200);
        for (const e of events) {
          if (signal.aborted) break;
          res.write(`id: ${e.event_id}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = e.event_id;
        }
        if (events.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
      }
    } catch {
      // Fall through: end the stream and let EventSource reconnect.
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  })();
}
