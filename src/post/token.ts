/**
 * Keeping the Instagram access token alive.
 *
 * This exists because of one difference between the two Instagram APIs. A Facebook Page token, once
 * derived from a long-lived user token, never expires. An Instagram Login token lasts **60 days**. NOCT
 * posts once a week and is supposed to run untouched, so a token read straight from the environment would
 * work beautifully for two months and then fail on a Friday with nobody watching.
 *
 * So the environment holds a seed, not the truth. The first publish copies `IG_ACCESS_TOKEN` into the
 * database; after that the stored token is the one used, and it is refreshed well before it lapses.
 * Instagram's refresh endpoint returns a fresh 60-day token, so a post every week keeps it alive forever
 * and a gap of two months is the only thing that can break it.
 *
 * On storing a credential in Postgres: `ig_token` is closed to every PostgREST role the way `ig_post` is,
 * and reachable only by the pool owner. It is the same trust boundary the token already sits behind in the
 * environment. The alternative -- rewriting a Vercel environment variable from inside a running function --
 * is far more moving parts for the same secret in a different place.
 */
import { createHash } from 'node:crypto';
import { query } from '../lib/db.js';
import { env } from '../lib/env.js';
import type { Logger } from '../lib/log.js';
import { politeFetch } from '../lib/http.js';
import { GRAPH_HOST } from './publish.js';

/** Refresh once a token is within this of expiring. Eight weekly runs of slack before it actually lapses. */
export const REFRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Instagram refuses to refresh a token less than 24 hours old. A freshly generated one is therefore left
 * alone even if its expiry is unknown, rather than burning the publish on a refusal.
 */
export const MIN_TOKEN_AGE_MS = 25 * 60 * 60 * 1000;

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export interface StoredToken {
  token: string;
  /** When Instagram says it lapses. Null for a seed from the environment, whose age we do not know. */
  expiresAt: Date | null;
  obtainedAt: Date | null;
}

/**
 * Whether a token should be refreshed before use. Pure, so the policy is testable without a database or
 * a network: refresh when it is old enough to be refreshable and close enough to expiry to be worth it.
 */
export function shouldRefresh(t: StoredToken, now: Date = new Date()): boolean {
  if (t.obtainedAt && now.getTime() - t.obtainedAt.getTime() < MIN_TOKEN_AGE_MS) return false;
  // An unknown expiry means a seed straight from the environment. Refreshing converts it into a token with
  // a known expiry, which is the state everything downstream wants to be in.
  if (!t.expiresAt) return true;
  return t.expiresAt.getTime() - now.getTime() < REFRESH_WINDOW_MS;
}

