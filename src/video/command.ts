/**
 * `npm run clip` -- the whole reel pipeline as one command.
 *
 *   probe/encode (src/video/clip.ts) -> upload (storage.ts) -> queue a draft (src/post/store.ts)
 *
 * It parses its own arguments rather than sharing the options block in src/cli.ts, because a dozen
 * clip-only flags in a parser used by `fetch` and `ingest` makes every command's --help wrong.
 *
 * The command stops at a queued draft. It does not approve and it does not publish, which is the same
 * shape as `POST /api/posts?draft=weekend`: a machine prepares something and a person decides. There is no
 * --publish flag on purpose -- publishing goes through /api/publish behind the studio session, so that
 * there is one gated door to NOCT's account and not two.
 */
import { parseArgs } from 'node:util';
import { basename, extname, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createLogger, type Logger } from '../lib/log.js';
import { checkCaption } from '../post/caption.js';
import { clip } from './clip.js';
import { available } from './ffmpeg.js';
import { clipSpecSchema, DEFAULT_MAX_SECONDS, FRAMINGS, parseTimecode, TITLE_POSITIONS } from './spec.js';

const USAGE = `usage: npm run clip -- <video> [options]

  --start TC          where to cut from (90, 1:30, 0:01:30). default 0
  --len TC            how much to keep. default: to the end of the source
  --title TEXT        burned in over the video, in the post system's own type
  --sub TEXT          the smaller line under the title
  --position WHERE    ${TITLE_POSITIONS.join(' | ')}. default low
  --title-seconds N   how long the title stays up. default 0, meaning the whole clip
  --framing HOW       ${FRAMINGS.join(' | ')}. default cover
  --mute              drop the source audio (a silent track is still written)
  --out PATH          where to write the mp4. default: alongside the source, as <name>-reel.mp4
  --no-cover          let Instagram pick the grid thumbnail instead of pulling one
  --cover-at TC       which frame of the output becomes the cover. default 0
  --caption TEXT      the post caption, checked against the house rules
  --slot YYYY-MM-DD   the night the clip is about, if it is about one
  --max-seconds N     the soft house length limit. default ${DEFAULT_MAX_SECONDS}
  --local             encode only: no upload, no database row
  --quiet             no ffmpeg progress

Examples
  npm run clip -- night.mov --start 1:12 --len 28 --title "SACRO" --sub "Basement / Friday" --local
  npm run clip -- night.mov --len 30 --title "Four Tet" --caption "Teksupport at Knockdown Center."
`;

/** ffmpeg writes its progress to stderr; only the `frame=` lines are worth showing. */
function progressPrinter(): (chunk: string) => void {
  let last = 0;
  return (chunk) => {
    const now = Date.now();
    if (now - last < 500) return;
    const frame = /frame=\s*(\d+).*?time=(\S+)/.exec(chunk);
    if (!frame) return;
    last = now;
    process.stderr.write(`\r  encoding ${frame[2]} (frame ${frame[1]})   `);
  };
}

