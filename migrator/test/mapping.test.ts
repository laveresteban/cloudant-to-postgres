import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDocRow, dedupeLast, type ChangeRow } from '../src/mapping.js';

const change = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  id: 'order:1',
  seq: '5-abc',
  changes: [{ rev: '2-b' }],
  doc: { _id: 'order:1', _rev: '2-b', type: 'order', total: 42 },
  ...over,
});

test('maps a live doc to a row without _id/_rev', () => {
  assert.deepEqual(toDocRow(change()), {
    id: 'order:1',
    rev: '2-b',
    body: { type: 'order', total: 42 },
    deleted: false,
  });
});

test('maps a deleted doc to a tombstone row', () => {
  const row = toDocRow(
    change({ deleted: true, doc: { _id: 'order:1', _rev: '3-c', _deleted: true } }),
  );
  assert.deepEqual(row, { id: 'order:1', rev: '3-c', body: {}, deleted: true });
});

test('skips design documents', () => {
  assert.equal(toDocRow(change({ id: '_design/views' })), null);
});

test('throws when the change has no doc (include_docs missing)', () => {
  assert.throws(() => toDocRow(change({ doc: undefined })), /include_docs=true/);
});

test('dedupeLast keeps the last row per id', () => {
  const rows = [
    { id: 'a', rev: '1-x', body: { v: 1 }, deleted: false },
    { id: 'b', rev: '1-y', body: {}, deleted: false },
    { id: 'a', rev: '2-x', body: { v: 2 }, deleted: false },
  ];
  assert.deepEqual(dedupeLast(rows), [
    { id: 'b', rev: '1-y', body: {}, deleted: false },
    { id: 'a', rev: '2-x', body: { v: 2 }, deleted: false },
  ]);
});