/** Days left, for the studio to show. Null when the expiry is not yet known. */
export function daysUntilExpiry(t: StoredToken, now: Date = new Date()): number | null {
  if (!t.expiresAt) return null;
  return Math.floor((t.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * The token as someone meant to paste it.
 *
 * A value pasted into a dashboard field routinely carries a trailing newline or space, and sometimes the
 * quotes it was copied out of. Instagram rejects any of those with a bare "Failed to decrypt" (code 190),
 * which says nothing about whitespace -- so strip it here rather than make anyone diagnose that.
 */
export function normaliseSeed(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v === '' ? undefined : v;
}

/** A short, one-way fingerprint of a seed, so the database records which one it holds without holding it twice. */
export function seedFingerprint(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * Whether the stored token should be thrown away and replaced from the environment.
 *
 * Changing IG_ACCESS_TOKEN is how a person replaces the credential, so a seed the database has not seen is
 * always taken. Without this, the first token ever stored -- however broken -- would be used forever, and
 * fixing the env var would silently change nothing. A refreshed token legitimately differs from the seed,
 * which is why this compares the seed it came from, not the token itself. A row from before fingerprints
 * existed has none, and is reseeded once.
 */
export function needsReseed(seed: string | undefined, storedFingerprint: string | null): boolean {
  if (!seed) return false;
  return storedFingerprint !== seedFingerprint(seed);
}

const SEED_SETTING = 'ig_token_seed';

async function readSeedFingerprint(): Promise<string | null> {
  const { rows } = await query<{ value: string }>(`select value from app_setting where key = $1`, [SEED_SETTING]);
  return rows[0]?.value ?? null;
}

async function writeSeedFingerprint(fingerprint: string): Promise<void> {
  await query(
    `insert into app_setting (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SEED_SETTING, fingerprint],
  );
}

interface TokenRow {
  token: string;
  expires_at: Date | string | null;
  obtained_at: Date | string | null;
}

const asDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

async function readStored(): Promise<StoredToken | null> {
  const { rows } = await query<TokenRow>(`select token, expires_at, obtained_at from ig_token where id = true`);
  const row = rows[0];
  return row ? { token: row.token, expiresAt: asDate(row.expires_at), obtainedAt: asDate(row.obtained_at) } : null;
}

async function writeStored(token: string, expiresInS: number | null): Promise<StoredToken> {
  const expiresAt = expiresInS === null ? null : new Date(Date.now() + expiresInS * 1000);
  await query(
    `insert into ig_token (id, token, expires_at, obtained_at) values (true, $1, $2, now())
       on conflict (id) do update set token = excluded.token, expires_at = excluded.expires_at,
                                      obtained_at = excluded.obtained_at`,
    [token, expiresAt],
  );
  return { token, expiresAt, obtainedAt: new Date() };
}

/**
 * Ask Instagram for a fresh 60-day token.
 *
 * The token travels in the query string here, which is the only place it does, because this endpoint takes
 * no other form. It is a GET to Instagram over TLS; the value is never logged on our side.
 */
export async function refreshToken(token: string): Promise<{ token: string; expiresInS: number }> {
  const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);

  const res = await politeFetch(url.toString(), { timeoutMs: 15_000, retries: 1 }).catch((err: unknown) => {
    throw new TokenError(`could not refresh the Instagram token: ${err instanceof Error ? err.message : String(err)}`);
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (body.error || !body.access_token) {
    throw new TokenError(body.error?.message ?? 'Instagram refused to refresh the token');
  }
  return { token: body.access_token, expiresInS: body.expires_in ?? 60 * 24 * 60 * 60 };
}

/**
 * The token to publish with, refreshed if it is getting old.
 *
 * A refresh failure is survivable and deliberately not fatal: the current token is still valid for up to
 * two more weeks, so the post goes out and the problem is logged rather than blocking a Friday deadline on
 * a credential that has not actually expired yet.
 */
export async function currentToken(log: Logger, source = process.env): Promise<StoredToken> {
  const seed = normaliseSeed(env('IG_ACCESS_TOKEN', undefined, source));
  let stored = await readStored();

  if (needsReseed(seed, await readSeedFingerprint())) {
    // A seed we have not stored before: someone replaced the credential. Age unknown, so it is stored with no
    // expiry and refreshed on a later run rather than immediately (Instagram refuses tokens under a day old).
    stored = await writeStored(seed!, null);
    await writeSeedFingerprint(seedFingerprint(seed!));
    log.info('Instagram token seeded from the environment');
  }

  if (!stored) throw new TokenError('no Instagram token: set IG_ACCESS_TOKEN');

  if (!shouldRefresh(stored)) return stored;

  try {
    const fresh = await refreshToken(stored.token);
    const next = await writeStored(fresh.token, fresh.expiresInS);
    log.info('Instagram token refreshed', { days_valid: daysUntilExpiry(next) });
    return next;
  } catch (err) {
    const days = daysUntilExpiry(stored);
    log.warn('Instagram token refresh failed; using the token we have', {
      error: err instanceof Error ? err.message : String(err),
      days_left: days,
    });
    if (days !== null && days <= 0) {
      throw new TokenError('the Instagram token has expired and could not be refreshed; generate a new one');
    }
    return stored;
  }
}

/** What the studio shows about the credential, without ever handing the token to the browser. */
export async function tokenStatus(): Promise<{ present: boolean; days_left: number | null }> {
  const stored = await readStored().catch(() => null);
  if (!stored) return { present: Boolean(env('IG_ACCESS_TOKEN')), days_left: null };
  return { present: true, days_left: daysUntilExpiry(stored) };
}
