/**
 * Publishing through the Graph API, stubbed.
 *
 * The thing worth testing here is not the happy path -- it is the third outcome a carousel does not have.
 * A reel container is transcoded asynchronously, so a publish can run out of function time while the work
 * is going perfectly well, and the difference between recording that as 'pending' and recording it as
 * 'failed' is the difference between a post that goes out on the second press and a post that has to be
 * re-encoded and re-uploaded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitContainer, CAROUSEL_BUDGET_MS, MediaNotReady, POLL_BUDGET_MS, POLL_STEPS_MS, publishCarousel,
  publishReel, PublishError, PUBLISH_RETRY_MS, resumeCarousel, resumeReel, warmMedia,
} from '../../src/post/publish.js';
import { publicOrigin } from '../../api/publish.js';
import { forgetHostPacing } from '../../src/lib/http.js';
import type { Logger } from '../../src/lib/log.js';

const quiet: Logger = {
  info: () => {}, warn: () => {}, error: () => {},
  child: () => quiet,
};

const creds = { userId: '17841400000000000', token: 'IGQ-test' };

/**
 * Room for the client's own pacing. politeFetch spaces requests to a host, so a deck of two slides is a
 * dozen paced calls: well under a lambda's budget, and well over vitest's five-second default.
 */
const SLOW = 30_000;

/**
 * Drive a promise to its end under fake timers, in slices.
 *
 * The waits being tested are seconds long, and politeFetch paces its own calls on top of them, so advancing
 * by one total is not enough: the next timer is only scheduled once the previous one has run.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  for (let i = 0; i < 240; i += 1) await vi.advanceTimersByTimeAsync(250);
  return p;
}

interface Call {
  url: string;
  method: string;
  body: string;
}

/**
 * A fetch stub that records what was asked and answers from a script.
 *
 * `statuses` is consumed one per poll, so a test can say "IN_PROGRESS, then FINISHED" and assert the poll
 * actually waited rather than returning on the first answer.
 */
function stubGraph(opts: {
  statuses?: string[]; statusDetail?: string; containerId?: string; containerIds?: string[]; mediaId?: string;
  /** How many times media_publish answers "Media ID is not available" before it works. */
  notReady?: number;
}) {
  const calls: Call[] = [];
  const statuses = [...(opts.statuses ?? ['FINISHED'])];
  const containers = [...(opts.containerIds ?? [])];
  let notReady = opts.notReady ?? 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.includes('status_code')) {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return json({ status_code: status, status: opts.statusDetail ?? status });
    }
    if (url.includes('media_publish')) {
      if (notReady > 0) {
        notReady -= 1;
        return json({ error: { message: 'Media ID is not available', code: 9007, error_subcode: 2207027 } });
      }
      return json({ id: opts.mediaId ?? 'media-1' });
    }
    if (url.includes('permalink')) return json({ permalink: 'https://instagram.com/p/abc' });
    if (url.endsWith('/media')) return json({ id: containers.shift() ?? opts.containerId ?? 'container-1' });
    return json({});
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // A test that moved the clock left politeFetch's per-host pacing pointing at a future instant, which the
  // next test would otherwise wait out for real.
  forgetHostPacing();
});

