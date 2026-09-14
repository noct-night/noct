/**
 * Bearer-token gate for the scheduled endpoints. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
 * when that env var is set; pg_cron -> pg_net (noct_call() in 0008_cron.sql) sends the same header.
 * Files under api/_lib are not deployed as functions.
 */
import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Env } from '../../src/lib/env.js';

type HeaderBag = Pick<VercelRequest, 'headers'>;

export function bearerToken(req: HeaderBag): string | null {
  const h = req.headers.authorization;
  const value = Array.isArray(h) ? h[0] : h;
  const m = value ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return m ? m[1]!.trim() : null;
}

function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * With CRON_SECRET set the token must match. Without it, only non-production (vercel dev, tsx) is open —
 * a production deploy that forgot the secret fails closed instead of exposing a 300 s ingest to anyone.
 */
export function isAuthorized(req: HeaderBag, env: Env = process.env): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return env.NODE_ENV !== 'production';
  const token = bearerToken(req);
  return token !== null && sameSecret(token, secret);
}

/** true when the request may proceed; otherwise the 401 has already been written. */
export function requireCron(req: VercelRequest, res: VercelResponse, env: Env = process.env): boolean {
  if (isAuthorized(req, env)) return true;
  res.setHeader('www-authenticate', 'Bearer');
  res.status(401).json({ error: 'unauthorized' });
  return false;
}
