/**
 * What Instagram will accept as a reel, and what NOCT chooses within that.
 *
 * Every number here is a platform limit or a deliberate choice against one, and each is enforced before a
 * single frame is encoded. Encoding a 4-minute clip and only then learning it is 90 seconds too long for
 * the endpoint wastes the one resource this pipeline actually spends, which is wall-clock time on a laptop.
 */
import { z } from 'zod';

/**
 * Full-screen vertical. Reels are composed for this and letterboxed by Instagram if they are not, so the
 * crop happens here rather than being left to the platform.
 */
export const REEL = { w: 1080, h: 1920 } as const;

/**
 * Instagram's reel envelope, from the Content Publishing reference.
 *
 * `MAX_SECONDS` is the API ceiling of 15 minutes, not the 90 seconds the app used to impose -- but a reel
 * over 90 s is a different kind of post and NOCT does not make those, which is what DEFAULT_MAX_SECONDS is
 * for: a soft limit the CLI warns about and a person can override.
 */
export const REEL_LIMITS = {
  minSeconds: 3,
  maxSeconds: 15 * 60,
  maxBytes: 1_000_000_000,
  maxFps: 60,
} as const;

/** Longer than this and it is not the weekly clip any more. A warning, never a refusal. */
export const DEFAULT_MAX_SECONDS = 90;

/**
 * The output encode. H.264 High / AAC is what the endpoint documents; the rest is chosen.
 *
 *  - CRF 20 rather than a target bitrate, because a static title over a dark club video and a fast pan
 *    need very different bitrates to look the same, and CRF is the knob that says "look the same".
 *  - `yuv420p` is not optional. H.264 in 4:2:2 or 4:4:4 is valid H.264 and is rejected here.
 *  - `+faststart` moves the moov atom to the front. Without it Meta has to fetch the whole file before it
 *    can read the header, and a slow fetch is a container stuck in IN_PROGRESS.
 *  - 30 fps because source footage is phone video at 30 or 60, and halving 60 is clean where 24 is not.
 */
export const ENCODE = {
  vcodec: 'libx264',
  profile: 'high',
  pixFmt: 'yuv420p',
  crf: 20,
  preset: 'medium',
  fps: 30,
  acodec: 'aac',
  audioBitrate: '128k',
  audioRate: 44_100,
} as const;

/** `--start`/`--len` as `HH:MM:SS.mmm`, `MM:SS`, or plain seconds. Rejects anything else outright. */
export function parseTimecode(input: string): number {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$|^\d{1,2}:\d{1,2}(\.\d+)?$|^\d{1,3}:\d{1,2}:\d{1,2}(\.\d+)?$/.test(s)) {
    throw new Error(`not a timecode: "${input}" (want 90, 1:30 or 0:01:30)`);
  }
  const parts = s.split(':').map(Number);
  // seconds, then minutes, then hours -- so the same reducer handles all three lengths.
  return parts.reverse().reduce((total, part, i) => total + part * 60 ** i, 0);
}

/** Seconds as `HH:MM:SS.mmm`, which is the only form ffmpeg reads back without ambiguity. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`not a duration: ${seconds}`);
  const whole = Math.floor(seconds);
  const ms = Math.round((seconds - whole) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}.${String(ms).padStart(3, '0')}`;
}

/**
 * How the source fills 1080x1920.
 *
 * `cover` centre-crops and is the default, for the same reason `cover` is the default for a flyer: it is
 * the design, and a full-screen reel is the format. `contain` letterboxes onto the ground and exists for
 * the case cover cannot fix -- footage shot landscape, where a centre crop keeps 42% of the frame and
 * usually not the half with anything in it.
 *
 * `blur` is the middle option the other two do not cover: the frame is scaled to fit and the gap is filled
 * with a blown-up, blurred copy of itself. It reads as deliberate where a hard letterbox reads as a
 * mistake, and it is the only one of the three that keeps the whole frame *and* fills the screen.
 */
export const FRAMINGS = ['cover', 'contain', 'blur'] as const;
export type Framing = (typeof FRAMINGS)[number];

/** Where a title sits. Low is the default: the top of a reel is where Instagram puts its own chrome. */
export const TITLE_POSITIONS = ['low', 'middle', 'high'] as const;
export type TitlePosition = (typeof TITLE_POSITIONS)[number];

export const clipSpecSchema = z.object({
  /** Seconds into the source. Stream-copied trims are frame-accurate enough at this scale. */
  start: z.number().min(0).default(0),
  /** Seconds of output. Undefined means "to the end of the source". */
  length: z.number().positive().optional(),
  framing: z.enum(FRAMINGS).default('cover'),
  /** Burned in over the video. Empty means no title layer is drawn or composited at all. */
  title: z.string().max(120).default(''),
  /** The smaller line under the title. Ignored when there is no title. */
  sub: z.string().max(120).default(''),
  position: z.enum(TITLE_POSITIONS).default('low'),
  /** Seconds the title is on screen, from the start of the clip. 0 keeps it up for the whole thing. */
  titleSeconds: z.number().min(0).default(0),
  /** Drop the source audio entirely. A silent reel still needs an audio track; see clip.ts. */
  mute: z.boolean().default(false),
});
export type ClipSpec = z.infer<typeof clipSpecSchema>;

/** What ffprobe reports about a file. Stored on the post so a rejection can be explained without it. */
export interface VideoMeta {
  seconds: number;
  width: number;
  height: number;
  fps: number;
  bytes: number;
  vcodec: string;
  acodec: string | null;
}

/**
 * Check an *output* against the envelope. Returns refusals and warnings separately: a refusal is something
 * the Graph API will reject, a warning is something only a person can judge.
 */
export function checkReel(meta: VideoMeta, maxSeconds = DEFAULT_MAX_SECONDS): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (meta.seconds < REEL_LIMITS.minSeconds) errors.push(`a reel must be at least ${REEL_LIMITS.minSeconds}s, this is ${meta.seconds.toFixed(2)}s`);
  if (meta.seconds > REEL_LIMITS.maxSeconds) errors.push(`a reel may be at most ${REEL_LIMITS.maxSeconds / 60} minutes, this is ${(meta.seconds / 60).toFixed(1)}`);
  if (meta.bytes > REEL_LIMITS.maxBytes) errors.push(`a reel may be at most 1 GB, this is ${(meta.bytes / 1e9).toFixed(2)} GB`);
  if (meta.fps > REEL_LIMITS.maxFps) errors.push(`a reel may be at most ${REEL_LIMITS.maxFps} fps, this is ${meta.fps}`);
  if (meta.vcodec !== 'h264') errors.push(`Instagram wants H.264, this is ${meta.vcodec}`);
  // Not an error: the endpoint accepts anything from 0.01:1 to 10:1. It is still worth saying out loud,
  // because a reel that is not 9:16 was almost certainly a framing mistake rather than a decision.
  if (meta.width !== REEL.w || meta.height !== REEL.h) {
    warnings.push(`this is ${meta.width}x${meta.height}, not ${REEL.w}x${REEL.h}; Instagram will letterbox it`);
  }
  if (meta.seconds > maxSeconds) warnings.push(`${meta.seconds.toFixed(1)}s is longer than the ${maxSeconds}s house limit`);
  if (!meta.acodec) warnings.push('no audio track; some Instagram surfaces treat a silent reel as broken');
  return { errors, warnings };
}
