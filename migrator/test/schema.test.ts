import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, readSchema } from '../src/schema.js';

test('the schema file creates the landing, checkpoint and outbox tables', async () => {
  const sql = await readSchema();
  for (const table of ['docs', 'checkpoints', 'change_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test('ensureSchema runs the whole file as a single idempotent statement and releases the client', async () => {
  const sent: string[] = [];
  let released = false;
  await ensureSchema(async () => ({
    async query(text: string) {
      sent.push(text);
      return { rows: [] };
    },
    release() {
      released = true;
    },
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /CREATE TABLE IF NOT EXISTS docs/);
  assert.equal(released, true);
});
