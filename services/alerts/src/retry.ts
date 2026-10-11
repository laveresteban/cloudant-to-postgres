/** Exponential backoff: attempt 1 waits baseMs, then doubles, capped at maxMs. */
export function retryDelay(attempt: number, { baseMs = 500, maxMs = 30_000 } = {}): number {
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}
