import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertsServer } from '../src/server.js';

test('GET /alerts returns stored alerts with the requested limit, and /health answers', async () => {
  const seenLimits: number[] = [];
  const server = createAlertsServer({
    store: {
      async list(limit) {
        seenLimits.push(limit);
        return [{ event_id: 3, rule: 'order_deleted', doc_id: 'order:3', message: 'gone', created_at: 'x' }];
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/alerts?limit=5`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = (await res.json()) as { alerts: { rule: string }[] };
    assert.equal(body.alerts[0].rule, 'order_deleted');
    assert.deepEqual(seenLimits, [5]);

    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test('GET /alerts clamps the limit to 1..200 and defaults to 50', async () => {
  const seenLimits: number[] = [];
  const server = createAlertsServer({
    store: {
      async list(limit) {
        seenLimits.push(limit);
        return [];
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${base}/alerts`);
    await fetch(`${base}/alerts?limit=99999`);
    await fetch(`${base}/alerts?limit=-3`);
    assert.deepEqual(seenLimits, [50, 200, 50]);
  } finally {
    server.close();
  }
});
