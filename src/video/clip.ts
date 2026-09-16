/**
 * One source video in, one Instagram-ready reel out.
 *
 *   probe -> trim -> frame to 1080x1920 -> overlay the title -> encode -> probe again -> check
 *
 * It is one ffmpeg invocation, not a chain of them, because every intermediate file would be a full
 * re-encode: three passes to add a title is three generations of H.264 loss for no reason. The filtergraph
 * is assembled here and the arguments are unit-tested without the binary, since a wrong filtergraph is the
 * failure this step actually has -- it does not crash, it silently outputs something squashed.
 *
 * The second probe is the point of the whole file. Nearly every Graph API rejection of a reel is a spec
 * violation, and it arrives as an opaque error after the upload. Reading the finished file and checking it
 * here turns that into a message on a laptop, before anything has been uploaded anywhere.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../lib/log.js';
import { framingFilter, probe, run } from './ffmpeg.js';
import { renderTitle } from './title.js';
import {
  checkReel, DEFAULT_MAX_SECONDS, ENCODE, formatTimecode, REEL,
  type ClipSpec, type VideoMeta,
} from './spec.js';

export interface ClipResult {
  /** The encoded MP4. */
  path: string;
  /** A JPEG pulled from the output, or null when no cover was asked for. */
  coverPath: string | null;
  meta: VideoMeta;
  source: VideoMeta;
  warnings: string[];
}

export interface ClipOptions extends ClipSpec {
  input: string;
  output: string;
  /** Where to write the cover JPEG. Null skips it and lets Instagram pick its own frame. */
  cover?: string | null;
  /** Seconds into the *output* the cover is taken from. */
  coverAt?: number;
  /** Soft house limit on length. Exceeding it is a warning, never a refusal. */
  maxSeconds?: number;
  log?: Logger;
  /** Called with ffmpeg's stderr as it runs, so a long encode is not a silent one. */
  onProgress?: (line: string) => void;
}

/** Which inputs ffmpeg is given, in order, so the filtergraph can name them by index. */
interface Inputs {
  titleIdx: number | null;
  silenceIdx: number | null;
}

/**
 * The video filtergraph.
 *
 * Exported for the tests. Two things in here are the ones that break: `fps` has to come after the framing
 * so the scale/crop is not done 60 times a second for frames that get dropped anyway, and the `enable`
 * expression's comma has to be escaped or ffmpeg reads `lte(t` and `5)` as two separate filter options.
 */
export function videoGraph(spec: Pick<ClipSpec, 'framing' | 'titleSeconds'>, inputs: Inputs): string {
  const base = `[0:v]${framingFilter(spec.framing)},fps=${ENCODE.fps}`;
  if (inputs.titleIdx === null) return `${base}[v]`;
  const enable = spec.titleSeconds > 0 ? `:enable=lte(t\\,${spec.titleSeconds})` : '';
  return `${base}[base];[base][${inputs.titleIdx}:v]overlay=0:0${enable}[v]`;
}

/**
 * The full argument list. Built as an array and passed to execFile, never through a shell: a title is
 * arbitrary text and a filename can contain anything.
 */
