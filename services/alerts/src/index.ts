import { Pool } from 'pg';
import { parseConfig } from './config.js';
import { createFeedClient } from './feed-client.js';
import { runConsumer } from './consumer.js';
import { createAlertStore } from './store.js';
import { createAlertsServer } from './server.js';

const config = parseConfig(process.env);
const pool = new Pool({ connectionString: config.databaseUrl });
const store = createAlertStore({ connect: () => pool.connect() });
const controller = new AbortController();

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));

await store.migrate();

const server = createAlertsServer({ store });
server.listen(config.port, () => log('listening', { port: config.port, feed: config.feedUrl }));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const done = runConsumer({
  feed: createFeedClient({ baseUrl: config.feedUrl }),
  store,
  rules: { highValueThreshold: config.highValueThreshold },
  batchSize: config.batchSize,
  pollMs: config.pollMs,
  signal: controller.signal,
  sleep,
  onResult: (r) => {
    if (r.events > 0) log('consumed', { ...r });
  },
  onError: (error) => log('error', { message: error instanceof Error ? error.message : String(error) }),
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
