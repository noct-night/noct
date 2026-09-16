/**
 * Publishing a carousel through the Instagram API with Instagram Login.
 *
 * Three steps, and all three have to succeed in order:
 *   1. one container per slide, each with is_carousel_item and a public image_url
 *   2. one carousel container naming those children, with the caption
 *   3. media_publish on the carousel container
 *
 * The constraints that shape everything upstream of here:
 *   - Meta fetches image_url itself. A data URI or an upload is not an option, which is the whole reason
 *     /api/render exists and the whole reason the studio had to move off claude.ai.
 *   - JPEG only. PNG is rejected outright.
 *   - At most 10 items in a carousel, and 100 API-published posts per rolling 24 hours (a carousel is one).
 *   - No shopping tags, no branded content tags, no filters.
 *
 * Why graph.instagram.com and not graph.facebook.com: the NOCT app is configured for Instagram Login, which
 * authenticates as the Instagram account itself. No Facebook Page has to exist, and no personal Facebook
 * profile sits in the middle owning the credential. The carousel flow is identical either way; the host,
 * the permission names (instagram_business_*) and the token lifecycle are what differ.
 *
 * The token lifecycle is the part worth knowing about: an Instagram token lasts 60 days, where a Page token
 * did not expire at all. A weekly post would therefore break silently after two months, so the token is
 * refreshed and persisted rather than read from the environment on every call -- see src/post/token.ts.
 *
 * The token is never logged, never returned in a response, and never put in a query string. Graph API
 * errors are passed back with their message because that is what makes a failure fixable.
 */
import { requireEnv } from '../lib/env.js';
import type { Logger } from '../lib/log.js';
import { politeFetch } from '../lib/http.js';
import { CAROUSEL_MAX } from './types.js';

/** Pinned rather than floating: a version bump that changes a field should be a deliberate edit here. */
export const GRAPH_VERSION = 'v21.0';
export const GRAPH_HOST = 'https://graph.instagram.com';
const GRAPH = `${GRAPH_HOST}/${GRAPH_VERSION}`;

export class PublishError extends Error {
  constructor(message: string, public readonly step: string) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface IgCredentials {
  userId: string;
  token: string;
}

/**
 * The account being posted to. The token is deliberately not read here: it is refreshed and stored
 * (src/post/token.ts), so the environment holds only the seed, and reading env directly at publish time
 * would use a token that expired a month ago.
 */
export function igUserId(env = process.env): string {
  return requireEnv('IG_USER_ID', env);
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/**
 * POST to the Graph API with the token in the body rather than the query string.
 *
 * A token in a query string is a token in an access log, in a proxy's history and in any error report that
 * quotes the URL. In a POST body it is none of those.
 */
async function graphPost<T>(path: string, params: Record<string, string>, token: string, step: string): Promise<T> {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await politeFetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeoutMs: 30_000,
    // Graph API 4xx are verdicts, not blips; only the transport layer is worth retrying, which politeFetch
    // already does for 5xx and network errors.
    retries: 1,
    minIntervalMs: 250,
  }).catch((err: unknown) => {
    throw new PublishError(messageOf(err), step);
  });
  const text = await res.text();
  let parsed: T & GraphError;
  try {
    parsed = JSON.parse(text) as T & GraphError;
  } catch {
    throw new PublishError(`Graph API returned non-JSON: ${text.slice(0, 200)}`, step);
  }
  if (parsed.error) {
    const e = parsed.error;
    throw new PublishError(`${e.message ?? 'unknown Graph API error'} (code ${e.code ?? '?'})`, step);
  }
  return parsed;
}

/** HttpError's message already carries the status and a body snippet; anything else gets stringified. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface PublishHooks {
  /** Called once the child containers exist, so they are recorded before the riskier steps run. */
  onChildren?: (ids: string[]) => Promise<void>;
  onCarousel?: (id: string) => Promise<void>;
}

export interface PublishResult {
  mediaId: string;
  permalink: string | null;
  childIds: string[];
  containerId: string;
}