describe('awaitContainer', () => {
  it('returns as soon as the container is FINISHED', async () => {
    const calls = stubGraph({ statuses: ['FINISHED'] });
    await expect(awaitContainer('container-1', creds, quiet)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('treats PUBLISHED as ready, so a post cannot get stuck unmarkable', async () => {
    // PUBLISHED means an earlier attempt got further than its database row did. Refusing here would leave
    // a reel on the account that the store can never record.
    stubGraph({ statuses: ['PUBLISHED'] });
    await expect(awaitContainer('container-1', creds, quiet)).resolves.toBeUndefined();
  });

  it('surfaces Meta\'s own sentence when the video is rejected', async () => {
    // On an ERROR the `status` field is the only thing that says which spec was violated, and that is the
    // whole of what makes the failure fixable.
    stubGraph({ statuses: ['ERROR'], statusDetail: 'The video format is not supported' });
    await expect(awaitContainer('container-1', creds, quiet))
      .rejects.toThrow(/The video format is not supported/);
  });

  it('refuses an expired container rather than polling a dead id', async () => {
    stubGraph({ statuses: ['EXPIRED'] });
    await expect(awaitContainer('container-1', creds, quiet)).rejects.toThrow(/expired/);
  });

  it('gives up resumably, naming the container, when the budget runs out', async () => {
    const calls = stubGraph({ statuses: ['IN_PROGRESS'] });
    // A budget under the first poll interval: one check, then stop. The container id is the payload that
    // matters -- without it the next attempt has nothing to resume.
    const err = await awaitContainer('container-9', creds, quiet, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaNotReady);
    expect((err as MediaNotReady).containerId).toBe('container-9');
    expect((err as MediaNotReady).lastStatus).toBe('IN_PROGRESS');
    expect((err as MediaNotReady).message).toMatch(/press Publish again/);
    // It stopped before sleeping rather than waiting out the budget first.
    expect(calls).toHaveLength(1);
  });

  it('checks the budget before sleeping, not after', async () => {
    stubGraph({ statuses: ['IN_PROGRESS'] });
    const started = Date.now();
    await awaitContainer('container-1', creds, quiet, 1).catch(() => {});
    // Waiting out the first 2 s interval only to then report a timeout wastes the wait.
    expect(Date.now() - started).toBeLessThan(POLL_STEPS_MS[0]!);
  });

  it('polls again while IN_PROGRESS and finishes when it turns', async () => {
    const calls = stubGraph({ statuses: ['IN_PROGRESS', 'FINISHED'] });
    await awaitContainer('container-1', creds, quiet);
    expect(calls).toHaveLength(2);
  }, 20_000);
});

describe('the poll pacing', () => {
  it('starts tight and widens, so a short clip is not made to wait', () => {
    expect(POLL_STEPS_MS[0]).toBeLessThanOrEqual(2_000);
    const steps = [...POLL_STEPS_MS];
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('leaves the function room either side of the poll', () => {
    // api/publish.ts is capped at 120 s (vercel.json). Creating the container, publishing it and reading
    // the permalink all happen outside this budget, and being killed between media_publish and the row
    // update is the one outcome with no clean recovery.
    expect(POLL_BUDGET_MS).toBeLessThan(120_000 * 0.75);
  });
});

describe('publishReel', () => {
  it('sends media_type=REELS with the video url and the caption', async () => {
    const calls = stubGraph({});
    await publishReel(
      { videoUrl: 'https://cdn.example.com/reel.mp4', coverUrl: null, caption: 'Friday at Basement.' },
      creds, quiet,
    );
    const create = calls.find((c) => c.url.endsWith('/media') && c.method === 'POST')!;
    expect(create.body).toContain('media_type=REELS');
    expect(create.body).toContain(encodeURIComponent('https://cdn.example.com/reel.mp4'));
    expect(create.body).toContain('caption=Friday+at+Basement.');
    // A reel only in the Reels tab is invisible to anyone looking at the grid.
    expect(create.body).toContain('share_to_feed=true');
    // The token goes in the body, never the query string, so it stays out of access logs.
    expect(create.body).toContain('access_token=IGQ-test');
    expect(create.url).not.toContain('access_token');
  });

  it('omits cover_url entirely rather than sending an empty one', async () => {
    const calls = stubGraph({});
    await publishReel({ videoUrl: 'https://cdn.example.com/r.mp4', coverUrl: null, caption: '' }, creds, quiet);
    expect(calls.find((c) => c.method === 'POST')!.body).not.toContain('cover_url');
  });

  it('passes the cover through when there is one', async () => {
    const calls = stubGraph({});
    await publishReel(
      { videoUrl: 'https://cdn.example.com/r.mp4', coverUrl: 'https://cdn.example.com/c.jpg', caption: '' },
      creds, quiet,
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toContain('cover_url');
  });

  it('records the container before it starts waiting', async () => {
    // The wait is the step that can end without a result, so the id has to be persisted before it. Without
    // this ordering a timed-out publish loses the only thing that would let it be resumed.
    const seen: string[] = [];
    stubGraph({ statuses: ['IN_PROGRESS'], containerId: 'container-7' });
    await publishReel(
      { videoUrl: 'https://cdn.example.com/r.mp4', coverUrl: null, caption: '' },
      creds, quiet,
      { onContainer: async (id) => { seen.push(id); } },
      1,
    ).catch(() => {});
    expect(seen).toEqual(['container-7']);
  });

  it('refuses a url Meta could not fetch, before spending a Graph API call', async () => {
    const calls = stubGraph({});
    for (const bad of ['http://cdn.example.com/r.mp4', '/local/r.mp4', 'pending:upload']) {
      await expect(
        publishReel({ videoUrl: bad, coverUrl: null, caption: '' }, creds, quiet),
        bad,
      ).rejects.toThrow(/public https video_url/);
    }
    expect(calls).toHaveLength(0);
  });

  it('reports the step a failure happened at', async () => {
    stubGraph({ statuses: ['ERROR'], statusDetail: 'Media upload has failed' });
    const err = await publishReel(
      { videoUrl: 'https://cdn.example.com/r.mp4', coverUrl: null, caption: '' }, creds, quiet,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).step).toBe('process');
  });
});

describe('resumeReel', () => {
  it('publishes the existing container without submitting the video again', async () => {
    const calls = stubGraph({ statuses: ['FINISHED'], mediaId: 'media-42' });
    const result = await resumeReel('container-3', creds, quiet);
    expect(result.mediaId).toBe('media-42');
    expect(result.containerId).toBe('container-3');
    // The point of resuming: no new container, so no second transcode and no second copy of the video.
    expect(calls.filter((c) => c.url.endsWith('/media') && c.method === 'POST')).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('media_publish') && c.body.includes('creation_id=container-3'))).toBe(true);
  });

  it('can time out again, and stays resumable when it does', async () => {
    stubGraph({ statuses: ['IN_PROGRESS'] });
    const err = await resumeReel('container-3', creds, quiet, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaNotReady);
    expect((err as MediaNotReady).containerId).toBe('container-3');
  });

  it('reports a carousel-shaped result with no children', async () => {
    stubGraph({ statuses: ['FINISHED'] });
    const result = await resumeReel('container-3', creds, quiet);
    expect(result.childIds).toEqual([]);
  });
});

/**
 * A deck waits too.
 *
 * Meta fetches every rendered slide from /api/render itself, and a carousel built from containers it has
 * not finished fetching is refused at media_publish with "Media ID is not available" (9007 / 2207027) --
 * which is exactly what a publish used to fail with.
 */
describe('publishCarousel', () => {
  const urls = ['https://noct.pro/api/render?p=1', 'https://noct.pro/api/render?p=2'];
  const polled = (calls: Call[]): string[] =>
    calls.filter((c) => c.url.includes('status_code')).map((c) => c.url.split('/').pop()!.split('?')[0]!);

  it('waits for every slide, then for the carousel, before publishing', async () => {
    const calls = stubGraph({ containerIds: ['kid-1', 'kid-2', 'deck-1'], mediaId: 'media-7' });
    const result = await publishCarousel(urls, 'caption', creds, quiet);

    expect(result).toMatchObject({ mediaId: 'media-7', containerId: 'deck-1', childIds: ['kid-1', 'kid-2'] });
    expect(polled(calls)).toEqual(['kid-1', 'kid-2', 'deck-1']);
    // Every slide is waited for before the carousel naming them exists, not after.
    const carouselAt = calls.findIndex((c) => c.body.includes('media_type=CAROUSEL'));
    expect(calls.findIndex((c) => c.url.includes('kid-2') && c.url.includes('status_code'))).toBeLessThan(carouselAt);
    expect(calls.findIndex((c) => c.url.includes('media_publish'))).toBeGreaterThan(carouselAt);
  }, SLOW);

  it('waits and tries again when Instagram says the media is not available yet', async () => {
    vi.useFakeTimers();
    try {
      const calls = stubGraph({ containerIds: ['kid-1', 'deck-1'], notReady: 2, mediaId: 'media-8' });
      const running = settle(publishCarousel([urls[0]!], 'caption', creds, quiet));
      expect(await running).toMatchObject({ mediaId: 'media-8' });
      expect(calls.filter((c) => c.url.includes('media_publish'))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  }, SLOW);

  it('gives up on a publish Instagram keeps refusing, rather than retrying for ever', async () => {
    vi.useFakeTimers();
    try {
      stubGraph({ containerIds: ['kid-1', 'deck-1'], notReady: 99 });
      const err = await settle(publishCarousel([urls[0]!], 'caption', creds, quiet).catch((e: unknown) => e));
      expect(err).toBeInstanceOf(PublishError);
      expect((err as PublishError).step).toBe('publish');
      expect((err as PublishError).subcode).toBe(2207027);
    } finally {
      vi.useRealTimers();
    }
  }, SLOW);

  it('names the slide Instagram is still fetching when the wait runs out', async () => {
    // No carousel container exists yet, so there is nothing to resume: a plain failure, and pressing
    // Publish again starts over. The orphaned child containers expire on their own.
    stubGraph({ statuses: ['IN_PROGRESS'], containerIds: ['kid-1'] });
    const err = await publishCarousel(urls, 'caption', creds, quiet, {}, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err).not.toBeInstanceOf(MediaNotReady);
    expect((err as PublishError).step).toBe('slide 1');
    expect((err as PublishError).message).toMatch(/still fetching slide 1 of 2/);
  }, SLOW);

  it('parks a deck whose carousel container is not ready, so the next press resumes it', async () => {
    // The children finished; the carousel did not. That one is resumable, because the container exists.
    const statuses = ['FINISHED', 'FINISHED', 'IN_PROGRESS'];
    let n = 0;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('status_code')) return json({ status_code: statuses[Math.min(n++, statuses.length - 1)] });
      if (url.endsWith('/media')) return json({ id: init?.body?.toString().includes('CAROUSEL') ? 'deck-1' : 'kid-1' });
      return json({});
    });
    const err = await publishCarousel(urls, 'caption', creds, quiet, {}, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaNotReady);
    expect((err as MediaNotReady).containerId).toBe('deck-1');
    expect((err as MediaNotReady).message).toMatch(/fetching the images/);
  }, SLOW);

  it('leaves room for building ten containers before the waiting starts', () => {
    expect(CAROUSEL_BUDGET_MS).toBeLessThan(POLL_BUDGET_MS);
  }, SLOW);
});

describe('resumeCarousel', () => {
  it('publishes the container an earlier attempt left, rendering nothing again', async () => {
    const calls = stubGraph({ statuses: ['FINISHED'], mediaId: 'media-9' });
    const result = await resumeCarousel('deck-1', creds, quiet);
    expect(result).toMatchObject({ mediaId: 'media-9', containerId: 'deck-1' });
    expect(calls.filter((c) => c.url.endsWith('/media') && c.method === 'POST')).toHaveLength(0);
    expect(calls.some((c) => c.body.includes('creation_id=deck-1'))).toBe(true);
  }, SLOW);

  it('stays resumable if it runs out of time again', async () => {
    stubGraph({ statuses: ['IN_PROGRESS'] });
    const err = await resumeCarousel('deck-1', creds, quiet, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaNotReady);
    expect((err as MediaNotReady).containerId).toBe('deck-1');
  }, SLOW);
});

/**
 * What Meta actually says when it refuses.
 *
 * The Graph API answers a refusal with HTTP 400 and the reason as JSON, and politeFetch resolves only for
 * 2xx -- so the code has to be dug back out of the failed response. Without that, `Media ID is not
 * available` arrived in the studio as "HTTP 400 for https://graph.instagram.com/..." and never reached the
 * retry written for exactly that code.
 */
describe('a Graph API refusal', () => {
  it('keeps the code and subcode from a 400, and says what Meta said', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (url.includes('media_publish')) {
        return json({ error: { message: 'Media ID is not available', code: 9007, error_subcode: 2207027 } }, 400);
      }
      if (url.includes('status_code')) return json({ status_code: 'FINISHED', status: 'Finished' });
      return json({ id: 'container-1' });
    });
    const err = await publishCarousel(['https://noct.pro/api/render?p=1'], 'x', creds, quiet).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).code).toBe(9007);
    expect((err as PublishError).subcode).toBe(2207027);
    expect((err as PublishError).message).toContain('Media ID is not available');
    // And it says what the containers themselves reported, which is where the next answer comes from.
    expect((err as PublishError).message).toMatch(/carousel reports .*slides report/);
  }, SLOW);

  it('passes through a failure that is not a Graph error as the HTTP failure it was', async () => {
    // An edge or gateway error page: there is no code to recover, and the HTTP message is the honest one.
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('media_publish')) return new Response('<html>gateway</html>', { status: 502 });
      if (url.includes('status_code')) {
        return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'container-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const err = await publishCarousel(['https://noct.pro/api/render?p=1'], 'x', creds, quiet).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).code).toBeUndefined();
    expect((err as PublishError).message).toMatch(/HTTP 502/);
  }, SLOW);
});

