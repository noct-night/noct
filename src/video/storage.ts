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
 *
 * **This module runs on the deployment, not on the laptop.** It holds the service-role key, and the only
 * thing that reaches it is /api/reels behind a studio session. `npm run clip` used to call it directly,
 * which meant a key with read and write access to every table in the project had to sit in a file on
 * whichever machine was cutting video. It does not any more: the CLI asks /api/reels to mint a signed
 * upload URL and sends the bytes straight to storage with it. See src/video/studio.ts.
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
 * How long a signed upload URL is good for.
 *
 * Long enough to push a large file over a bad connection, short enough that a URL left in a shell's
 * history is not a standing write. The signature covers one object path, so the worst it can do is
 * overwrite that one object.
 */
export const UPLOAD_TTL_SECONDS = 2 * 60 * 60;

export interface SignedUpload {
  /** The absolute URL the client PUTs the bytes to. Carries its own token; needs no Authorization header. */
  putUrl: string;
  /** Where the object will land, so the caller can build its public URL afterwards. */
  path: string;
}

/**
 * Mint a URL that can write exactly one object, and nothing else.
 *
 * This is what replaces handing the service-role key to whoever is cutting video. The key stays on the
 * deployment; the laptop gets a URL that expires and is scoped to one path in one bucket.
 *
 * It also sidesteps a hard limit: a Vercel function may not receive a body over 4.5 MB, and a reel is tens
 * of megabytes. The bytes must not pass through the function at all, so they go to storage directly.
 */
export async function signUpload(objectAt: string, source: Env = process.env): Promise<SignedUpload> {
  const { url, key } = credentials(source);
  const res = await fetch(`${url}/storage/v1/object/upload/sign/${BUCKET}/${objectAt}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: UPLOAD_TTL_SECONDS }),
  });
  if (!res.ok) {
    throw new StorageError(
      `could not sign an upload for ${objectAt}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      res.status,
    );
  }
  // The response gives a path with the token on it ("/object/upload/sign/reels/...?token=..."), which has
  // to be joined to the storage origin. Older responses name it `signedUrl`; both are accepted rather than
  // pinning one and breaking on the other.
  const body = (await res.json()) as { url?: string; signedUrl?: string };
  const signed = body.url ?? body.signedUrl;
  if (!signed) throw new StorageError(`storage signed an upload but returned no URL for ${objectAt}`);
  return { putUrl: `${url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`, path: objectAt };
}

/**
 * Send one local file to a signed upload URL.
 *
 * Runs on the laptop, and is the only part of the upload the laptop does. Streamed, because a reel is
 * larger than belongs in memory; `duplex: 'half'` is undici's requirement for a streaming request body.
 */
export async function putSigned(localPath: string, putUrl: string): Promise<void> {
  const { size } = await stat(localPath);
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'content-type': contentType(localPath),
      'content-length': String(size),
      // Re-cutting the same reel should replace the file rather than fail on the second attempt.
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
