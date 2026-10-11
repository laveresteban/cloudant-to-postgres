import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCouchSource } from '../src/source.js';
import { createPostgresSink, type SqlClient } from '../src/sink.js';
import { createStatus } from '../src/status.js';
import { canonicalize } from '../src/verify.js';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('couch source retries 503 responses and then returns the changes page', async () => {
  const responses = [jsonResponse(503, {}), jsonResponse(200, { results: [], last_seq: '3-q' })];
  const urls: string[] = [];
  const source = createCouchSource({
    baseUrl: 'http://couch:5984',
    db: 'shop',
    fetchImpl: async (url) => {
      urls.push(String(url));
      return responses.shift()!;
    },
    sleep: async () => {},
  });

  const page = await source.changes('0', 10, 1000);

  assert.equal(page.last_seq, '3-q');
  assert.equal(urls.length, 2);
  const url = new URL(urls[1]);
  assert.equal(url.pathname, '/shop/_changes');
  assert.equal(url.searchParams.get('since'), '0');
  assert.equal(url.searchParams.get('include_docs'), 'true');
  assert.equal(url.searchParams.get('feed'), 'longpoll');
});

test('couch source fails immediately on non-retryable errors such as 401', async () => {
  const source = createCouchSource({
    baseUrl: 'http://couch:5984',
    db: 'shop',
    fetchImpl: async () => jsonResponse(401, { error: 'unauthorized' }),
    sleep: async () => {},
  });
  await assert.rejects(source.changes('0', 10, 1000), /401/);
});

test('postgres sink writes rows and checkpoint inside one transaction', async () => {
  const log: string[] = [];
  const client: SqlClient = {
    async query(text) {
      log.push(text.trim().split(/\s+/)[0]);
      return { rows: [] };
    },
    release() {
      log.push('release');
    },
  };
  const sink = createPostgresSink({ connect: async () => client, sourceDb: 'shop' });

  await sink.apply([{ id: 'a', rev: '1-x', body: {}, deleted: false }], '9-z');

  assert.deepEqual(log, ['BEGIN', 'WITH', 'INSERT', 'COMMIT', 'release']);
});

test('postgres sink rolls back and does not commit when a write fails', async () => {
  const log: string[] = [];
  const client: SqlClient = {
    async query(text) {
      const verb = text.trim().split(/\s+/)[0];
      log.push(verb);
      if (verb === 'WITH') throw new Error('disk full');
      return { rows: [] };
    },
    release() {
      log.push('release');
    },
  };
  const sink = createPostgresSink({ connect: async () => client, sourceDb: 'shop' });

  await assert.rejects(
    sink.apply([{ id: 'a', rev: '1-x', body: {}, deleted: false }], '9-z'),
    /disk full/,
  );
  assert.deepEqual(log, ['BEGIN', 'WITH', 'ROLLBACK', 'release']);
});

test('postgres sink emits one change event per changed doc, in the same statement as the upsert', async () => {
  const statements: string[] = [];
  const client: SqlClient = {
    async query(text) {
      statements.push(text);
      return { rows: [] };
    },
    release() {},
  };
  await createPostgresSink({ connect: async () => client, sourceDb: 'shop' }).apply(
    [{ id: 'a', rev: '2-x', body: { n: 1 }, deleted: false }],
    '3-z',
  );

  const upsert = statements.find((s) => s.includes('ON CONFLICT (id)'))!;
  assert.match(upsert, /INSERT INTO change_events/);
  assert.match(upsert, /WHERE docs\.rev IS DISTINCT FROM EXCLUDED\.rev/);
  assert.match(upsert, /RETURNING id, rev, body, deleted, \(xmax = 0\) AS inserted/);
});

test('postgres sink reads the stored checkpoint, or 0 when none exists', async () => {
  let stored: Record<string, unknown>[] = [];
  const client: SqlClient = {
    async query(text, params) {
      assert.match(text, /FROM checkpoints WHERE source_db = \$1/);
      assert.deepEqual(params, ['shop']);
      return { rows: stored };
    },
    release() {},
  };
  const sink = createPostgresSink({ connect: async () => client, sourceDb: 'shop' });

  assert.equal(await sink.checkpoint(), '0');
  stored = [{ last_seq: '42-abc' }];
  assert.equal(await sink.checkpoint(), '42-abc');
});

test('postgres sink only advances the checkpoint when there are no rows', async () => {
  const log: string[] = [];
  const client: SqlClient = {
    async query(text, params) {
      log.push(text.trim().split(/\s+/)[0]);
      if (params) log.push(String(params[1]));
      return { rows: [] };
    },
    release() {},
  };
  await createPostgresSink({ connect: async () => client, sourceDb: 'shop' }).apply([], '12-k');
  assert.deepEqual(log, ['BEGIN', 'INSERT', '12-k', 'COMMIT']);
});

test('status tracks docs applied, checkpoint, caught-up and the last error', () => {
  const status = createStatus('shop');
  status.recordBatch({ received: 2, applied: 2, lastSeq: '5-a', caughtUp: false });
  status.recordError(new Error('connection reset'));
  status.recordBatch({ received: 0, applied: 0, lastSeq: '5-a', caughtUp: true });

  const snap = status.snapshot();
  assert.equal(snap.database, 'shop');
  assert.equal(snap.docsApplied, 2);
  assert.equal(snap.checkpoint, '5-a');
  assert.equal(snap.caughtUp, true);
  assert.equal(snap.lastError, null);
});

test('canonicalize produces the same string regardless of key order', () => {
  assert.equal(
    canonicalize({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }),
    canonicalize({ a: { c: null, d: [{ y: 2, z: 1 }] }, b: 1 }),
  );
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: '1' }));
});
