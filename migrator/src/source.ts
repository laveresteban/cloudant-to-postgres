import type { ChangesPage, Source } from './sync.js';
import { retryDelay } from './retry.js';

export interface CouchOptions {
  baseUrl: string;
  db: string;
  username?: string;
  password?: string;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface CouchRequest {
  method?: 'GET' | 'PUT' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface CouchClient {
  /** Retries network errors and 429/5xx for reads only; writes fail fast. */
  request<T>(req: CouchRequest): Promise<T>;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/**
 * Minimal CouchDB/Cloudant HTTP client. Cloudant speaks the same API, so
 * pointing baseUrl at a Cloudant URL with basic credentials is the only change.
 */
export function createCouchClient(opts: CouchOptions): CouchClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 5;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.username !== undefined && opts.password !== undefined) {
    const token = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
    headers.authorization = `Basic ${token}`;
  }
  const dbRoot = `${opts.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(opts.db)}`;

  return {
    async request<T>({ method = 'GET', path, query, body, timeoutMs = 30_000 }: CouchRequest) {
      const url = new URL(`${dbRoot}${path}`);
      url.search = new URLSearchParams(query ?? {}).toString();
      const retryable = method === 'GET';
      const init = (): RequestInit => ({
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(url, init());
        } catch (error) {
          if (!retryable || attempt >= maxAttempts) throw error;
          await sleep(retryDelay(attempt));
          continue;
        }
        if (res.ok) return (await res.json()) as T;
        if (!retryable || !RETRYABLE(res.status) || attempt >= maxAttempts) {
          throw new Error(`CouchDB ${res.status} for ${method} ${url.pathname}`);
        }
        await sleep(retryDelay(attempt));
      }
    },
  };
}

/** The sync source: a long-poll `_changes` feed with bodies included. */
export function createCouchSource(opts: CouchOptions): Source {
  const client = createCouchClient(opts);
  return {
    async changes(since, limit, timeoutMs): Promise<ChangesPage> {
      return client.request<ChangesPage>({
        path: '/_changes',
        query: {
          feed: 'longpoll',
          since,
          limit: String(limit),
          include_docs: 'true',
          timeout: String(timeoutMs),
        },
        timeoutMs: timeoutMs + 10_000,
      });
    },
  };
}
