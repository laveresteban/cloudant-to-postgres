import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncBatch, runSync, type Sink, type Source } from '../src/sync.js';
import type { ChangeRow, DocRow } from '../src/mapping.js';

const liveChange = (id: string, seq: string): ChangeRow => ({
  id,
  seq,
  changes: [{ rev: '1-a' }],
  doc: { _id: id, _rev: '1-a', n: seq },
});

function fakeSink(checkpoint = '0') {
  const applied: { rows: DocRow[]; lastSeq: string }[] = [];
  let current = checkpoint;
  const sink: Sink = {
    async checkpoint() {
      return current;
    },
    async apply(rows, lastSeq) {
      applied.push({ rows, lastSeq });
      current = lastSeq;
    },
  };
  return { sink, applied };
}

function fakeSource(pages: { results: ChangeRow[]; last_seq: string }[]) {
  const calls: string[] = [];
  const source: Source = {
    async changes(since) {
      calls.push(since);
      const page = pages.shift();
      if (!page) return { results: [], last_seq: since };
      return page;
    },
  };
  return { source, calls };
}

test('syncBatch resumes from the stored checkpoint and writes rows with the new seq', async () => {
  const { sink, applied } = fakeSink('10-x');
  const { source, calls } = fakeSource([
    { results: [liveChange('a', '11-y')], last_seq: '11-y' },
  ]);

  const result = await syncBatch(source, sink, { batchSize: 500, pollTimeoutMs: 1000 });

  assert.deepEqual(calls, ['10-x']);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].lastSeq, '11-y');
  assert.equal(applied[0].rows[0].id, 'a');
  assert.deepEqual(result, { received: 1, applied: 1, lastSeq: '11-y', caughtUp: false });
});

test('syncBatch does not write to the sink when the feed is empty', async () => {
  const { sink, applied } = fakeSink('7-z');
  const { source } = fakeSource([]);

  const result = await syncBatch(source, sink, { batchSize: 500, pollTimeoutMs: 1000 });

  assert.equal(applied.length, 0);
  assert.deepEqual(result, { received: 0, applied: 0, lastSeq: '7-z', caughtUp: true });
});

test('syncBatch skips design docs but still advances the checkpoint', async () => {
  const { sink, applied } = fakeSink('0');
  const { source } = fakeSource([
    { results: [liveChange('_design/v', '1-d')], last_seq: '1-d' },
  ]);

  await syncBatch(source, sink, { batchSize: 500, pollTimeoutMs: 1000 });

  assert.deepEqual(applied, [{ rows: [], lastSeq: '1-d' }]);
});

test('runSync retries with backoff after an error and keeps going until aborted', async () => {
  const sleeps: number[] = [];
  const controller = new AbortController();
  const { sink } = fakeSink('0');
  let calls = 0;
  const source: Source = {
    async changes(since) {
      calls++;
      if (calls === 1) throw new Error('boom');
      if (calls === 2) return { results: [], last_seq: since };
      controller.abort();
      return { results: [], last_seq: since };
    },
  };
  const errors: string[] = [];

  await runSync({
    source,
    sink,
    batchSize: 10,
    pollTimeoutMs: 1000,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onError: (err) => errors.push((err as Error).message),
  });

  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(sleeps, [500]);
  assert.equal(calls, 3);
});
