/**
 * Running ffmpeg and ffprobe, and nothing else.
 *
 * The binaries are expected on PATH rather than vendored as an npm dependency. `ffmpeg-static` would add
 * ~78 MB to the bundle for a step that deliberately never runs in a lambda -- encoding is what `npm run
 * clip` does on a laptop, precisely because a 300 s function ceiling is not a safe place to put a job whose
 * duration depends on how long the video is. Nothing in api/ imports this file.
 *
 * Arguments are passed as an array to execFile, never through a shell. A clip title is arbitrary text that
 * ends up in a drawtext-adjacent position, and a filename can contain anything; `spawn` with a string
 * command is how that becomes someone else's problem.
 */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { REEL, type VideoMeta } from './spec.js';

export class FfmpegMissing extends Error {
  constructor(bin: string) {
    super(
      `${bin} was not found on PATH.\n` +
      `  macOS:  brew install ffmpeg\n` +
      `  Debian: sudo apt install ffmpeg\n` +
      `Set NOCT_FFMPEG / NOCT_FFPROBE to point at them explicitly if they live somewhere unusual.`,
    );
    this.name = 'FfmpegMissing';
  }
}

export class FfmpegFailed extends Error {
  constructor(bin: string, code: number | null, stderr: string) {
    // ffmpeg's last stderr lines are the diagnosis; the preceding fifty are the build configuration.
    super(`${bin} exited ${code ?? 'on a signal'}:\n${tail(stderr, 24)}`);
    this.name = 'FfmpegFailed';
  }
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

const BIN = {
  ffmpeg: () => process.env.NOCT_FFMPEG || 'ffmpeg',
  ffprobe: () => process.env.NOCT_FFPROBE || 'ffprobe',
} as const;

export interface RunOptions {
  /** Encoding a long clip is slow by nature; the cap is here to catch a hang, not to bound the work. */
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

/** Run one of the two binaries and resolve with stdout. Rejects with a typed error, never a bare ENOENT. */
export function run(which: keyof typeof BIN, args: string[], opts: RunOptions = {}): Promise<string> {
  const bin = BIN[which]();
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin, args,
      // ffprobe output is small; an ffmpeg progress log over a long encode is not, hence the generous cap.
      { timeout: opts.timeoutMs ?? 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new FfmpegMissing(bin));
        reject(new FfmpegFailed(bin, (err as NodeJS.ErrnoException & { code?: number }).code ?? null, stderr || String(err)));
      },
    );
    if (opts.onStderr && child.stderr) child.stderr.on('data', (d: Buffer) => opts.onStderr!(d.toString()));
  });
}

/** True when both binaries answer. Used by the CLI to fail with instructions before it does any work. */
export async function available(): Promise<boolean> {
  try {
    await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
    return true;
  } catch {
    return false;
  }
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string };
}

/**
 * `avg_frame_rate` arrives as a rational string ("30000/1001"), and occasionally as "0/0" for a stream
 * ffprobe could not measure. Both have to survive this without becoming NaN in a constraint check.
 */
export function parseFrameRate(rational: string | undefined): number {
  if (!rational) return 0;
  const [num, den] = rational.split('/').map(Number);
  if (!Number.isFinite(num!) || !Number.isFinite(den!) || !den) return Number.isFinite(num!) ? num! : 0;
  return Math.round((num! / den) * 1000) / 1000;
}

/** What a file actually is, as opposed to what its extension claims. */
export async function probe(path: string): Promise<VideoMeta> {
  const stdout = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  let parsed: ProbeOutput;
  try {
    parsed = JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new Error(`ffprobe returned something that is not JSON for ${path}`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error(`${path} has no video stream`);

  // Prefer the container's duration over the stream's: a stream-copied trim leaves the video stream's own
  // duration describing the source, which would make every clip look like it failed its length check.
  const seconds = Number(parsed.format?.duration ?? video.duration ?? 0);
  const bytes = Number(parsed.format?.size ?? 0) || (await stat(path)).size;

  return {
    seconds: Number.isFinite(seconds) ? seconds : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFrameRate(video.avg_frame_rate),
    bytes,
    vcodec: video.codec_name ?? 'unknown',
    acodec: audio?.codec_name ?? null,
  };
}

/**
 * The scale/crop/pad filter chain for one framing, as a filtergraph string.
 *
 * Exported and unit-tested because this is where a reel silently comes out squashed. The three cases:
 *
 *   cover    scale so the short edge fills, then centre-crop the long one. `increase` is what makes it
 *            "fill" rather than "fit"; without it this is `contain` with extra steps.
 *   contain  scale so the long edge fits, then pad the rest with the ground colour.
 *   blur     the frame twice: one copy blown up past the canvas and blurred for the backdrop, the real
 *            frame scaled to fit and laid over the middle of it.
 *
 * `force_original_aspect_ratio` does the arithmetic ffmpeg is better at than a template string, and
 * `-2` keeps every dimension even, which yuv420p requires and which is the other classic way this breaks.
 */
export function framingFilter(framing: 'cover' | 'contain' | 'blur', ground = '0x0B0B0B'): string {
  const { w, h } = REEL;
  switch (framing) {
    case 'cover':
      return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    case 'contain':
      return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${ground}`;
    case 'blur':
      return [
        `split=2[bg][fg]`,
        `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=28,eq=brightness=-0.12[blurred]`,
        `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[framed]`,
        `[blurred][framed]overlay=(W-w)/2:(H-h)/2`,
      ].join(';');
  }
}