/**
 * Rendering the slides before Instagram is told about them.
 *
 * /api/render renders on demand, so the first fetch of a slide is the slow one, and Meta's fetcher is less
 * patient than a browser. Fetching them here warms the edge cache and, just as usefully, turns a render
 * that fails into a failure that names the slide.
 */
describe('warmMedia', () => {
  it('fetches every slide and reads it, so the cache keeps it', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      asked.push(String(input));
      return new Response('jpeg-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    await warmMedia(['https://noct.pro/api/render?p=1', 'https://noct.pro/api/render?p=2'], quiet);
    expect(asked).toEqual(['https://noct.pro/api/render?p=1', 'https://noct.pro/api/render?p=2']);
  }, SLOW);

  it('names the slide when a render fails, rather than letting Meta discover it', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) =>
      new Response(JSON.stringify({ error: 'bad signature' }), {
        status: String(input).includes('p=2') ? 403 : 200,
        headers: { 'content-type': String(input).includes('p=2') ? 'application/json' : 'image/jpeg' },
      }));
    const err = await warmMedia(['https://noct.pro/api/render?p=1', 'https://noct.pro/api/render?p=2'], quiet)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).step).toBe('render 2');
    expect((err as PublishError).message).toMatch(/slide 2 did not render/);
  }, SLOW);

  it('refuses anything that is not a JPEG, which is all Instagram takes', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const err = await warmMedia(['https://noct.pro/api/render?p=1'], quiet).catch((e: unknown) => e);
    expect((err as PublishError).message).toMatch(/rather than a JPEG/);
  }, SLOW);
});

describe('the origin Meta is pointed at', () => {
  const req = (host: string) => ({ headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } } as never);

  it('uses the configured origin above everything else', () => {
    expect(publicOrigin(req('noct.pro'), { NOCT_PUBLIC_ORIGIN: 'https://noct.pro/', VERCEL_URL: 'dep.vercel.app' }))
      .toBe('https://noct.pro');
  });

  it('prefers the domain the studio is being used on over the deployment hostname', () => {
    // The previews have already warmed this domain's cache, and on a preview deploy VERCEL_URL is a
    // hostname nobody else has ever fetched.
    expect(publicOrigin(req('noct.pro'), { VERCEL_URL: 'noct-abc123.vercel.app' })).toBe('https://noct.pro');
  });

  it('falls back to the deployment hostname when there is no usable host header', () => {
    expect(publicOrigin({ headers: {} } as never, { VERCEL_URL: 'noct-abc123.vercel.app' }))
      .toBe('https://noct-abc123.vercel.app');
  });
});
