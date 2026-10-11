import { toDocRow, dedupeLast, type ChangeRow, type DocRow } from './mapping.js';
import { retryDelay } from './retry.js';

export interface ChangesPage {
  results: ChangeRow[];
  last_seq: string;
}

/** Reads the source database's change feed. Implemented by source.ts for CouchDB/Cloudant. */
export interface Source {
  changes(since: string, limit: number, timeoutMs: number): Promise<ChangesPage>;
}

/** Writes rows and the checkpoint atomically. Implemented by sink.ts for Postgres. */
export interface Sink {
  checkpoint(): Promise<string>;
  apply(rows: DocRow[], lastSeq: string): Promise<void>;
}

export interface BatchResult {
  received: number;
  applied: number;
  lastSeq: string;
  /** True when the long-poll returned nothing, meaning we are at the head of the feed. */
  caughtUp: boolean;
}

export interface BatchOptions {
  batchSize: number;
  pollTimeoutMs: number;
}

/** One pass: read the next page after the checkpoint and apply it. */
export async function syncBatch(
  source: Source,
  sink: Sink,
  { batchSize, pollTimeoutMs }: BatchOptions,
): Promise<BatchResult> {
  const since = await sink.checkpoint();
  const page = await source.changes(since, batchSize, pollTimeoutMs);

  const rows = dedupeLast(
    page.results.flatMap((change) => {
      const row = toDocRow(change);
      return row ? [row] : [];
    }),
  );

  if (page.results.length > 0) {
    await sink.apply(rows, page.last_seq);
  }

  return {
    received: page.results.length,
    applied: rows.length,
    lastSeq: page.results.length > 0 ? page.last_seq : since,
    caughtUp: page.results.length === 0,
  };
}

export interface RunOptions extends BatchOptions {
  source: Source;
  sink: Sink;
  signal: AbortSignal;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onBatch?: (result: BatchResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * Runs batches until aborted. Errors never stop the loop: it waits with
 * exponential backoff and resumes from the stored checkpoint.
 */
export async function runSync(opts: RunOptions): Promise<void> {
  let failures = 0;
  while (!opts.signal.aborted) {
    try {
      const result = await syncBatch(opts.source, opts.sink, opts);
      failures = 0;
      opts.onBatch?.(result);
    } catch (error) {
      failures++;
      opts.onError?.(error);
      await opts.sleep(retryDelay(failures), opts.signal);
    }
  }
}
