export interface Config {
  couchUrl: string;
  couchDb: string;
  couchUser: string | undefined;
  couchPassword: string | undefined;
  databaseUrl: string;
  batchSize: number;
  pollTimeoutMs: number;
  port: number;
}

type Env = Record<string, string | undefined>;

function intOr(value: string | undefined, fallback: number): number {
  return value === undefined || value === '' ? fallback : Number(value);
}

export function parseConfig(env: Env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    couchUrl: env.COUCH_URL ?? 'http://localhost:5984',
    couchDb: env.COUCH_DB ?? 'shop',
    couchUser: env.COUCH_USER,
    couchPassword: env.COUCH_PASSWORD,
    databaseUrl,
    batchSize: intOr(env.BATCH_SIZE, 500),
    pollTimeoutMs: intOr(env.POLL_TIMEOUT_MS, 10_000),
    port: intOr(env.PORT, 8090),
  };
}
