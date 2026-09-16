/**
 * Reading and writing the post store. Everything that touches ig_post goes through here.
 *
 * Approvals live in Postgres and not in the browser, because an approval is a decision about what NOCT
 * says in public: it has to survive a closed tab, be visible from a second device, and still be there when
 * the publish step asks whether this deck was actually signed off.
 */
import { query, withTx } from '../lib/db.js';
import {
  CAROUSEL_MAX, type Post, type PostPatch, type PostStatus, type Series, type Slide, type Treatment,
} from './types.js';

/** One row of ig_post as Postgres hands it back. */
interface PostRow {
  post_id: string;
  series: Series;
  slot: string | null;
  status: PostStatus;
  caption: string;
  slides: Slide[];
  treatment: Treatment;
  grain: boolean;
  ig_permalink: string | null;
  posted_at: Date | string | null;
  updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v;

function toPost(row: PostRow): Post {
  return {
    id: row.post_id,
    series: row.series,
    slot: row.slot ? String(row.slot).slice(0, 10) : null,
    status: row.status,
    caption: row.caption,
    slides: Array.isArray(row.slides) ? row.slides : [],
    treatment: row.treatment,
    grain: row.grain,
    ig_permalink: row.ig_permalink,
    posted_at: iso(row.posted_at),
    updated_at: iso(row.updated_at) ?? '',
  };
}

// `slot` is cast to text so node-postgres does not turn a date into a local-midnight Date, the same
// reasoning as `night` in src/feed/query.ts.
const COLUMNS = `post_id, series, slot::text as slot, status, caption, slides, treatment, grain,
                 ig_permalink, posted_at, updated_at`;

export async function listPosts(status?: PostStatus): Promise<Post[]> {
  const { rows } = await query<PostRow>(
    `select ${COLUMNS} from ig_post
      ${status ? 'where status = $1' : ''}
      order by slot desc nulls last, created_at desc
      limit 200`,
    status ? [status] : [],
  );
  return rows.map(toPost);
}

export async function getPost(id: string): Promise<Post | null> {
  const { rows } = await query<PostRow>(`select ${COLUMNS} from ig_post where post_id = $1`, [id]);
  return rows[0] ? toPost(rows[0]) : null;
}

export class PostConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostConflict';
  }
}

/**
 * Update the mutable parts of a post.
 *
 * A published post is frozen: Instagram has the image and the caption, and letting the row drift from what
 * is on the account turns the record into what was meant rather than what happened.
 */
export async function patchPost(id: string, patch: PostPatch): Promise<Post> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, value: unknown): void => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.caption !== undefined) set('caption', patch.caption);
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.slides !== undefined) set('slides', JSON.stringify(patch.slides));
  if (patch.treatment !== undefined) set('treatment', patch.treatment);
  if (patch.grain !== undefined) set('grain', patch.grain);
  if (sets.length === 0) {
    const current = await getPost(id);
    if (!current) throw new PostConflict(`no post ${id}`);
    return current;
  }

  const { rows } = await query<PostRow>(
    `update ig_post set ${sets.join(', ')} where post_id = $1 and status <> 'posted' returning ${COLUMNS}`,
    params,
  );
  if (rows[0]) return toPost(rows[0]);

  const existing = await getPost(id);
  if (!existing) throw new PostConflict(`no post ${id}`);
  throw new PostConflict('this post is already published and cannot be changed');
}

export interface DraftInput {
  series: Series;
  slot: string | null;
  slides: Slide[];
  caption: string;
}

/**
 * Store a draft, replacing any queued draft already holding that weekend.
 *
 * Re-drafting the same Friday should not stack near-identical decks for her to tell apart. An approved,
 * passed or published deck for that slot is left alone: those are decisions, and a scheduled re-draft must
 * never quietly undo one.
 */
