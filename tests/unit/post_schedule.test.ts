/**
 * Who the scheduler is allowed to be.
 *
 * The weekend deck drafts itself on Thursday morning (0040), which means one route has to accept a bearer
 * token instead of a person. Drafting is the only part of the pipeline that cannot say anything in public:
 * it reads the feed and writes a queued post. Everything that can -- approving, publishing, editing, and
 * even reading the queue -- still wants a session, and these are the tests that keep it that way.
 *
 * The same question is asked of /api/publish, which the scheduler reaches for one thing only: keeping the
 * 60-day credential from lapsing on the weeks nobody posts (0041). That call publishes nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { mayProceed } from '../../api/posts.js';
import { mayProceed as mayPublish } from '../../api/publish.js';

const SECRET = 'cron-secret-for-tests';

function res() {
  const sent: { status?: number; body?: unknown } = {};
  const r = {
    setHeader: () => r,
    status: (n: number) => { sent.status = n; return r; },
    json: (b: unknown) => { sent.body = b; return r; },
    end: () => r,
  };
  return { res: r as never, sent };
}

const req = (over: Record<string, unknown> = {}) =>
  ({ method: 'POST', query: {}, headers: {}, ...over }) as never;

describe('drafting on a schedule', () => {
  it('lets the cron token draft, and says so in the log rather than silently', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STUDIO_PASSWORD', 'a password');
    vi.stubEnv('NODE_ENV', 'production');
    const { res: r, sent } = res();
    expect(mayProceed(req({ query: { draft: 'weekend' }, headers: { authorization: `Bearer ${SECRET}` } }), r)).toBe(true);
    expect(sent.status).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('will not let the cron token do anything else', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STUDIO_PASSWORD', 'a password');
    vi.stubEnv('NODE_ENV', 'production');
    const bearer = { authorization: `Bearer ${SECRET}` };
    for (const call of [
      req({ method: 'GET', headers: bearer }),                                   // reading the queue
      req({ method: 'PATCH', query: { id: 'x' }, headers: bearer }),             // approving, editing
      req({ method: 'PUT', query: { cta: '1' }, headers: bearer }),              // the house copy
      req({ method: 'POST', query: { rebuild: 'x' }, headers: bearer }),         // rebuilding a deck
    ]) {
      const { res: r, sent } = res();
      expect(mayProceed(call, r)).toBe(false);
      expect(sent.status).toBe(401);
    }
    vi.unstubAllEnvs();
  });

  it('refuses a draft with the wrong token, or none', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STUDIO_PASSWORD', 'a password');
    vi.stubEnv('NODE_ENV', 'production');
    for (const headers of [{}, { authorization: 'Bearer nearly-the-secret' }]) {
      const { res: r, sent } = res();
      expect(mayProceed(req({ query: { draft: 'weekend' }, headers }), r)).toBe(false);
      expect(sent.status).toBe(401);
    }
    vi.unstubAllEnvs();
  });
});

describe('keeping the credential alive on a schedule', () => {
  const stubs = () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('STUDIO_PASSWORD', 'a password');
    vi.stubEnv('NODE_ENV', 'production');
  };

  it('lets the cron token refresh the Instagram token', () => {
    stubs();
    const { res: r, sent } = res();
    expect(mayPublish(req({ query: { refresh: 'token' }, headers: { authorization: `Bearer ${SECRET}` } }), r)).toBe(true);
    expect(sent.status).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('will not let it publish, resume a post, or read the account', () => {
    stubs();
    const bearer = { authorization: `Bearer ${SECRET}` };
    for (const call of [
      req({ headers: bearer }),                                             // publishing, with no id
      req({ query: { id: 'a-post' }, headers: bearer }),                    // publishing a named post
      req({ query: { id: 'a-post', refresh: 'token' }, headers: bearer }),  // both, in case one is read first
      req({ method: 'GET', headers: bearer }),                              // the preflight's two Graph calls
      req({ method: 'GET', query: { status: 'token' }, headers: bearer }),   // even the cheap status read
      req({ query: { refresh: '1' }, headers: bearer }),                    // a refresh that is not the token
    ]) {
      const { res: r, sent } = res();
      expect(mayPublish(call, r)).toBe(false);
      expect(sent.status).toBe(401);
    }
    vi.unstubAllEnvs();
  });

  it('refuses a refresh with the wrong token, or none', () => {
    stubs();
    for (const headers of [{}, { authorization: `Bearer ${SECRET}x` }]) {
      const { res: r, sent } = res();
      expect(mayPublish(req({ query: { refresh: 'token' }, headers }), r)).toBe(false);
      expect(sent.status).toBe(401);
    }
    vi.unstubAllEnvs();
  });
});
