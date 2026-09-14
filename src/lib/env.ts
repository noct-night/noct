/** Small helpers around process.env so adapters never read it directly. */

export type Env = Record<string, string | undefined>;

export function env(name: string, fallback?: string, source: Env = process.env): string | undefined {
  const v = source[name];
  return v === undefined || v === '' ? fallback : v;
}

export function requireEnv(name: string, source: Env = process.env): string {
  const v = env(name, undefined, source);
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function envInt(name: string, fallback: number, source: Env = process.env): number {
  const v = env(name, undefined, source);
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Outbound User-Agent. Several sources (ra.co/graphql behind Cloudflare) return 403 to
 * non-browser UAs; the default is a plain desktop Chrome string. Override with NOCT_USER_AGENT.
 * This is a header, nothing more: NOCT never solves challenges, rotates IPs or uses proxies.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function userAgent(source: Env = process.env): string {
  return env('NOCT_USER_AGENT', DEFAULT_USER_AGENT, source) as string;
}
