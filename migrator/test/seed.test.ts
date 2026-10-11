import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedDocs, resumeState } from '../src/seed.js';

// Deterministic "random": cycles through the same sequence on every run.
function seq() {
  let i = 0;
  return () => ((i = (i * 37 + 11) % 1000) / 1000);
}

test('buildSeedDocs creates customers and orders with consistent references', () => {
  const docs = buildSeedDocs({ customers: 5, orders: 20, random: seq(), now: new Date('2026-01-01T00:00:00Z') });

  const customers = docs.filter((d) => d.type === 'customer');
  const orders = docs.filter((d) => d.type === 'order');
  assert.equal(customers.length, 5);
  assert.equal(orders.length, 20);

  const customerIds = new Set(customers.map((c) => c._id));
  for (const order of orders) {
    assert.ok(customerIds.has(order.customer_id as string), `unknown customer ${order.customer_id}`);
  }
});

test('order totals equal the sum of qty * unit_price', () => {
  const docs = buildSeedDocs({ customers: 3, orders: 10, random: seq(), now: new Date() });
  for (const order of docs.filter((d) => d.type === 'order')) {
    const items = order.items as { qty: number; unit_price: number }[];
    const expected = Number(items.reduce((s, i) => s + i.qty * i.unit_price, 0).toFixed(2));
    assert.equal(order.total, expected);
  }
});

test('doc ids are unique and typed', () => {
  const docs = buildSeedDocs({ customers: 4, orders: 30, random: seq(), now: new Date() });
  assert.equal(new Set(docs.map((d) => d._id)).size, docs.length);
  for (const d of docs) assert.match(d._id, /^(customer|order):\d{4}$/);
});

test('resumeState rebuilds the latest copy of each order and the next order number from existing docs', () => {
  const existing = [
    { _id: 'customer:0001', _rev: '1-c', type: 'customer' },
    { _id: 'order:0001', _rev: '1-a', type: 'order', total: 10 },
    { _id: 'order:0007', _rev: '3-b', type: 'order', total: 20, status: 'paid' },
  ] as const;
  const state = resumeState([...existing]);

  assert.equal(state.next, 8);
  assert.deepEqual([...state.current.keys()].sort(), ['order:0001', 'order:0007']);
  assert.equal(state.current.get('order:0007')?._rev, '3-b');
});

test('resumeState starts at order 1 when the database has no orders', () => {
  const state = resumeState([]);
  assert.equal(state.next, 1);
  assert.equal(state.current.size, 0);
});
