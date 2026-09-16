/**
 * Putting the encoded reel somewhere Meta can fetch it.
 *
 * This is the one structural difference between a reel and a carousel. A slide is regenerated on demand by
 * /api/render, signed with an HMAC, and never stored -- which works because a slide is 200 KB of JPEG that
 * takes milliseconds to draw. A reel is tens of megabytes that took minutes to encode, so it is uploaded
 * once and the URL is kept.
 *
 * Supabase Storage rather than S3 or R2: the project is already a Supabase project, the free tier's 1 GB
 * covers a weekly clip several times over, and it is one fewer credential to hold. The bucket has to be
 * **public**, and that is not a shortcut -- Meta arrives with no cookie and no Authorization header, the
 * same reason /api/render's GET is signed rather than session-gated. A signed URL would work too, but it
 * expires, and a URL that expires between approval and publish is a Friday-night failure.
 *
 * What *is* worth saying: anything in this bucket is readable by anyone who has the URL. The URLs are
 * unguessable (a uuid path), not secret. Do not put anything in here that is not going on the account
 * anyway, which for a reel about to be published is the whole point.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { requireEnv, env as readEnv, type Env } from '../lib/env.js';

/** Where reels land. One bucket, because one kind of object goes in it. */
export const BUCKET = 'reels';

export class StorageError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * The service-role key, not the publishable one.
 *
 * Uploading to a bucket is a write, and the publishable key in .env.example is exactly what its name says.
 * This key can read and write every table in the project, so it lives in the shell that runs `npm run
 * clip` and never in a lambda, never in the client bundle, never in the repo -- the same rule as
 * IG_ACCESS_TOKEN.
 */
function credentials(source: Env = process.env): { url: string; key: string } {
  const url = requireEnv('SUPABASE_URL', source).replace(/\/+$/, '');
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY', undefined, source);
  if (!key) {
    throw new StorageError(
      'SUPABASE_SERVICE_ROLE_KEY is not set. Uploading a reel is a write, so the publishable key will not ' +
      'do it. Copy the service_role key from the Supabase dashboard (Project settings -> API) into your ' +
      'local shell only -- it is not a Vercel variable and nothing deployed needs it.',
    );
  }
  return { url, key };
}

/** The public URL of an object, which is the string that ends up in ig_post.video_url. */
export function publicUrl(objectPath: string, source: Env = process.env): string {
  const { url } = credentials(source);
  return `${url}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

/**
 * Where one reel's files go: a directory per post, so the video and its cover stay together and a deleted
 * post is one prefix to clear. The post id is a uuid, which is what makes the path unguessable.
 */
export function objectPath(postId: string, file: string): string {
  return `${postId}/${basename(file)}`;
}

const CONTENT_TYPE: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return CONTENT_TYPE[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Create the bucket if it is not there, public. Idempotent: an existing bucket comes back 409 and that is
 * a success, not an error worth surfacing.
 */
export async function ensureBucket(source: Env = process.env): Promise<void> {
  const { url, key } = credentials(source);
  const res = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (res.ok || res.status === 409) return;
  // 400 with "already exists" is what some versions return instead of 409.
  const body = await res.text();
  if (/already exists|Duplicate/i.test(body)) return;
  throw new StorageError(`could not create the "${BUCKET}" bucket: ${res.status} ${body.slice(0, 300)}`, res.status);
}

/**
 * Upload one file and return its public URL.
 *
 * Streamed rather than read into a Buffer: a 15-minute reel is within Instagram's 1 GB limit and well
 * outside what belongs in memory. `duplex: 'half'` is required by undici for a streaming request body.
 *
 * politeFetch is deliberately not used here. It exists to keep NOCT from bursting a small venue's website,
 * its body is typed as a string, and this is one upload to our own storage -- none of that applies.
 */
export async function upload(localPath: string, objectAt: string, source: Env = process.env): Promise<string> {
  const { url, key } = credentials(source);
  const { size } = await stat(localPath);
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${objectAt}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': contentType(localPath),
      'content-length': String(size),
      // Re-running `npm run clip` for the same post should replace the file, not fail on the second try.
      'x-upsert': 'true',
    },
    body: createReadStream(localPath) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  if (!res.ok) {
    throw new StorageError(
      `upload of ${basename(localPath)} failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
      res.status,
    );
  }
  return publicUrl(objectAt, source);
}

/**
 * Confirm the uploaded URL is actually fetchable by an anonymous client.
 *
 * Worth a round trip: if the bucket is private, every check up to here passes and the failure arrives much
 * later as a Graph API error about a media URL it could not read. A HEAD with no credentials is exactly
 * the request Meta is about to make.
 */
export async function verifyPublic(publicHttpsUrl: string): Promise<void> {
  const res = await fetch(publicHttpsUrl, { method: 'HEAD' });
  if (!res.ok) {
    throw new StorageError(
      `${publicHttpsUrl} is not publicly readable (HTTP ${res.status}). Meta fetches this URL itself with ` +
      `no credentials, so the "${BUCKET}" bucket has to be public.`,
      res.status,
    );
  }
}