export async function runClip(argv: string[], log: Logger = createLogger('clip')): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      start: { type: 'string' },
      len: { type: 'string' },
      title: { type: 'string' },
      sub: { type: 'string' },
      position: { type: 'string' },
      'title-seconds': { type: 'string' },
      framing: { type: 'string' },
      mute: { type: 'boolean', default: false },
      out: { type: 'string' },
      'no-cover': { type: 'boolean', default: false },
      'cover-at': { type: 'string' },
      caption: { type: 'string' },
      slot: { type: 'string' },
      'max-seconds': { type: 'string' },
      local: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const input = positionals[0];
  if (!input || values.help) {
    console.log(USAGE);
    return input ? 0 : 1;
  }

  // Checked before any work: the alternative is probing, rendering a title and only then discovering there
  // is nothing to encode with.
  if (!(await available())) {
    log.error('ffmpeg and ffprobe are required.\n  macOS:  brew install ffmpeg\n  Debian: sudo apt install ffmpeg');
    return 1;
  }

  const spec = clipSpecSchema.parse({
    start: values.start ? parseTimecode(values.start) : 0,
    length: values.len ? parseTimecode(values.len) : undefined,
    framing: values.framing,
    title: values.title ?? '',
    sub: values.sub ?? '',
    position: values.position,
    titleSeconds: values['title-seconds'] ? Number(values['title-seconds']) : 0,
    mute: values.mute,
  });

  if (values.slot && !/^\d{4}-\d{2}-\d{2}$/.test(values.slot)) {
    log.error(`--slot wants YYYY-MM-DD, got "${values.slot}"`);
    return 1;
  }

  const source = resolve(input);
  const out = values.out
    ? resolve(values.out)
    : join(resolve(source, '..'), `${basename(source, extname(source))}-reel.mp4`);
  const cover = values['no-cover'] ? null : out.replace(/\.mp4$/, '-cover.jpg');
  await mkdir(resolve(out, '..'), { recursive: true });

  // The caption is checked before the encode, not after. checkCaption reports and never rewrites
  // (src/post/caption.ts), so this prints what it found and carries on -- the words are hers to fix.
  const caption = values.caption ?? '';
  if (caption) {
    for (const problem of checkCaption(caption)) log.warn(`caption (${problem.rule}): ${problem.message}`);
  }

  const result = await clip({
    ...spec,
    input: source,
    output: out,
    cover,
    coverAt: values['cover-at'] ? parseTimecode(values['cover-at']) : 0,
    maxSeconds: values['max-seconds'] ? Number(values['max-seconds']) : DEFAULT_MAX_SECONDS,
    log,
    onProgress: values.quiet ? undefined : progressPrinter(),
  });
  if (!values.quiet) process.stderr.write('\r'.padEnd(48) + '\r');
  for (const warning of result.warnings) log.warn(warning);

  if (values.local) {
    console.log(JSON.stringify({ output: result.path, cover: result.coverPath, meta: result.meta }, null, 2));
    log.info('--local: nothing uploaded, no draft queued');
    return 0;
  }

  // Imported here rather than at the top so `--local` needs neither a database nor a storage key. Someone
  // trying a crop on a laptop should not have to hold the service-role key to do it.
  const { ensureBucket, objectPath, upload, verifyPublic } = await import('./storage.js');
  const { upsertReel } = await import('../post/store.js');
  const { closePool } = await import('../lib/db.js');

  try {
    // The row is created first, so its uuid is the storage prefix: one post, one directory, and a deleted
    // post is one prefix to clear rather than a filename to reverse-engineer. The URLs are filled in by
    // the patch below once the upload has actually happened.
    const post = await upsertReel({
      slot: values.slot ?? null,
      caption,
      videoUrl: 'pending:upload',
      coverUrl: null,
      videoMeta: result.meta,
    });

    await ensureBucket();
    log.info(`uploading ${(result.meta.bytes / 1e6).toFixed(1)} MB`);
    const videoUrl = await upload(result.path, objectPath(post.id, 'reel.mp4'));
    const coverUrl = result.coverPath ? await upload(result.coverPath, objectPath(post.id, 'cover.jpg')) : null;

    // The request Meta is about to make, made first. A private bucket otherwise surfaces much later as an
    // opaque Graph API error about a media URL it could not read.
    await verifyPublic(videoUrl);

    const { query } = await import('../lib/db.js');
    await query(
      `update ig_post set video_url = $2, cover_url = $3 where post_id = $1`,
      [post.id, videoUrl, coverUrl],
    );

    log.info(`queued reel ${post.id}`);
    console.log(JSON.stringify({ post_id: post.id, video_url: videoUrl, cover_url: coverUrl, meta: result.meta }, null, 2));
    log.info('open /studio to review it. Nothing is published until Approve and then Publish.');
    return 0;
  } finally {
    await closePool();
  }
}