/**
 * Publish one carousel. `imageUrls` must be publicly reachable JPEGs, in slide order.
 *
 * Containers are created one at a time rather than in parallel. It is slower, and it means a failure on
 * slide four leaves three orphans instead of a race of nine: unpublished containers expire on their own
 * after 24 hours, so the cost of an orphan is nothing, but the cost of a confusing half-state is real.
 */
export async function publishCarousel(
  imageUrls: string[], caption: string, creds: IgCredentials, log: Logger, hooks: PublishHooks = {},
): Promise<PublishResult> {
  if (imageUrls.length === 0) throw new PublishError('a carousel needs at least one slide', 'validate');
  if (imageUrls.length > CAROUSEL_MAX) {
    throw new PublishError(`a carousel holds at most ${CAROUSEL_MAX} slides, got ${imageUrls.length}`, 'validate');
  }

  const childIds: string[] = [];
  for (const [index, url] of imageUrls.entries()) {
    const child = await graphPost<{ id: string }>(
      `/${creds.userId}/media`,
      { image_url: url, is_carousel_item: 'true' },
      creds.token,
      `child ${index + 1}`,
    );
    childIds.push(child.id);
    log.info('carousel item created', { index: index + 1, of: imageUrls.length });
  }
  await hooks.onChildren?.(childIds);

  const carousel = await graphPost<{ id: string }>(
    `/${creds.userId}/media`,
    { media_type: 'CAROUSEL', children: childIds.join(','), caption },
    creds.token,
    'carousel',
  );
  await hooks.onCarousel?.(carousel.id);
  log.info('carousel container created', { container: carousel.id, children: childIds.length });

  const published = await graphPost<{ id: string }>(
    `/${creds.userId}/media_publish`,
    { creation_id: carousel.id },
    creds.token,
    'publish',
  );
  log.info('carousel published', { media: published.id });

  return {
    mediaId: published.id,
    permalink: await permalinkOf(published.id, creds).catch(() => null),
    childIds,
    containerId: carousel.id,
  };
}

/**
 * Why a reel needs a state a carousel does not.
 *
 * A carousel child is ready the instant the Graph API hands back its id. A reel container is not: Meta
 * fetches the video, transcodes it, and only then will `media_publish` accept it. Until that happens the
 * container reports IN_PROGRESS, and how long it takes is Meta's business -- seconds for a short clip,
 * longer than the 120 s function cap for a 90-second one.
 *
 * So this error is not a failure. It means the container exists, is valid for 24 hours, and the poll ran
 * out of *our* time rather than out of hope. The caller records it as 'pending' with the container id and
 * the next request resumes the poll instead of uploading a second copy of the same video.
 */
export class ReelNotReady extends Error {
  constructor(public readonly containerId: string, public readonly waitedMs: number, public readonly lastStatus: string) {
    super(
      `the reel is still being processed by Instagram after ${Math.round(waitedMs / 1000)}s (${lastStatus}). ` +
      `The container is valid for 24 hours; press Publish again to pick it up where this left off.`,
    );
    this.name = 'ReelNotReady';
  }
}

/** What a container reports. PUBLISHED appears if something already published it. */
type ContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED' | 'UNKNOWN';

interface ContainerState {
  status: ContainerStatus;
  /** Meta's own explanation when the status is ERROR. Worth surfacing: it names the spec that was violated. */
  detail: string | null;
}

/**
 * Ask a container how it is doing.
 *
 * `status_code` is the machine-readable one and `status` is the sentence; both are requested because when
 * a reel is rejected, the sentence is the only thing that says *why*, and that is what makes it fixable.
 */
export async function containerStatus(containerId: string, creds: IgCredentials): Promise<ContainerState> {
  const res = await politeFetch(
    `${GRAPH}/${containerId}?fields=status_code,status`,
    { headers: { authorization: `Bearer ${creds.token}` }, timeoutMs: 15_000, retries: 1 },
  ).catch((err: unknown) => {
    throw new PublishError(messageOf(err), 'poll');
  });
  const body = (await res.json()) as { status_code?: string; status?: string; error?: { message?: string } };
  if (body.error) throw new PublishError(body.error.message ?? 'could not read the container status', 'poll');
  return {
    status: (body.status_code as ContainerStatus) ?? 'UNKNOWN',
    detail: body.status ?? null,
  };
}

