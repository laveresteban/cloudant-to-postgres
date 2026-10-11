import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertStore, type SqlClient } from '../src/store.js';
import type { Alert } from '../src/rules.js';

const alert = (event_id: number, rule = 'high_value_order'): Alert => ({
  event_id,
  rule,
  doc_id: `order:${event_id}`,
  message: 'm',
});

function recordingClient(onQuery?: (text: string, params?: unknown[]) => Record<string, unknown>[] | void) {
  const log: { text: string; params?: unknown[] }[] = [];
  const client: SqlClient = {
    async query(text, params) {
      log.push({ text, params });
      return { rows: (onQuery?.(text, params) as Record<string, unknown>[] | undefined) ?? [] };
    },
    release() {
      log.push({ text: 'release' });
    },
  };
  return { client, log, verbs: () => log.map((l) => l.text.trim().split(/\s+/)[0]) };
}

test('save writes each alert idempotently and advances the cursor in one transaction', async () => {
  const { client, verbs, log } = recordingClient();
  const store = createAlertStore({ connect: async () => client });

  await store.save([alert(5), alert(5, 'order_deleted')], 9);

  assert.deepEqual(verbs(), ['BEGIN', 'INSERT', 'INSERT', 'INSERT', 'COMMIT', 'release']);
  assert.match(log[1].text, /ON CONFLICT \(event_id, rule\) DO NOTHING/);
  assert.deepEqual(log[3].params, ['alerts', 9]);
});

test('save with no alerts still advances the cursor, so quiet events are not re-read', async () => {
  const { client, verbs } = recordingClient();
  await createAlertStore({ connect: async () => client }).save([], 12);
  assert.deepEqual(verbs(), ['BEGIN', 'INSERT', 'COMMIT', 'release']);
});

test('save rolls back and rethrows when a write fails, leaving the cursor where it was', async () => {
  const { client, verbs } = recordingClient((text) => {
    if (text.trim().startsWith('INSERT INTO alerts.alerts')) throw new Error('lock timeout');
    return undefined;
  });
  await assert.rejects(createAlertStore({ connect: async () => client }).save([alert(1)], 3), /lock timeout/);
  assert.deepEqual(verbs(), ['BEGIN', 'INSERT', 'ROLLBACK', 'release']);
});

test('cursor returns 0 for a new consumer and a number (not a string) after that', async () => {
  let rows: Record<string, unknown>[] = [];
  const { client } = recordingClient(() => rows);
  const store = createAlertStore({ connect: async () => client });

  assert.equal(await store.cursor(), 0);
  rows = [{ last_event_id: '41' }];
  assert.equal(await store.cursor(), 41);
});

test('list maps stored alerts to JSON-friendly values', async () => {
  const { client } = recordingClient(() => [
    { event_id: '7', rule: 'order_deleted', doc_id: 'order:7', message: 'gone', created_at: new Date('2026-01-02T00:00:00Z') },
  ]);
  const [row] = await createAlertStore({ connect: async () => client }).list(10);
  assert.deepEqual(row, {
    event_id: 7,
    rule: 'order_deleted',
    doc_id: 'order:7',
    message: 'gone',
    created_at: '2026-01-02T00:00:00.000Z',
  });
});

test('migrate creates the service-owned schema and tables', async () => {
  const { client, log } = recordingClient();
  await createAlertStore({ connect: async () => client }).migrate();
  const statements = log.map((l) => l.text);
  assert.match(statements[0], /CREATE SCHEMA IF NOT EXISTS alerts/);
  assert.ok(statements.some((s) => /CREATE TABLE IF NOT EXISTS alerts\.alerts/.test(s)));
  assert.ok(statements.some((s) => /CREATE TABLE IF NOT EXISTS alerts\.cursors/.test(s)));
});
