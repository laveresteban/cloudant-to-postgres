import { parseConfig } from './config.js';
import { createCouchClient, type CouchClient } from './source.js';

/** A document as written to CouchDB. */
export interface SeedDoc {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
  type: 'customer' | 'order';
  [field: string]: unknown;
}

type Random = () => number;

const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Edsger'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Dijkstra'];
const REGIONS = ['NA', 'EMEA', 'APAC'];
const STATUSES = ['placed', 'paid', 'shipped'];
const CATALOG = [
  { sku: 'LAPTOP-14', unit_price: 1199.0 },
  { sku: 'MONITOR-27', unit_price: 329.5 },
  { sku: 'KEYBOARD-K1', unit_price: 89.9 },
  { sku: 'DOCK-USBC', unit_price: 149.0 },
  { sku: 'HEADSET-X', unit_price: 219.0 },
];
const DAY_MS = 86_400_000;

const pick = <T>(xs: T[], r: number): T => xs[Math.floor(r * xs.length)];
const pad = (n: number) => String(n).padStart(4, '0');

export function makeCustomer(i: number, random: Random, now: Date): SeedDoc {
  const first = pick(FIRST, random());
  const last = pick(LAST, random());
  return {
    _id: `customer:${pad(i)}`,
    type: 'customer',
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
    region: pick(REGIONS, random()),
    created_at: now.toISOString(),
  };
}

export function makeOrder(i: number, customerCount: number, random: Random, now: Date): SeedDoc {
  const customer = 1 + Math.floor(random() * customerCount);
  const lines = 1 + Math.floor(random() * 3);
  const items = Array.from({ length: lines }, () => {
    const product = pick(CATALOG, random());
    return { sku: product.sku, qty: 1 + Math.floor(random() * 4), unit_price: product.unit_price };
  });
  const total = Number(items.reduce((sum, it) => sum + it.qty * it.unit_price, 0).toFixed(2));
  return {
    _id: `order:${pad(i)}`,
    type: 'order',
    customer_id: `customer:${pad(customer)}`,
    status: pick(STATUSES, random()),
    items,
    total,
    created_at: new Date(now.getTime() - Math.floor(random() * 90) * DAY_MS).toISOString(),
  };
}

export function buildSeedDocs({
  customers,
  orders,
  random,
  now,
}: {
  customers: number;
  orders: number;
  random: Random;
  now: Date;
}): SeedDoc[] {
  const docs: SeedDoc[] = [];
  for (let i = 1; i <= customers; i++) docs.push(makeCustomer(i, random, now));
  for (let i = 1; i <= orders; i++) docs.push(makeOrder(i, customers, random, now));
  return docs;
}

/**
 * Rebuilds the live-mode state from documents already in the database: the latest copy
 * of each order (with its _rev, so updates keep every field) and the next order number.
 */
export function resumeState(docs: SeedDoc[]): { current: Map<string, SeedDoc>; next: number } {
  const current = new Map<string, SeedDoc>();
  let highest = 0;
  for (const doc of docs) {
    if (doc.type !== 'order' || doc._deleted) continue;
    current.set(doc._id, doc);
    highest = Math.max(highest, Number(doc._id.slice('order:'.length)));
  }
  return { current, next: highest + 1 };
}

interface BulkResult {
  id: string;
  rev?: string;
  error?: string;
}

async function writeDocs(client: CouchClient, docs: SeedDoc[]): Promise<BulkResult[]> {
  const results = await client.request<BulkResult[]>({
    method: 'POST',
    path: '/_bulk_docs',
    body: { docs },
  });
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) console.log(JSON.stringify({ failed: failed.length, first: failed[0] }));
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * CLI: `node dist/src/seed.js [--count N] [--live]`. Seeds the database once,
 * then with --live keeps creating, shipping and deleting orders so the
 * dashboard has something to show.
 */
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const orderCount = Number(flag('--count') ?? 200);
  const customerCount = 50;

  const config = parseConfig(process.env);
  const client = createCouchClient({
    baseUrl: config.couchUrl,
    db: config.couchDb,
    username: config.couchUser,
    password: config.couchPassword,
  });
  await client.request({ path: '' }).catch(() => client.request({ method: 'PUT', path: '' }));

  // Seed only an empty database. A populated one is resumed, so re-running never conflicts.
  const existing = await client.request<{ rows: { doc?: SeedDoc }[] }>({
    path: '/_all_docs',
    query: {
      include_docs: 'true',
      startkey: JSON.stringify('order:'),
      endkey: JSON.stringify('order:￰'),
    },
  });
  const existingOrders = existing.rows.flatMap((r) => (r.doc ? [r.doc] : []));

  let state: ReturnType<typeof resumeState>;
  if (existingOrders.length > 0) {
    state = resumeState(existingOrders);
    console.log(JSON.stringify({ resumed: existingOrders.length, database: config.couchDb }));
  } else {
    const docs = buildSeedDocs({
      customers: customerCount,
      orders: orderCount,
      random: Math.random,
      now: new Date(),
    });
    const results = await writeDocs(client, docs);
    const written = docs.flatMap((doc, i) => (results[i]?.rev ? [{ ...doc, _rev: results[i].rev }] : []));
    state = resumeState(written);
    console.log(JSON.stringify({ seeded: written.length, database: config.couchDb }));
  }

  if (!args.includes('--live')) return;

  const { current } = state;
  const pickId = () => {
    const ids = [...current.keys()];
    return ids[Math.floor(Math.random() * ids.length)];
  };
  let next = state.next;
  for (let tick = 1; ; tick++) {
    await sleep(1000);

    const order = makeOrder(next++, customerCount, Math.random, new Date());
    const [created] = await writeDocs(client, [order]);
    if (created?.rev) current.set(order._id, { ...order, _rev: created.rev });
    console.log(JSON.stringify({ op: 'create', id: order._id }));

    if (tick % 3 === 0) {
      const id = pickId();
      const doc = id && current.get(id);
      if (doc) {
        const [updated] = await writeDocs(client, [{ ...doc, status: 'shipped' }]);
        if (updated?.rev) current.set(id, { ...doc, status: 'shipped', _rev: updated.rev });
        console.log(JSON.stringify({ op: 'update', id }));
      }
    }

    if (tick % 10 === 0) {
      const id = pickId();
      const doc = id && current.get(id);
      if (doc) {
        await writeDocs(client, [{ _id: id, _rev: doc._rev, _deleted: true, type: 'order' }]);
        current.delete(id);
        console.log(JSON.stringify({ op: 'delete', id }));
      }
    }
  }
}

if (process.argv[1]?.endsWith('seed.js')) {
  await main();
}