export function ffmpegArgs(opts: ClipOptions, inputs: Inputs, titlePath: string | null): string[] {
  const args = ['-hide_banner', '-nostdin', '-y'];

  // `-ss` before `-i` seeks by keyframe index rather than decoding to the mark, which is the difference
  // between instant and a minute on a long source. It stays frame-accurate here because the output is
  // re-encoded anyway; with `-c copy` it would not be.
  if (opts.start > 0) args.push('-ss', formatTimecode(opts.start));
  args.push('-i', opts.input);

  // A still image is one frame. Without `-loop 1` the overlay appears for 1/30th of a second, which looks
  // exactly like the title layer failing to render at all. `-shortest` below is what stops the loop.
  if (titlePath) args.push('-loop', '1', '-i', titlePath);
  if (inputs.silenceIdx !== null) {
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${ENCODE.audioRate}`);
  }

  args.push('-filter_complex', videoGraph(opts, inputs));
  args.push('-map', '[v]');
  args.push('-map', inputs.silenceIdx !== null ? `${inputs.silenceIdx}:a` : '0:a');

  if (opts.length !== undefined) args.push('-t', formatTimecode(opts.length));

  args.push(
    '-c:v', ENCODE.vcodec,
    '-profile:v', ENCODE.profile,
    '-pix_fmt', ENCODE.pixFmt,
    '-crf', String(ENCODE.crf),
    '-preset', ENCODE.preset,
    '-c:a', ENCODE.acodec,
    '-b:a', ENCODE.audioBitrate,
    '-ar', String(ENCODE.audioRate),
    '-ac', '2',
    // Moves the moov atom to the front. Without it Meta must fetch the whole file before it can read the
    // header, and a slow fetch shows up as a container stuck IN_PROGRESS with no explanation.
    '-movflags', '+faststart',
    // Ends the output when the shortest input ends -- which is the trimmed video, never the looping title
    // or the generated silence, both of which are infinite.
    '-shortest',
    opts.output,
  );
  return args;
}

/**
 * Cut one reel.
 *
 * Throws on anything the Graph API would reject and returns warnings for anything only a person can judge.
 * The distinction matters: a 2-second clip cannot be published and stopping is a kindness, while a
 * landscape clip letterboxed by Instagram is a choice someone might have made on purpose.
 */
export async function clip(opts: ClipOptions): Promise<ClipResult> {
  const log = opts.log;
  const source = await probe(opts.input);
  log?.info(`source: ${source.width}x${source.height} ${source.seconds.toFixed(1)}s ${source.vcodec}${source.acodec ? `/${source.acodec}` : ' (silent)'}`);

  if (opts.start >= source.seconds) {
    throw new Error(`--start ${formatTimecode(opts.start)} is past the end of a ${source.seconds.toFixed(1)}s source`);
  }
  const available = source.seconds - opts.start;
  if (opts.length !== undefined && opts.length > available + 0.5) {
    log?.warn(`--len ${opts.length}s is longer than the ${available.toFixed(1)}s left after --start; the clip will be short`);
  }

  // A reel with no audio track reads as broken on some Instagram surfaces, and silence is not the same
  // thing as no track. So a muted clip, or one cut from silent footage, gets a generated silent stream.
  const needsSilence = opts.mute || source.acodec === null;
  const scratch = await mkdtemp(join(tmpdir(), 'noct-clip-'));
  try {
    let titlePath: string | null = null;
    if (opts.title) {
      titlePath = join(scratch, 'title.png');
      await writeFile(titlePath, await renderTitle({ title: opts.title, sub: opts.sub, position: opts.position }));
      log?.info(`title layer: ${REEL.w}x${REEL.h}${opts.titleSeconds > 0 ? `, on screen for ${opts.titleSeconds}s` : ', for the whole clip'}`);
    }

    // Input order is fixed by the order they are pushed in ffmpegArgs: video, then the title, then silence.
    const inputs: Inputs = {
      titleIdx: titlePath ? 1 : null,
      silenceIdx: needsSilence ? (titlePath ? 2 : 1) : null,
    };

    const args = ffmpegArgs(opts, inputs, titlePath);
    log?.info(`encoding ${opts.output}`);
    await run('ffmpeg', args, { onStderr: (chunk) => opts.onProgress?.(chunk) });

    const meta = await probe(opts.output);
    const { errors, warnings } = checkReel(meta, opts.maxSeconds ?? DEFAULT_MAX_SECONDS);
    if (errors.length) {
      throw new Error(`the encoded clip is not a publishable reel:\n  - ${errors.join('\n  - ')}`);
    }

    let coverPath: string | null = null;
    if (opts.cover) {
      // Taken from the output, not the source: the cover has to be the frame that is actually in the reel,
      // cropped and titled the same way, or the grid thumbnail shows something the video never contains.
      const at = Math.min(opts.coverAt ?? 0, Math.max(meta.seconds - 0.1, 0));
      await run('ffmpeg', [
        '-hide_banner', '-nostdin', '-y',
        '-ss', formatTimecode(at),
        '-i', opts.output,
        '-frames:v', '1',
        // JPEG, because cover_url goes to the same media endpoints that reject PNG.
        '-q:v', '2',
        opts.cover,
      ]);
      coverPath = opts.cover;
    }

    log?.info(`done: ${meta.width}x${meta.height} ${meta.seconds.toFixed(1)}s ${(meta.bytes / 1e6).toFixed(1)} MB`);
    return { path: opts.output, coverPath, meta, source, warnings };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
