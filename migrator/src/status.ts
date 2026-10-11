import type { BatchResult } from './sync.js';

export interface StatusSnapshot {
  database: string;
  startedAt: string;
  docsApplied: number;
  checkpoint: string | null;
  caughtUp: boolean;
  lastBatchAt: string | null;
  lastError: string | null;
}

/**
 * In-memory counters behind /status and the dashboard. CouchDB seqs are opaque
 * strings, so "how far behind" is reported as caughtUp rather than a number.
 */
export function createStatus(database: string) {
  const startedAt = new Date().toISOString();
  let docsApplied = 0;
  let checkpoint: string | null = null;
  let caughtUp = false;
  let lastBatchAt: string | null = null;
  let lastError: string | null = null;

  return {
    recordBatch(result: BatchResult) {
      docsApplied += result.applied;
      checkpoint = result.lastSeq;
      caughtUp = result.caughtUp;
      lastBatchAt = new Date().toISOString();
      lastError = null;
    },
    recordError(error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    },
    snapshot(): StatusSnapshot {
      return { database, startedAt, docsApplied, checkpoint, caughtUp, lastBatchAt, lastError };
    },
  };
}

export type Status = ReturnType<typeof createStatus>;
