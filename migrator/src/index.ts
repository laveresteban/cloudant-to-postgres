import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { parseConfig } from './config.js';
import { createCouchSource } from './source.js';
import { createPostgresSink } from './sink.js';
import { runSync, type BatchResult } from './sync.js';
import { createStatus } from './status.js';
import { createStatusServer } from './server.js';
import { createEventReader } from './feed.js';
import { ensureSchema } from './schema.js';

const config = parseConfig(process.env);
const pool = new Pool({ connectionString: config.databaseUrl });
const status = createStatus(config.couchDb);
const controller = new AbortController();

const source = createCouchSource({
  baseUrl: config.couchUrl,
  db: config.couchDb,
  username: config.couchUser,
  password: config.couchPassword,
});

const sink = createPostgresSink({
  connect: () => pool.connect(),
  sourceDb: config.couchDb,
});

// Sleeps are cut short on shutdown so SIGTERM never waits out a backoff.
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const server = createStatusServer({
  status,
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  feed: {
    reader: createEventReader(pool),
    pollMs: 500,
    heartbeatMs: 15_000,
  },
});

const log = (event: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));

server.listen(config.port, () => log('listening', { port: config.port, db: config.couchDb }));

await ensureSchema(() => pool.connect());

const done = runSync({
  source,
  sink,
  batchSize: config.batchSize,
  pollTimeoutMs: config.pollTimeoutMs,
  signal: controller.signal,
  sleep,
  onBatch: (result: BatchResult) => {
    status.recordBatch(result);
    if (result.applied > 0) log('batch', { ...result });
  },
  onError: (error) => {
    status.recordError(error);
    log('error', { message: error instanceof Error ? error.message : String(error) });
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('shutdown', { signal });
    controller.abort();
    server.close();
  });
}

await done;
await pool.end();
