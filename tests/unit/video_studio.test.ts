/**
 * The command line talking to the studio, with the studio stubbed.
 *
 * What is worth pinning here is the reason this code exists: the machine cutting video holds the studio
 * password and nothing else. So the tests assert what it sends, what it keeps, and -- the important one --
 * that the video bytes never go through the function that signs the upload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORIGIN, StudioError, StudioSession, studioOrigin } from '../../src/video/studio.js';
import type { Logger } from '../../src/lib/log.js';

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };
const PASSWORD = { NOCT_STUDIO_PASSWORD: 'hunter2' };

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

function stubStudio(over: {
  sessionStatus?: number;
  setCookie?: string[];
  sign?: unknown;
  queue?: unknown;
  queueStatus?: number;
} = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

    if (url.endsWith('/api/session')) {
      const status = over.sessionStatus ?? 200;
      if (status !== 200) return json({ error: 'nope' }, status);
      const res = json({ ok: true });
      for (const c of over.setCookie ?? ['noct_studio=abc.def; Path=/; HttpOnly; SameSite=Lax']) {
        res.headers.append('set-cookie', c);
      }
      return res;
    }
    if (url.includes('/api/reels?sign=1')) {
      return json(over.sign ?? {
        prefix: '11111111-2222-3333-4444-555555555555',
        video: 'https://ref.supabase.co/storage/v1/object/upload/sign/reels/p/reel.mp4?token=t',
        cover: 'https://ref.supabase.co/storage/v1/object/upload/sign/reels/p/cover.jpg?token=t',
      });
    }
    if (url.endsWith('/api/reels')) {
      return json(over.queue ?? { post: { id: 'post-1' }, problems: [] }, over.queueStatus ?? 201);
    }
    return json({});
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which studio it talks to', () => {
  it('defaults to the live one, because that is where the account is', () => {
    expect(studioOrigin({})).toBe(DEFAULT_ORIGIN);
    expect(DEFAULT_ORIGIN).toBe('https://noct.pro');
  });

  it('can be pointed elsewhere, without a trailing slash surviving', () => {
    expect(studioOrigin({ NOCT_STUDIO_URL: 'http://localhost:3000/' })).toBe('http://localhost:3000');
  });
});

describe('signing in', () => {
  it('posts the password and keeps only the session cookie', async () => {
    const calls = stubStudio({
      setCookie: ['other=1; Path=/', 'noct_studio=abc.def; Path=/; HttpOnly; Max-Age=604800'],
    });
    const session = await StudioSession.signIn(quiet, PASSWORD);
    const signIn = calls[0]!;
    expect(signIn.url).toBe('https://noct.pro/api/session');
    expect(signIn.method).toBe('POST');
    expect(JSON.parse(signIn.body)).toEqual({ password: 'hunter2' });

    await session.signUploads();
    // Only the session cookie is carried, and without the attributes that are the browser's business.
    expect(calls[1]!.headers.cookie).toBe('noct_studio=abc.def');
  });

  it('says plainly that the password was refused', async () => {
    stubStudio({ sessionStatus: 401 });
    await expect(StudioSession.signIn(quiet, PASSWORD)).rejects.toThrow(/was not accepted/);
  });

  it('distinguishes a closed studio from a wrong password', async () => {
    // 503 means the deployment has no STUDIO_PASSWORD at all, which is a different thing to fix.
    stubStudio({ sessionStatus: 503 });
    await expect(StudioSession.signIn(quiet, PASSWORD)).rejects.toThrow(/no STUDIO_PASSWORD/);
  });

  it('refuses to continue if no session came back', async () => {
    stubStudio({ setCookie: ['unrelated=1; Path=/'] });
    await expect(StudioSession.signIn(quiet, PASSWORD)).rejects.toThrow(/issued no session/);
  });

  it('does not prompt when there is no terminal to prompt at', async () => {
    stubStudio();
    const was = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(StudioSession.signIn(quiet, {})).rejects.toThrow(/NOCT_STUDIO_PASSWORD/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: was, configurable: true });
    }
  });
});

describe('queueing a reel', () => {
  it('never sends the video through the function that signed the upload', async () => {
    // The whole reason for a signed URL: a Vercel function cannot take a body over 4.5 MB, and a reel is
    // tens of megabytes. If bytes ever appear in a request to /api/reels, this design has been undone.
    const calls = stubStudio();
    const session = await StudioSession.signIn(quiet, PASSWORD);
    const signed = await session.signUploads();
    await session.queueReel({
      prefix: signed.prefix, caption: 'Friday.', slot: null, cover: true,
      meta: { seconds: 28, width: 1080, height: 1920, fps: 30, bytes: 24_000_000, vcodec: 'h264', acodec: 'aac' },
    });
    for (const call of calls) {
      expect(call.url).not.toMatch(/storage\/v1/);
      expect(call.body.length, call.url).toBeLessThan(2000);
    }
    // The upload URL it was handed points at storage, not at the deployment.
    expect(signed.video).toMatch(/storage\/v1\/object\/upload\/sign\/reels\//);
  });

  it('sends the prefix it was given rather than a path of its own', async () => {
    // /api/reels mints the prefix so the only writable paths are ones it chose.
    const calls = stubStudio();
    const session = await StudioSession.signIn(quiet, PASSWORD);
    const signed = await session.signUploads();
    await session.queueReel({ prefix: signed.prefix, caption: '', slot: '2026-09-18', cover: false, meta: {} as never });
    const queued = JSON.parse(calls[calls.length - 1]!.body) as Record<string, unknown>;
    expect(queued.prefix).toBe('11111111-2222-3333-4444-555555555555');
    expect(queued.slot).toBe('2026-09-18');
    expect(queued.cover).toBe(false);
  });

  it('passes the endpoint\'s own error text through', async () => {
    stubStudio({ queueStatus: 422, queue: { error: 'the uploaded reel is not readable' } });
    const session = await StudioSession.signIn(quiet, PASSWORD);
    await expect(session.queueReel({ prefix: 'p', caption: '', slot: null, cover: false, meta: {} as never }))
      .rejects.toThrow(/not readable/);
  });

  it('reports a StudioError with the status, not a bare throw', async () => {
    stubStudio({ queueStatus: 401, queue: { error: 'sign in to the studio' } });
    const session = await StudioSession.signIn(quiet, PASSWORD);
    const err = await session.queueReel({ prefix: 'p', caption: '', slot: null, cover: false, meta: {} as never })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect((err as StudioError).status).toBe(401);
  });

  it('points at the studio to go and look', async () => {
    stubStudio();
    const session = await StudioSession.signIn(quiet, PASSWORD);
    expect(session.studioUrl()).toBe('https://noct.pro/studio');
  });
});
