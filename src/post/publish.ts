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