/**
 * How the poll is paced, and why it is not a fixed interval.
 *
 * A short clip is usually ready within a few seconds, so the first checks are close together to avoid
 * sitting out a five-second wait on a four-second job. After that the interval grows: once a video has
 * taken half a minute, asking every second only spends quota to learn the same thing.
 */
export const POLL_STEPS_MS = [2_000, 2_000, 3_000, 3_000, 5_000, 5_000, 8_000, 8_000] as const;
const POLL_MAX_INTERVAL_MS = 10_000;

/**
 * The share of a 120 s function that polling may spend.
 *
 * The rest is not slack: creating the container, publishing it and reading the permalink all happen either
 * side of this, and a lambda killed between `media_publish` and the row update is the one outcome with no
 * clean recovery -- Instagram has the post and the database does not know. Stopping early and returning a
 * resumable 'pending' is always better than being killed.
 */
export const POLL_BUDGET_MS = 75_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a container to be publishable, or give up in a resumable way.
 *
 * Exported so the endpoint can resume a container it did not create.
 */
export async function awaitContainer(
  containerId: string, creds: IgCredentials, log: Logger, budgetMs = POLL_BUDGET_MS,
): Promise<void> {
  const started = Date.now();
  let last: ContainerStatus = 'UNKNOWN';

  for (let attempt = 0; ; attempt += 1) {
    const state = await containerStatus(containerId, creds);
    last = state.status;

    // PUBLISHED counts as ready: it means a previous attempt got further than its row did, and refusing
    // here would leave a post that can never be marked published.
    if (state.status === 'FINISHED' || state.status === 'PUBLISHED') {
      log.info('reel container ready', { container: containerId, waited_ms: Date.now() - started, status: state.status });
      return;
    }
    if (state.status === 'ERROR') {
      throw new PublishError(state.detail ?? 'Instagram rejected the video', 'process');
    }
    if (state.status === 'EXPIRED') {
      // Containers live 24 hours. Past that the video has to be submitted again.
      throw new PublishError('the reel container expired before it was published; publish again', 'process');
    }

    const elapsed = Date.now() - started;
    const wait = POLL_STEPS_MS[attempt] ?? POLL_MAX_INTERVAL_MS;
    // Checked before sleeping, not after: waiting out the budget and then reporting it wastes the wait.
    if (elapsed + wait > budgetMs) throw new ReelNotReady(containerId, elapsed, last);
    log.info('reel still processing', { container: containerId, elapsed_ms: elapsed, next_in_ms: wait });
    await sleep(wait);
  }
}

export interface ReelInput {
  /** A public HTTPS MP4. Meta fetches this itself, so it can be neither signed nor gated. */
  videoUrl: string;
  /** A public HTTPS JPEG, or null to let Instagram pick a frame. */
  coverUrl: string | null;
  caption: string;
}

export interface ReelHooks {
  /** Called as soon as the container exists, before any polling. See ReelNotReady for why that matters. */
  onContainer?: (id: string) => Promise<void>;
}

/**
 * Publish one reel.
 *
 * Three steps like a carousel, but the middle one is a wait rather than a call:
 *
 *   1. one container, media_type=REELS, with the video URL and the caption
 *   2. poll it until FINISHED -- Meta is fetching and transcoding the video
 *   3. media_publish
 *
 * `share_to_feed` is set so the reel also appears in the grid. A reel that exists only in the Reels tab is
 * invisible to anyone looking at the account, which for a weekly clip beside a weekly deck is the wrong
 * default; it is one parameter to change if that is ever not wanted.
 */
