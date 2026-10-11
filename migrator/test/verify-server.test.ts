import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMigration, type VerifyDeps } from '../src/verify.js';
import { createStatus } from '../src/status.js';
import { createStatusServer } from '../src/server.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  const target = new Map([
    ['a', { rev: '1-x', body: { n: 1, t: 'x' }, deleted: false }],
    ['b', { rev: '2-y', body: { n: 2 }, deleted: false }],
  ]);
  return {
    countSource: async () => 2,
    countTarget: async () => 2,
    sampleSource: async () => [
      { id: 'a', rev: '1-x', body: { t: 'x', n: 1 } },
      { id: 'b', rev: '2-y', body: { n: 2 } },
    ],
    targetRow: async (id) => target.get(id) ?? null,
    sampleSize: 2,
    ...over,
  };
}

test('verify passes when counts match and sampled bodies are equal', async () => {
  const report = await verifyMigration(deps());
  assert.deepEqual(report, { ok: true, sourceDocs: 2, targetDocs: 2, sampled: 2, mismatches: [] });
});

test('verify reports missing rows, stale revs and different bodies', async () => {
  const report = await verifyMigration(
    deps({
      countTarget: async () => 1,
      sampleSource: async () => [
        { id: 'a', rev: '9-z', body: { n: 1, t: 'x' } },
        { id: 'b', rev: '2-y', body: { n: 99 } },
        { id: 'gone', rev: '1-q', body: {} },
      ],
    }),
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches, [
    { id: 'a', reason: 'rev' },
    { id: 'b', reason: 'body' },
    { id: 'gone', reason: 'missing' },
  ]);
});

test('status server answers /health and /status and serves the dashboard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dash-'));
  await writeFile(join(dir, 'index.html'), '<title>dash</title>');
  const status = createStatus('shop');
  const server = createStatusServer({ status, publicDir: dir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const snap = (await (await fetch(`${base}/status`)).json()) as { database: string };
    assert.equal(snap.database, 'shop');
    assert.match(await (await fetch(`${base}/`)).text(), /dash/);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});
