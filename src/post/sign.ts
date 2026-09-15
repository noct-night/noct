/**
 * Signed render URLs.
 *
 * /api/render cannot sit behind the studio session, because the thing fetching it is Meta: the Graph API
 * takes an `image_url` and goes and gets it itself, with no cookie and no bearer token. So the URL has to
 * be publicly fetchable.
 *
 * Publicly fetchable is not the same as open. The slide spec travels in the URL with an HMAC over it, so
 * the endpoint renders only specs NOCT itself produced. Without that it is a free image-composition service
 * for anyone who finds it: the host allowlist in src/post/image.ts stops it being an SSRF hole, but nothing
 * would stop it being someone else's render farm.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../lib/env.js';

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

/**
 * The key URLs are signed with.
 *
 * NOCT_RENDER_SECRET when set, otherwise CRON_SECRET, which every production deploy already has (api/_lib/
 * auth.ts fails closed without it). Production with neither is an error rather than a default: a signature
 * verified against a hardcoded string is not a signature.
 */
export function renderSecret(source = process.env): string {
  const secret = env('NOCT_RENDER_SECRET', undefined, source) ?? env('CRON_SECRET', undefined, source);
  if (secret) return secret;
  if (source.NODE_ENV === 'production') {
    throw new SignatureError('set NOCT_RENDER_SECRET or CRON_SECRET to sign render URLs');
  }
  return 'noct-dev-render-secret';
}

function mac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** The payload half of a signed URL: the render request as compact base64url JSON. */
export function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodePayload<T>(payload: string): T {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    throw new SignatureError('render payload is not valid base64url JSON');
  }
}

export function sign(payload: string, source = process.env): string {
  return mac(payload, renderSecret(source));
}

export function verify(payload: string, signature: string, source = process.env): void {
  const expected = Buffer.from(mac(payload, renderSecret(source)), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new SignatureError('bad signature');
  }
}

/** `/api/render?p=...&sig=...` for a payload. Relative, so it works on any deployment host. */
export function signedRenderPath(value: unknown, source = process.env): string {
  const payload = encodePayload(value);
  return `/api/render?p=${payload}&sig=${sign(payload, source)}`;
}
