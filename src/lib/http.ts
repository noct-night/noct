/**
 * Polite HTTP client shared by every source adapter.
 *
 *  - one User-Agent (see env.ts), JSON/HTML Accept headers
 *  - per-host minimum interval (default 1 request/second) so a scheduled job never bursts a small venue site
 *  - timeout + bounded retries with exponential backoff on 429/5xx/network errors
 *  - explicit BlockedError when a bot-management challenge page (Cloudflare / DataDome / Vercel checkpoint)
 *    is returned. We record the block and stop — NOCT does not attempt to get around it.
 */
import { userAgent } from './env.js';

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  /** Minimum spacing between requests to the same host, in ms. */
  minIntervalMs?: number;
  /** Follow redirects (default true). */
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
    public readonly headers: Headers,
  ) {
    super(`HTTP ${status} for ${url}: ${bodySnippet.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

export class BlockedError extends HttpError {
  constructor(status: number, url: string, bodySnippet: string, headers: Headers, public readonly vendor: string) {
    super(status, url, bodySnippet, headers);
    this.name = 'BlockedError';
    this.message = `Blocked by ${vendor} (HTTP ${status}) for ${url}`;
  }
}

const lastRequestAt = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Detects bot-management challenge responses so callers can fail fast instead of parsing HTML garbage. */
export function detectBlock(status: number, headers: Headers, body: string): string | null {
  if (headers.get('cf-mitigated') === 'challenge') return 'cloudflare';
  if (headers.get('x-datadome') || headers.get('x-dd-b')) return 'datadome';
  if (headers.get('x-vercel-mitigated') === 'challenge') return 'vercel';
  if (status === 403 || status === 429 || status === 503) {
    const head = body.slice(0, 4000);
    if (/<title>\s*Just a moment/i.test(head) || /Attention Required!\s*\|\s*Cloudflare/i.test(head)) return 'cloudflare';
    if (/Vercel Security Checkpoint/i.test(head)) return 'vercel';
    if (/geo\.captcha-delivery\.com|Please enable JS and disable any ad blocker/i.test(head)) return 'datadome';
  }
  return null;
}

/**
 * Forget when each host was last called.
 *
 * For tests that move the clock: pacing is remembered as a wall-clock instant, so a test running under fake
 * timers leaves timestamps in the future and the next real-time caller waits them out.
 */
export function forgetHostPacing(): void {
  lastRequestAt.clear();
}

async function throttle(host: string, minIntervalMs: number): Promise<void> {
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

/** fetch() with politeness, timeout, retries and block detection. Resolves only for 2xx/3xx. */
export async function politeFetch(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = 20_000, retries = 2, minIntervalMs = 1_000 } = opts;
  const host = new URL(url).host;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await throttle(host, minIntervalMs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const onOuterAbort = () => ctrl.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': userAgent(),
          accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...opts.headers,
        },
        body: opts.body,
        redirect: opts.redirect ?? 'follow',
        signal: ctrl.signal,
      });
      if (res.ok || (res.status >= 300 && res.status < 400)) return res;
      const text = await res.text().catch(() => '');
      const vendor = detectBlock(res.status, res.headers, text);
      if (vendor) throw new BlockedError(res.status, url, text, res.headers, vendor);
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 750 * 2 ** attempt);
        attempt++;
        continue;
      }
      throw new HttpError(res.status, url, text, res.headers);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt < retries && !opts.signal?.aborted) {
        await sleep(750 * 2 ** attempt);
        attempt++;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

export async function fetchText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await politeFetch(url, opts);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await politeFetch(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(res.status, url, `non-JSON body: ${text.slice(0, 200)}`, res.headers);
  }
}

export async function postJson<T = unknown>(url: string, payload: unknown, opts: HttpOptions = {}): Promise<T> {
  return fetchJson<T>(url, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...opts.headers },
  });
}
