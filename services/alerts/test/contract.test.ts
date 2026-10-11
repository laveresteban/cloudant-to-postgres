// Contract test: the migrator's real feed server (built from ../../migrator) and the
// alerts consumer, talking over HTTP. Only the database is faked. This is where
// field names, cursor types and `after` semantics would break between the services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeEvent, EventReader } from '../../../migrator/dist/src/feed.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFeedClient } from '../src/feed-client.js';
import { consumeOnce } from '../src/consumer.js';
import type { Alert } from '../src/rules.js';

// Value import by path resolved from the package root (npm test runs there). A static
// relative import breaks because the compiled file sits one directory deeper than the source.
const migratorUrl = (file: string) => pathToFileURL(resolve(process.cwd(), '../../migrator/dist/src', file)).href;
const { createStatusServer } = (await import(migratorUrl('server.js'))) as typeof import('../../../migrator/dist/src/server.js');
const { createStatus } = (await import(migratorUrl('status.js'))) as typeof import('../../../migrator/dist/src/status.js');

const at = '2026-01-01T00:00:00.000Z';
const EVENTS: ChangeEvent[] = [
  { event_id: 1, doc_id: 'order:1', rev: '1-a', op: 'create', body: { type: 'order', total: 50 }, created_at: at },
  { event_id: 2, doc_id: 'order:2', rev: '1-b', op: 'create', body: { type: 'order', total: 5000 }, created_at: at },
  { event_id: 3, doc_id: 'order:1', rev: '2-c', op: 'delete', body: {}, created_at: at },
  { event_id: 4, doc_id: 'order:2', rev: '2-d', op: 'update', body: { type: 'order', total: 5000 }, created_at: at },
  { event_id: 5, doc_id: 'customer:1', rev: '1-e', op: 'create', body: { type: 'customer' }, created_at: at },
];

/** Same semantics as the Postgres reader: strictly after the cursor, ordered, limited. */
function memoryReader(events: ChangeEvent[]): EventReader {
  return {
    async read(after, limit) {
      return events.filter((e) => e.event_id > after).slice(0, limit);
    },
  };
}

test('alerts consumer pages through the migrator feed and produces the expected alerts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contract-'));
  await writeFile(join(dir, 'index.html'), '<title>x</title>');
  const server = createStatusServer({
    status: createStatus('shop'),
    publicDir: dir,
    feed: { reader: memoryReader(EVENTS), pollMs: 5, heartbeatMs: 1000 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const saved: Alert[] = [];
  let cursor = 0;
  const feed = createFeedClient({ baseUrl: `http://127.0.0.1:${port}` });
  const store = {
    async cursor() {
      return cursor;
    },
    async save(alerts: Alert[], next: number) {
      saved.push(...alerts);
      cursor = next;
    },
  };
  const deps = { feed, store, rules: { highValueThreshold: 1000 }, batchSize: 2 };

  try {
    // batchSize 2 forces three pages plus one empty poll, so the cursor handoff is exercised.
    const pages = [];
    for (let i = 0; i < 4; i++) pages.push(await consumeOnce(deps));

    assert.deepEqual(pages.map((p) => p.events), [2, 2, 1, 0]);
    assert.equal(cursor, 5);
    assert.equal(pages[3].caughtUp, true);
    assert.deepEqual(
      saved.map((a) => [a.event_id, a.rule]),
      [
        [2, 'high_value_order'],
        [3, 'order_deleted'],
      ],
    );
  } finally {
    server.close();
  }
});

test('a change that arrives after the consumer caught up is picked up on the next poll', async () => {
  const events = [...EVENTS.slice(0, 2)];
  const dir = await mkdtemp(join(tmpdir(), 'contract-'));
  await writeFile(join(dir, 'index.html'), '<title>x</title>');
  const server = createStatusServer({
    status: createStatus('shop'),
    publicDir: dir,
    feed: { reader: memoryReader(events), pollMs: 5, heartbeatMs: 1000 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  let cursor = 0;
  const saved: Alert[] = [];
  const deps = {
    feed: createFeedClient({ baseUrl: `http://127.0.0.1:${port}` }),
    store: {
      async cursor() {
        return cursor;
      },
      async save(alerts: Alert[], next: number) {
        saved.push(...alerts);
        cursor = next;
      },
    },
    rules: { highValueThreshold: 1000 },
    batchSize: 100,
  };

  try {
    await consumeOnce(deps);
    assert.equal((await consumeOnce(deps)).caughtUp, true);

    events.push(EVENTS[2]); // event 3, the delete, arrives after the consumer caught up
    const next = await consumeOnce(deps);
    assert.equal(next.events, 1);
    assert.equal(cursor, 3);
    assert.deepEqual(saved.map((a) => a.rule), ['high_value_order', 'order_deleted']);
  } finally {
    server.close();
  }
});