export async function upsertDraft(input: DraftInput): Promise<Post> {
  if (input.slides.length > CAROUSEL_MAX) {
    throw new PostConflict(`a carousel holds at most ${CAROUSEL_MAX} slides, got ${input.slides.length}`);
  }
  return withTx(async (client) => {
    if (input.slot) {
      const { rows } = await client.query<PostRow>(
        `update ig_post set slides = $3, caption = $4
           where series = $1 and slot = $2 and status = 'queued'
           returning ${COLUMNS}`,
        [input.series, input.slot, JSON.stringify(input.slides), input.caption],
      );
      if (rows[0]) return toPost(rows[0]);

      const { rows: taken } = await client.query<{ status: PostStatus }>(
        `select status from ig_post where series = $1 and slot = $2`,
        [input.series, input.slot],
      );
      if (taken[0]) throw new PostConflict(`a ${taken[0].status} post already holds ${input.slot}`);
    }
    const { rows } = await client.query<PostRow>(
      `insert into ig_post (series, slot, slides, caption) values ($1, $2, $3, $4) returning ${COLUMNS}`,
      [input.series, input.slot, JSON.stringify(input.slides), input.caption],
    );
    return toPost(rows[0]!);
  });
}

/**
 * How long a publish may be in flight before a later attempt is allowed to ignore it.
 *
 * The publish function is capped at 120 s (vercel.json), so anything still 'running' after this was not
 * running -- the lambda was killed between the Graph API call and the row update. Without a window like
 * this, one crash leaves a post permanently unpublishable, with the studio insisting a publish is in flight
 * that nothing is doing. Generous enough that it can never race a real attempt.
 */
export const PUBLISH_STALE_MS = 15 * 60 * 1000;

/**
 * Claim a post for publishing.
 *
 * The status check and the run row are one transaction on purpose: two clicks of Publish, or a click and a
 * retry, must not both reach the Graph API. The second finds a run already in flight and stops.
 */
export async function claimForPublish(id: string): Promise<{ post: Post; runId: string }> {
  return withTx(async (client) => {
    const { rows } = await client.query<PostRow>(
      `select ${COLUMNS} from ig_post where post_id = $1 for update`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new PostConflict(`no post ${id}`);
    if (row.status !== 'approved') {
      throw new PostConflict(`only an approved post can be published; this one is ${row.status}`);
    }
    // Abandon anything that has been 'running' longer than a publish could possibly take, so a killed
    // lambda costs one confusing row in the log rather than a post that can never go out.
    await client.query(
      `update ig_publish_run set status = 'failed', error = 'abandoned: no result within the publish window',
              finished_at = now()
         where post_id = $1 and status = 'running' and started_at < now() - ($2::bigint * interval '1 ms')`,
      [id, PUBLISH_STALE_MS],
    );
    const running = await client.query<{ run_id: string }>(
      `select run_id from ig_publish_run where post_id = $1 and status = 'running'`,
      [id],
    );
    if (running.rows[0]) throw new PostConflict('a publish is already in flight for this post');

    const { rows: run } = await client.query<{ run_id: string }>(
      `insert into ig_publish_run (post_id, status) values ($1, 'running') returning run_id`,
      [id],
    );
    return { post: toPost(row), runId: run[0]!.run_id };
  });
}

export async function recordContainers(runId: string, childIds: string[], containerId?: string): Promise<void> {
  await query(
    `update ig_publish_run set child_ids = $2, container_id = coalesce($3, container_id) where run_id = $1`,
    [runId, childIds, containerId ?? null],
  );
}

/** Mark the post published. The permalink is best-effort: a post is published whether or not it comes back. */
export async function finishPublish(
  runId: string, postId: string, mediaId: string, permalink: string | null,
): Promise<Post> {
  return withTx(async (client) => {
    await client.query(
      `update ig_publish_run set status = 'succeeded', media_id = $2, finished_at = now() where run_id = $1`,
      [runId, mediaId],
    );
    const { rows } = await client.query<PostRow>(
      `update ig_post set status = 'posted', ig_media_id = $2, ig_permalink = $3, posted_at = now()
         where post_id = $1 returning ${COLUMNS}`,
      [postId, mediaId, permalink],
    );
    return toPost(rows[0]!);
  });
}

export async function failPublish(runId: string, error: string): Promise<void> {
  await query(
    `update ig_publish_run set status = 'failed', error = $2, finished_at = now() where run_id = $1`,
    [runId, error.slice(0, 2000)],
  );
}
