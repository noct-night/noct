/**
 * The gate in front of the review queue and everything it can do.
 *
 * api/_lib/auth.ts guards the scheduled endpoints with a bearer token, which is right for a cron job and
 * useless for a browser. This is the human equivalent: one password, exchanged once for a signed cookie.
 *
 * It is deliberately not a query flag. A `?studio=1` hides nothing -- the code still ships to every visitor
 * and so does anything it can reach. Here the page itself is not served without a valid session, so an
 * unauthenticated visitor never receives the markup, never learns the endpoints, and cannot post to the
 * account. /api/publish writes to a real Instagram account under NOCT's name; that is the thing being
 * protected, and it is worth more than the inconvenience of typing a password.
 *
 * The cookie is a timestamp plus an HMAC of it. The key is the password itself, so changing the password
 * invalidates every session that was issued under the old one, which is the behaviour you want from a
 * password you are changing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Env } from '../../src/lib/env.js';

export const STUDIO_COOKIE = 'noct_studio';
/** A week. Long enough not to be an obstacle on a Thursday night, short enough to expire. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(value: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(value).digest());
}

/** Constant-time compare of two strings of the same intended length. */
function sameString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Passwords are user-chosen and so of differing lengths, which a naive compare leaks. Hash both to a fixed
 * 32 bytes first, then compare those in constant time.
 */
export function verifyPassword(given: string, expected: string): boolean {
  const h = (v: string): Buffer => createHmac('sha256', 'noct-studio-password').update(v).digest();
  return timingSafeEqual(h(given), h(expected));
}

export function studioPassword(env: Env = process.env): string | undefined {
  const v = env.STUDIO_PASSWORD;
  return v === undefined || v === '' ? undefined : v;
}

/**
 * Whether the studio is reachable at all.
 *
 * With no password set, production is closed: a deploy that forgot to configure one must not publish a
 * wide-open publish button. Locally (vercel dev, tsx) it stays open so the page can be worked on.
 */
export function studioConfigured(env: Env = process.env): boolean {
  return studioPassword(env) !== undefined || env.NODE_ENV !== 'production';
}

export function issueSession(env: Env = process.env, now = Date.now()): string {
  const secret = studioPassword(env) ?? 'dev';
  const issued = String(now);
  return `${b64url(Buffer.from(issued))}.${sign(issued, secret)}`;
}

export function verifySession(token: string | undefined, env: Env = process.env, now = Date.now()): boolean {
  if (!token) return false;
  const [head, mac] = token.split('.');
  if (!head || !mac) return false;
  const issued = Buffer.from(head, 'base64url').toString('utf8');
  const secret = studioPassword(env) ?? 'dev';
  if (!sameString(mac, sign(issued, secret))) return false;
  const at = Number(issued);
  return Number.isFinite(at) && now - at < SESSION_TTL_MS && at <= now;
}

export function readCookie(req: Pick<VercelRequest, 'headers'>, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(res: VercelResponse, token: string, env: Env = process.env): void {
  // Secure is omitted locally because vercel dev serves plain http and the cookie would be dropped.
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'set-cookie',
    `${STUDIO_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
}

export function clearSessionCookie(res: VercelResponse): void {
  res.setHeader('set-cookie', `${STUDIO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function hasStudioSession(req: Pick<VercelRequest, 'headers'>, env: Env = process.env): boolean {
  if (!studioConfigured(env)) return false;
  // With no password configured, only a non-production environment gets here, and it is open by design.
  if (studioPassword(env) === undefined) return true;
  return verifySession(readCookie(req, STUDIO_COOKIE), env);
}

/**
 * true when the request may proceed; otherwise the 401 has already been written.
 * Every studio route starts with this, including the one that serves the page.
 */
export function requireStudio(req: VercelRequest, res: VercelResponse, env: Env = process.env): boolean {
  if (hasStudioSession(req, env)) return true;
  res.setHeader('cache-control', 'no-store');
  res.status(401).json({
    error: studioConfigured(env) ? 'sign in to the studio' : 'studio is not configured on this deployment',
  });
  return false;
}
