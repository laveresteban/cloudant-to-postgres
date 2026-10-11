import { evaluate, type Alert, type FeedEvent, type RuleOptions } from './rules.js';
import { retryDelay } from './retry.js';

export interface FeedSource {
  read(after: number, limit: number): Promise<{ events: FeedEvent[]; next: number }>;
}

export interface CursorStore {
  cursor(): Promise<number>;
  save(alerts: Alert[], next: number): Promise<void>;
}

export interface ConsumerDeps {
  feed: FeedSource;
  store: CursorStore;
  rules: RuleOptions;
  batchSize: number;
}

export interface ConsumeResult {
  events: number;
  alerts: number;
  cursor: number;
  caughtUp: boolean;
}

/** One pass: read the page after the stored cursor, evaluate the rules, save alerts and cursor together. */
export async function consumeOnce(deps: ConsumerDeps): Promise<ConsumeResult> {
  const after = await deps.store.cursor();
  const page = await deps.feed.read(after, deps.batchSize);
  const alerts = page.events.flatMap((e) => evaluate(e, deps.rules));

  if (page.events.length > 0) {
    await deps.store.save(alerts, page.next);
  }

  return {
    events: page.events.length,
    alerts: alerts.length,
    cursor: page.events.length > 0 ? page.next : after,
    caughtUp: page.events.length === 0,
  };
}

export interface RunOptions extends ConsumerDeps {
  pollMs: number;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  onResult?: (result: ConsumeResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * Pulls until aborted. An error backs off and retries; an empty page waits pollMs.
 * Nothing is lost on failure because the cursor only moves when a save succeeds.
 */
export async function runConsumer(opts: RunOptions): Promise<void> {
  let failures = 0;
  while (!opts.signal.aborted) {
    try {
      const result = await consumeOnce(opts);
      failures = 0;
      opts.onResult?.(result);
      if (result.caughtUp) await opts.sleep(opts.pollMs);
    } catch (error) {
      failures++;
      opts.onError?.(error);
      await opts.sleep(retryDelay(failures));
    }
  }
}
