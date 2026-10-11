import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventReader, type ChangeEvent, type EventReader } from '../src/feed.js';
import { createStatusServer } from '../src/server.js';
import { createStatus } from '../src/status.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const event = (n: number): ChangeEvent => ({
  event_id: n,
  doc_id: `order:${n}`,
  rev: `1-${n}`,
  op: 'create',
  body: { type: 'order', total: n * 10 },
  created_at: '2026-01-01T00:00:00.000Z',
});

/** Serves events from an in-memory list, like change_events does. */
function memoryReader(events: ChangeEvent[]) {
  const calls: { after: number; limit: number }[] = [];
  const reader: EventReader = {
    async read(after, limit) {
      calls.push({ after, limit });
      return events.filter((e) => e.event_id > after).slice(0, limit);
    },
  };
  return { reader, calls };
}

async function startServer(reader: EventReader, pollMs = 10) {
  const dir = await mkdtemp(join(tmpdir(), 'feed-'));
  await writeFile(join(dir, 'index.html'), '<title>x</title>');
  const server = createStatusServer({
    status: createStatus('shop'),
    publicDir: dir,
    feed: { reader, pollMs, heartbeatMs: 25 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}` };
}

test('createEventReader converts BIGINT event ids to numbers and passes the cursor as a parameter', async () => {
  const calls: unknown[][] = [];
  const reader = createEventReader({
    async query(text, params) {
      calls.push(params ?? []);
      assert.match(text, /WHERE event_id > \$1\s+ORDER BY event_id\s+LIMIT \$2/);
      return {
        rows: [
          { event_id: '7', doc_id: 'order:1', rev: '1-a', op: 'update', body: {}, created_at: new Date('2026-01-01T00:00:00Z') },
        ],
      };
    },
  });

  const [first] = await reader.read(6, 50);

  assert.deepEqual(calls, [[6, 50]]);
  assert.equal(first.event_id, 7);
  assert.equal(typeof first.event_id, 'number');
  assert.equal(first.created_at, '2026-01-01T00:00:00.000Z');
});

test('GET /events returns a JSON page and the cursor to continue from', async () => {
  const { reader } = memoryReader([event(1), event(2), event(3)]);
  const { server, base } = await startServer(reader);
  try {
    const res = await fetch(`${base}/events?after=0&limit=2`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = (await res.json()) as { events: ChangeEvent[]; next: number };
    assert.deepEqual(body.events.map((e) => e.event_id), [1, 2]);
    assert.equal(body.next, 2);

    const empty = (await (await fetch(`${base}/events?after=3`)).json()) as { events: unknown[]; next: number };
    assert.deepEqual(empty, { events: [], next: 3 });
  } finally {
    server.close();
  }
});

test('GET /events rejects a non-numeric cursor by starting from zero', async () => {
  const { reader, calls } = memoryReader([event(1)]);
  const { server, base } = await startServer(reader);
  try {
    await fetch(`${base}/events?after=banana`);
    assert.deepEqual(calls[0], { after: 0, limit: 100 });
  } finally {
    server.close();
  }
});

test('GET /events/stream sends each event with its id, resumes from Last-Event-ID, and heartbeats', async () => {
  const { reader, calls } = memoryReader([event(1), event(2), event(3)]);
  const { server, base } = await startServer(reader);
  try {
    const controller = new AbortController();
    const res = await fetch(`${base}/events/stream`, {
      headers: { 'last-event-id': '1' },
      signal: controller.signal,
    });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of res.body!) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes('id: 3') && text.includes(': keep-alive')) break;
    }
    controller.abort();

    assert.equal(calls[0].after, 1, 'first read starts after Last-Event-ID');
    assert.doesNotMatch(text, /id: 1\n/);
    assert.match(text, /id: 2\nevent: change\ndata: \{"event_id":2/);
    assert.match(text, /id: 3\nevent: change\ndata: \{"event_id":3/);
  } finally {
    server.close();
  }
});

test('GET /events/stream stops polling once the client disconnects', async () => {
  const calls: number[] = [];
  const reader: EventReader = {
    async read(after) {
      calls.push(after);
      return [];
    },
  };
  const { server, base } = await startServer(reader, 5);
  try {
    const controller = new AbortController();
    const res = await fetch(`${base}/events/stream`, { signal: controller.signal });
    await res.body!.getReader().read(); // first heartbeat proves the stream is open
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));

    const afterDisconnect = calls.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls.length, afterDisconnect, 'the loop kept reading after disconnect');
  } finally {
    server.close();
  }
});
