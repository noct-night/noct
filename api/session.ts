/**
 * POST /api/session   — exchange the studio password for a session cookie
 * DELETE /api/session — drop the session
 *
 * Deliberately boring, and deliberately slow to answer. The password compare is constant time (see
 * api/_lib/studio.ts) and a wrong answer waits before returning, so the endpoint is a poor thing to guess
 * against. It is one password in front of one person's studio, not an identity system, and the thing
 * it actually guards is the ability to publish to Instagram as NOCT.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { createLogger } from '../src/lib/log.js';
import { sendJson } from './_lib/respond.js';
import {
  clearSessionCookie, issueSession, setSessionCookie, studioConfigured, studioPassword, verifyPassword,
} from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

const bodySchema = z.object({ password: z.string().min(1).max(200) });

/** Slows a guessing loop to a crawl without being noticeable to someone typing a password once. */
const WRONG_ANSWER_DELAY_MS = 600;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = createLogger('api:session');

  if (req.method === 'DELETE') {
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true }, NO_STORE);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' });
    return;
  }
  if (!studioConfigured()) {
    sendJson(res, 503, { error: 'the studio has no STUDIO_PASSWORD set on this deployment' }, NO_STORE);
    return;
  }

  const expected = studioPassword();
  if (expected === undefined) {
    // Non-production with no password: the studio is already open, so hand out a session and move on.
    setSessionCookie(res, issueSession());
    sendJson(res, 200, { ok: true, note: 'no STUDIO_PASSWORD set; open in development' }, NO_STORE);
    return;
  }

  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    sendJson(res, 400, { error: 'password is required' }, NO_STORE);
    return;
  }
  if (!verifyPassword(body.data.password, expected)) {
    await sleep(WRONG_ANSWER_DELAY_MS);
    log.warn('studio sign-in refused');
    sendJson(res, 401, { error: 'that password was not accepted' }, NO_STORE);
    return;
  }

  setSessionCookie(res, issueSession());
  log.info('studio sign-in');
  sendJson(res, 200, { ok: true }, NO_STORE);
}
