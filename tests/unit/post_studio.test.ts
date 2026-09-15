import { describe, expect, it } from 'vitest';
import {
  hasStudioSession, issueSession, readCookie, SESSION_TTL_MS, STUDIO_COOKIE, studioConfigured,
  verifyPassword, verifySession,
} from '../../api/_lib/studio.js';
import { decodePayload, encodePayload, renderSecret, sign, SignatureError, signedRenderPath, verify } from '../../src/post/sign.js';

const WITH_PASSWORD = { STUDIO_PASSWORD: 'correct horse battery staple', NODE_ENV: 'production' };

describe('studio configuration', () => {
  it('is closed in production when no password is set', () => {
    // Same shape as api/_lib/auth.ts: a deploy that forgot the secret fails closed rather than open.
    expect(studioConfigured({ NODE_ENV: 'production' })).toBe(false);
    expect(hasStudioSession({ headers: {} }, { NODE_ENV: 'production' })).toBe(false);
  });

  it('is open locally so the page can be worked on', () => {
    expect(studioConfigured({ NODE_ENV: 'development' })).toBe(true);
    expect(hasStudioSession({ headers: {} }, { NODE_ENV: 'development' })).toBe(true);
  });

  it('requires a session once a password is set, even in development', () => {
    expect(hasStudioSession({ headers: {} }, { STUDIO_PASSWORD: 'x', NODE_ENV: 'development' })).toBe(false);
  });
});

describe('password check', () => {
  it('accepts the right password and refuses everything else', () => {
    expect(verifyPassword('hunter2', 'hunter2')).toBe(true);
    expect(verifyPassword('hunter3', 'hunter2')).toBe(false);
    // Lengths differ, which a naive compare would leak and a short-circuit would reject early.
    expect(verifyPassword('', 'hunter2')).toBe(false);
    expect(verifyPassword('hunter2 ', 'hunter2')).toBe(false);
  });
});

describe('sessions', () => {
  it('accepts a session it just issued', () => {
    expect(verifySession(issueSession(WITH_PASSWORD), WITH_PASSWORD)).toBe(true);
  });

  it('refuses a tampered or truncated token', () => {
    const token = issueSession(WITH_PASSWORD);
    expect(verifySession(`${token}x`, WITH_PASSWORD)).toBe(false);
    expect(verifySession(token.split('.')[0], WITH_PASSWORD)).toBe(false);
    expect(verifySession(undefined, WITH_PASSWORD)).toBe(false);
    expect(verifySession('', WITH_PASSWORD)).toBe(false);
  });

  it('refuses a token forged against a different password', () => {
    const other = issueSession({ STUDIO_PASSWORD: 'something else', NODE_ENV: 'production' });
    expect(verifySession(other, WITH_PASSWORD)).toBe(false);
  });

  it('expires, and refuses a token dated in the future', () => {
    const now = Date.now();
    const token = issueSession(WITH_PASSWORD, now);
    expect(verifySession(token, WITH_PASSWORD, now + SESSION_TTL_MS - 1000)).toBe(true);
    expect(verifySession(token, WITH_PASSWORD, now + SESSION_TTL_MS + 1000)).toBe(false);
    expect(verifySession(token, WITH_PASSWORD, now - 60_000)).toBe(false);
  });

  it('changing the password invalidates every session issued under the old one', () => {
    const token = issueSession(WITH_PASSWORD);
    expect(verifySession(token, { ...WITH_PASSWORD, STUDIO_PASSWORD: 'new password' })).toBe(false);
  });

  it('reads its cookie out of a header with others alongside it', () => {
    const headers = { cookie: `other=1; ${STUDIO_COOKIE}=abc.def; last=2` };
    expect(readCookie({ headers }, STUDIO_COOKIE)).toBe('abc.def');
    expect(readCookie({ headers: {} }, STUDIO_COOKIE)).toBeUndefined();
  });

  it('accepts a real cookie round trip', () => {
    const token = issueSession(WITH_PASSWORD);
    const headers = { cookie: `${STUDIO_COOKIE}=${encodeURIComponent(token)}` };
    expect(hasStudioSession({ headers }, WITH_PASSWORD)).toBe(true);
  });
});

describe('signed render URLs', () => {
  const env = { NOCT_RENDER_SECRET: 'render-secret', NODE_ENV: 'production' };

  it('round trips a payload', () => {
    const value = { slide: { template: 'note' }, treatment: 'mono' };
    expect(decodePayload(encodePayload(value))).toEqual(value);
  });

  it('verifies what it signed', () => {
    const payload = encodePayload({ a: 1 });
    expect(() => verify(payload, sign(payload, env), env)).not.toThrow();
  });

  it('refuses an altered payload, which is the point of signing at all', () => {
    const payload = encodePayload({ a: 1 });
    const signature = sign(payload, env);
    const tampered = encodePayload({ a: 2 });
    expect(() => verify(tampered, signature, env)).toThrow(SignatureError);
    expect(() => verify(payload, `${signature}x`, env)).toThrow(SignatureError);
    expect(() => verify(payload, '', env)).toThrow(SignatureError);
  });

  it('refuses a signature made with a different secret', () => {
    const payload = encodePayload({ a: 1 });
    const other = sign(payload, { NOCT_RENDER_SECRET: 'other', NODE_ENV: 'production' });
    expect(() => verify(payload, other, env)).toThrow(SignatureError);
  });

  it('falls back to CRON_SECRET, and refuses to invent one in production', () => {
    expect(renderSecret({ CRON_SECRET: 'cron', NODE_ENV: 'production' })).toBe('cron');
    expect(renderSecret({ NOCT_RENDER_SECRET: 'a', CRON_SECRET: 'b', NODE_ENV: 'production' })).toBe('a');
    expect(() => renderSecret({ NODE_ENV: 'production' })).toThrow(SignatureError);
    expect(renderSecret({ NODE_ENV: 'development' })).toBeTruthy();
  });

  it('builds a relative path so it works on any deployment host', () => {
    const path = signedRenderPath({ a: 1 }, env);
    expect(path.startsWith('/api/render?p=')).toBe(true);
    expect(path).toContain('&sig=');
  });

  it('rejects a payload that is not base64url JSON', () => {
    expect(() => decodePayload('not-base64-json')).toThrow(SignatureError);
  });
});
