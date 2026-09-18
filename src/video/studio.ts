/**
 * Talking to the studio from the command line, as the studio.
 *
 * `npm run clip` needs two privileged things done: a file put into storage, and a row written to ig_post.
 * It used to do both itself, which meant DATABASE_URL and the service-role key had to live on whichever
 * machine was cutting video -- a credential that can read and write every table in the project, in a file,
 * on a laptop, so that someone could trim a clip.
 *
 * It does neither now. It signs in with the studio password, which is the one credential the person using
 * this already knows and already types into the studio, and /api/reels does the privileged parts. The
 * bytes still never pass through the function: it hands back a URL scoped to one object and the file goes
 * straight to storage.
 *
 * What the laptop can do with a studio session is exactly what a person signed into the studio can do.
 * That is the point -- it is not a smaller credential for a bigger job, it is the same credential for the
 * same job.
 */
import { createInterface } from 'node:readline';
import { env } from '../lib/env.js';
import type { Logger } from '../lib/log.js';
import type { VideoMeta } from './spec.js';
import type { Post } from '../post/types.js';

/** The deployment to talk to. The live studio by default, because that is where the account is posted from. */
export const DEFAULT_ORIGIN = 'https://noct.pro';

export class StudioError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'StudioError';
  }
}

export function studioOrigin(source = process.env): string {
  return (env('NOCT_STUDIO_URL', DEFAULT_ORIGIN, source) as string).replace(/\/+$/, '');
}

/** Read the password without echoing it, so it does not end up on screen or in a screenshot. */
async function promptPassword(origin: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new StudioError(
      `no studio password. Set NOCT_STUDIO_PASSWORD, or run this where a prompt can be answered.`,
    );
  }
  process.stderr.write(`Studio password for ${origin}: `);
  const rl = createInterface({ input: process.stdin, terminal: true });
  // readline echoes as it reads; muting the output stream is what keeps the password off the screen.
  const muted = (chunk: string | Buffer): boolean => { void chunk; return true; };
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = muted;
  try {
    const answer = await new Promise<string>((resolve) => rl.question('', resolve));
    return answer;
  } finally {
    (process.stdout as { write: unknown }).write = original;
    rl.close();
    process.stderr.write('\n');
  }
}

/**
 * A signed-in studio session.
 *
 * The cookie is held in memory for the life of the process and never written to disk. It is worth the same
 * as the password for a week (SESSION_TTL_MS in api/_lib/studio.ts), and a file is a thing to leak.
 */
export class StudioSession {
  private constructor(private readonly origin: string, private readonly cookie: string) {}

  static async signIn(log: Logger, source = process.env): Promise<StudioSession> {
    const origin = studioOrigin(source);
    const password = env('NOCT_STUDIO_PASSWORD', undefined, source) ?? await promptPassword(origin);

    const res = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.status === 401) throw new StudioError('that studio password was not accepted', 401);
    if (res.status === 503) {
      throw new StudioError(`${origin} has no STUDIO_PASSWORD set, so its studio is closed`, 503);
    }
    if (!res.ok) throw new StudioError(`signing in to ${origin} failed: ${res.status}`, res.status);

    // Only the session cookie is kept; everything else Set-Cookie carries is the browser's business.
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(';')[0]!).find((c) => c.startsWith('noct_studio='));
    if (!cookie) throw new StudioError(`${origin} accepted the password but issued no session`);
    log.info(`signed in to ${origin}`);
    return new StudioSession(origin, cookie);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new StudioError(`${path} returned something that is not JSON: ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok) {
      const detail = (parsed as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new StudioError(`${path}: ${detail}`, res.status);
    }
    return parsed as T;
  }

  /** Ask for URLs that can write this reel's two files, and nothing else. */
  signUploads(): Promise<{ prefix: string; video: string; cover: string }> {
    return this.post('/api/reels?sign=1', {});
  }

  /** Queue the uploaded reel as a draft. Queued, never approved: the decision stays with a person. */
  queueReel(input: {
    prefix: string; caption: string; slot: string | null; cover: boolean; meta: VideoMeta;
  }): Promise<{ post: Post; problems: { rule: string; message: string }[] }> {
    return this.post('/api/reels', input);
  }

  /** Where to go and look at it. */
  studioUrl(): string {
    return `${this.origin}/studio`;
  }
}
