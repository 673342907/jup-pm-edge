/** Minimal fetch helpers: timeout, retry with backoff, and a concurrency limiter. Zero dependencies. */

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Fetcher = (url: string, opts?: HttpOptions) => Promise<unknown>;

export const fetchJson: Fetcher = async (url, opts = {}) => {
  const { timeoutMs = 15_000, retries = 3, headers = {} } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'jup-pm-edge/0.1', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      const body = await res.text();
      const err = new HttpError(res.status, url, body);
      // Only retry throttling and server errors; 4xx is a caller problem.
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
    if (attempt < retries) await sleep(400 * 2 ** attempt + Math.random() * 200);
  }
  throw lastErr;
};

/** Run async tasks with at most `limit` in flight; preserves input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