export async function publishReel(
  input: ReelInput, creds: IgCredentials, log: Logger, hooks: ReelHooks = {}, budgetMs = POLL_BUDGET_MS,
): Promise<PublishResult> {
  if (!/^https:\/\//.test(input.videoUrl)) {
    throw new PublishError('a reel needs a public https video_url', 'validate');
  }

  const container = await graphPost<{ id: string }>(
    `/${creds.userId}/media`,
    {
      media_type: 'REELS',
      video_url: input.videoUrl,
      caption: input.caption,
      share_to_feed: 'true',
      ...(input.coverUrl ? { cover_url: input.coverUrl } : {}),
    },
    creds.token,
    'container',
  );
  // Recorded before the wait, because the wait is the step that can end without a result. Without this,
  // a timed-out publish loses the only id that would let it be resumed.
  await hooks.onContainer?.(container.id);
  log.info('reel container created', { container: container.id });

  await awaitContainer(container.id, creds, log, budgetMs);

  const published = await graphPost<{ id: string }>(
    `/${creds.userId}/media_publish`,
    { creation_id: container.id },
    creds.token,
    'publish',
  );
  log.info('reel published', { media: published.id });

  return {
    mediaId: published.id,
    permalink: await permalinkOf(published.id, creds).catch(() => null),
    childIds: [],
    containerId: container.id,
  };
}

/**
 * Publish a reel whose container already exists, from a 'pending' run.
 *
 * The resume half of ReelNotReady: no container is created, so no second copy of the video is submitted
 * and the 24-hour window on the original one is what is being used.
 */
export async function resumeReel(
  containerId: string, creds: IgCredentials, log: Logger, budgetMs = POLL_BUDGET_MS,
): Promise<PublishResult> {
  log.info('resuming a reel container', { container: containerId });
  await awaitContainer(containerId, creds, log, budgetMs);

  const published = await graphPost<{ id: string }>(
    `/${creds.userId}/media_publish`,
    { creation_id: containerId },
    creds.token,
    'publish',
  );
  log.info('reel published on resume', { media: published.id });

  return {
    mediaId: published.id,
    permalink: await permalinkOf(published.id, creds).catch(() => null),
    childIds: [],
    containerId,
  };
}

/**
 * Check that the credential actually works, without posting anything.
 *
 * The cheapest honest test there is: ask the account for its own handle. A wrong token, a wrong id, a
 * token for a different account, or a missing permission all fail here rather than halfway through a
 * carousel, and the handle coming back is proof the two halves belong together.
 */
export async function verifyCredentials(creds: IgCredentials): Promise<{ username: string }> {
  const url = `${GRAPH}/${creds.userId}?fields=username`;
  const res = await politeFetch(url, {
    headers: { authorization: `Bearer ${creds.token}` },
    timeoutMs: 10_000,
    retries: 0,
  }).catch((err: unknown) => {
    throw new PublishError(messageOf(err), 'verify');
  });
  const body = (await res.json()) as { username?: string; error?: { message?: string } };
  if (body.error || !body.username) {
    throw new PublishError(body.error?.message ?? 'the account did not return a username', 'verify');
  }
  return { username: body.username };
}

/** The public URL of a published post. Best effort: the post exists whether or not this comes back. */
async function permalinkOf(mediaId: string, creds: IgCredentials): Promise<string | null> {
  const res = await politeFetch(`${GRAPH}/${mediaId}?fields=permalink`, {
    headers: { authorization: `Bearer ${creds.token}` },
    timeoutMs: 10_000,
    retries: 0,
  });
  const body = (await res.json()) as { permalink?: string };
  return body.permalink ?? null;
}

/**
 * How many API posts the account has left in the rolling 24-hour window.
 *
 * Worth asking before publishing rather than after failing: the limit is 100 and a weekly post will never
 * approach it, but a loop that retries will, and the failure mode without this check is an opaque error.
 */
export async function remainingQuota(creds: IgCredentials): Promise<number | null> {
  try {
    const res = await politeFetch(
      `${GRAPH}/${creds.userId}/content_publishing_limit?fields=quota_usage,config`,
      { headers: { authorization: `Bearer ${creds.token}` }, timeoutMs: 10_000, retries: 0 },
    );
    const body = (await res.json()) as { data?: { quota_usage?: number; config?: { quota_total?: number } }[] };
    const row = body.data?.[0];
    if (!row || row.quota_usage === undefined) return null;
    return (row.config?.quota_total ?? 100) - row.quota_usage;
  } catch {
    return null;
  }
}
