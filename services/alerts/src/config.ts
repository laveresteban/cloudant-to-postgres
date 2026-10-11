export interface Config {
  feedUrl: string;
  databaseUrl: string;
  port: number;
  highValueThreshold: number;
  batchSize: number;
  pollMs: number;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const num = (v: string | undefined, fallback: number) => (v === undefined || v === '' ? fallback : Number(v));
  return {
    feedUrl: env.FEED_URL ?? 'http://localhost:8090',
    databaseUrl,
    port: num(env.PORT, 8095),
    highValueThreshold: num(env.HIGH_VALUE_THRESHOLD, 1000),
    batchSize: num(env.BATCH_SIZE, 200),
    pollMs: num(env.POLL_MS, 1000),
  };
}
