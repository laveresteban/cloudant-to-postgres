import type { FeedEvent } from './rules.js';

/** The migrator's GET /events response. `next` is the cursor to send on the next call. */
export interface FeedPage {
  events: FeedEvent[];
  next: number;
}

export interface FeedClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createFeedClient({ baseUrl, timeoutMs = 10_000, fetchImpl = fetch }: FeedClientOptions) {
  return {
    async read(after: number, limit: number): Promise<FeedPage> {
      const url = new URL('/events', baseUrl);
      url.searchParams.set('after', String(after));
      url.searchParams.set('limit', String(limit));
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`feed responded ${res.status}`);
      return (await res.json()) as FeedPage;
    },
  };
}
