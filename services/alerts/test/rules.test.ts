import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type FeedEvent } from '../src/rules.js';

const opts = { highValueThreshold: 1000 };

const event = (over: Partial<FeedEvent>): FeedEvent => ({
  event_id: 1,
  doc_id: 'order:0001',
  rev: '1-a',
  op: 'create',
  body: { type: 'order', total: 50 },
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

test('a new order at or above the threshold raises high_value_order', () => {
  const alerts = evaluate(event({ body: { type: 'order', total: 1000 } }), opts);
  assert.deepEqual(alerts, [
    { event_id: 1, rule: 'high_value_order', doc_id: 'order:0001', message: 'Order order:0001 placed for 1000' },
  ]);
});

test('a small order raises nothing', () => {
  assert.deepEqual(evaluate(event({ body: { type: 'order', total: 999.99 } }), opts), []);
});

test('the threshold rule only fires on create, not on later updates', () => {
  assert.deepEqual(evaluate(event({ op: 'update', body: { type: 'order', total: 5000 } }), opts), []);
});

test('a deleted order raises order_deleted, keyed on the id because tombstones have no body', () => {
  const alerts = evaluate(event({ op: 'delete', body: {} }), opts);
  assert.deepEqual(alerts, [
    { event_id: 1, rule: 'order_deleted', doc_id: 'order:0001', message: 'Order order:0001 was deleted' },
  ]);
});

test('a deleted customer raises nothing', () => {
  assert.deepEqual(evaluate(event({ op: 'delete', doc_id: 'customer:0001', body: {} }), opts), []);
});
