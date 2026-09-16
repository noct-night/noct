/**
 * Publishing a reel, with the Graph API stubbed.
 *
 * The thing worth testing here is not the happy path -- it is the third outcome a carousel does not have.
 * A reel container is transcoded asynchronously, so a publish can run out of function time while the work
 * is going perfectly well, and the difference between recording that as 'pending' and recording it as
 * 'failed' is the difference between a post that goes out on the second press and a post that has to be
 * re-encoded and re-uploaded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitContainer, POLL_BUDGET_MS, POLL_STEPS_MS, publishReel, PublishError, ReelNotReady, resumeReel,
} from '../../src/post/publish.js';
import type { Logger } from '../../src/lib/log.js';

const quiet: Logger = {
  info: () => {}, warn: () => {}, error: () => {},
  child: () => quiet,
};

const creds = { userId: '17841400000000000', token: 'IGQ-test' };

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
function stubGraph(opts: { statuses?: string[]; statusDetail?: string; containerId?: string; mediaId?: string }) {
  const calls: Call[] = [];
  const statuses = [...(opts.statuses ?? ['FINISHED'])];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.includes('status_code')) {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return json({ status_code: status, status: opts.statusDetail ?? status });
    }
    if (url.includes('media_publish')) return json({ id: opts.mediaId ?? 'media-1' });
    if (url.includes('permalink')) return json({ permalink: 'https://instagram.com/p/abc' });
    if (url.endsWith('/media')) return json({ id: opts.containerId ?? 'container-1' });
    return json({});
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(err).toBeInstanceOf(ReelNotReady);
    expect((err as ReelNotReady).containerId).toBe('container-9');
    expect((err as ReelNotReady).lastStatus).toBe('IN_PROGRESS');
    expect((err as ReelNotReady).message).toMatch(/press Publish again/);
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
    expect(err).toBeInstanceOf(ReelNotReady);
    expect((err as ReelNotReady).containerId).toBe('container-3');
  });

  it('reports a carousel-shaped result with no children', async () => {
    stubGraph({ statuses: ['FINISHED'] });
    const result = await resumeReel('container-3', creds, quiet);
    expect(result.childIds).toEqual([]);
  });
});
