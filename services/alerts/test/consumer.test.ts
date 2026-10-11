import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeOnce, runConsumer, type ConsumerDeps } from '../src/consumer.js';
import type { Alert, FeedEvent } from '../src/rules.js';

const order = (id: number, total: number): FeedEvent => ({
  event_id: id,
  doc_id: `order:${id}`,
  rev: '1-a',
  op: 'create',
  body: { type: 'order', total },
  created_at: '2026-01-01T00:00:00.000Z',
});

/** A feed that returns one scripted page, plus a store that records saves. */
function fakes(page: { events: FeedEvent[]; next: number }, cursor: number) {
  const saved: { alerts: Alert[]; cursor: number }[] = [];
  const reads: number[] = [];
  let position = cursor;
  const deps: ConsumerDeps = {
    feed: {
      async read(after) {
        reads.push(after);
        return page;
      },
    },
    store: {
      async cursor() {
        return position;
      },
      async save(alerts, next) {
        saved.push({ alerts, cursor: next });
        position = next;
      },
    },
    rules: { highValueThreshold: 1000 },
    batchSize: 100,
  };
  return { deps, saved, reads };
}

test('consumeOnce reads after the stored cursor and saves alerts with the page cursor', async () => {
  const { deps, saved, reads } = fakes({ events: [order(5, 2000), order(6, 10)], next: 6 }, 4);

  const result = await consumeOnce(deps);

  assert.deepEqual(reads, [4]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].cursor, 6);
  assert.deepEqual(saved[0].alerts.map((a) => a.event_id), [5]);
  assert.deepEqual(result, { events: 2, alerts: 1, cursor: 6, caughtUp: false });
});

test('consumeOnce does not write when the feed is empty', async () => {
  const { deps, saved } = fakes({ events: [], next: 9 }, 9);
  const result = await consumeOnce(deps);
  assert.equal(saved.length, 0);
  assert.deepEqual(result, { events: 0, alerts: 0, cursor: 9, caughtUp: true });
});

test('runConsumer backs off after an error, then waits the poll interval when caught up', async () => {
  const sleeps: number[] = [];
  const errors: string[] = [];
  const controller = new AbortController();
  let calls = 0;
  const { deps } = fakes({ events: [], next: 0 }, 0);
  deps.feed.read = async (after) => {
    calls++;
    if (calls === 1) throw new Error('feed down');
    return { events: [], next: after };
  };

  await runConsumer({
    ...deps,
    pollMs: 1000,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) controller.abort();
    },
    onError: (e) => errors.push((e as Error).message),
  });

  assert.deepEqual(errors, ['feed down']);
  assert.deepEqual(sleeps, [500, 1000]);
});
