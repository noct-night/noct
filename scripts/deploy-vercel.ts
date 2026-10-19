// Documented non-Git source deployments keep the single-project token narrow:
// https://vercel.com/docs/rest-api/deployments/create-a-new-deployment
// Vercel compiles api/*.ts and applies the existing project env and vercel.json.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEAM_ID = 'team_WKTsChcTMKWTwPmlVE0Yqpu5';
export const PROJECT_ID = 'prj_UoQB48tGMI68loWgsiJcufVXFzup';
export const PRODUCTION_ALIASES = ['noct.pro', 'www.noct.pro'] as const;

type SourceFile = { file: string; data: Buffer; sha: string; size: number };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const sha1 = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex');
const runtimeDirectories = new Set(['api', 'src', 'studio', 'brand', 'icons', 'public', 'assets', 'fonts']);
const rootFiles = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'vercel.json',
  'index.html', 'app.js', 'app.css', 'favicon.ico', 'g.json', 'g2.json',
]);
const requiredFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'vercel.json', 'index.html'];

function git(directory: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, { cwd: directory, input, encoding: 'utf8' });
  if (result.error || (result.status !== 0 && !(args.includes('check-ignore') && result.status === 1))) {
    throw new Error('Could not inspect the checked-out deployment source');
  }
  return result.stdout;
}

export function sourceFiles(directory = process.cwd()): SourceFile[] {
  const root = realpathSync(directory);
  const tracked = git(directory, ['ls-files', '-z']).split('\0').filter(Boolean);
  const ignoreArgs = existsSync(resolve(directory, '.vercelignore'))
    ? ['-c', `core.excludesFile=${resolve(directory, '.vercelignore')}`] : [];
  const ignored = new Set(git(directory,
    [...ignoreArgs, 'check-ignore', '--no-index', '-z', '--stdin'], `${tracked.join('\0')}\0`)
    .split('\0').filter(Boolean));
  const files: SourceFile[] = [];
  for (const file of tracked.sort()) {
    const parts = file.split('/');
    if (!rootFiles.has(file) && !runtimeDirectories.has(parts[0] ?? '')) continue;
    if (ignored.has(file) || parts.some(part => /^\.env(?:\.|$)/i.test(part)
      || ['.git', '.vercel', 'node_modules'].includes(part))
      || /\.(?:pem|key|p12|pfx)$/i.test(basename(file))) continue;
    if (parts.some(part => part === '..' || part === '') || file.startsWith('/')) {
      throw new Error('Unexpected deployment source path');
    }
    const path = resolve(directory, file);
    if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(`${root}${sep}`)) {
      throw new Error('Deployment source must contain regular files only');
    }
    const data = readFileSync(path);
    files.push({ file, data, sha: sha1(data), size: data.length });
  }
  if (requiredFiles.some(required => !files.some(file => file.file === required))
    || !files.some(file => file.file.startsWith('api/') && file.file.endsWith('.ts'))) {
    throw new Error('Deployment source is missing the app configuration or API functions');
  }
  if (files.length > 15_000 || files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
    throw new Error('Deployment source exceeds the Hobby source upload budget');
  }
  return files;
}

export function sourceSummary(files: SourceFile[]) {
  const largest = files.reduce((a, b) => a.size >= b.size ? a : b);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0),
    largest: { file: largest.file, bytes: largest.size },
    digest: sha1(files.map(file => `${file.file}\0${file.sha}\n`).join('')) };
}

export async function deployNoct({ token, files, sourceSha, fetchImpl = fetch,
  wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms)),
  log = console.log, attempts = 120,
}: { token?: string; files: SourceFile[]; sourceSha: string; fetchImpl?: Fetch;
  wait?: (ms: number) => Promise<void>; log?: (message: string) => void; attempts?: number }) {
  if (!token) throw new Error('VERCEL_TOKEN is required');
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('A checked-out source commit is required');
  if (!files.length) throw new Error('Deployment source is empty');
  async function api(path: string, options: RequestInit = {}) {
    const response = await fetchImpl(`https://api.vercel.com${path}?teamId=${TEAM_ID}`, {
      ...options, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(60_000),
    });
    // API responses may contain environment values. Never print bodies or headers.
    if (!response.ok) throw new Error(`Vercel ${options.method ?? 'GET'} ${path}: HTTP ${response.status}`);
    return response;
  }
  const project = await (await api(`/v9/projects/${PROJECT_ID}`)).json();
  if (project.id !== PROJECT_ID || project.name !== 'noct' || project.accountId !== TEAM_ID) {
    throw new Error('Vercel project identity did not match the NOCT account');
  }
  const uploaded = new Set<string>();
  for (const file of files) {
    if (uploaded.has(file.sha)) continue;
    await api('/v2/files', { method: 'POST', headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size),
      'x-vercel-digest': file.sha,
    }, body: new Uint8Array(file.data) });
    uploaded.add(file.sha);
  }
  const created = await (await api('/v13/deployments', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'noct', project: PROJECT_ID, target: 'production',
      files: files.map(({ file, sha, size }) => ({ file, sha, size })),
      meta: { noctSourceSha: sourceSha, noctSourceDigest: sourceSummary(files).digest,
        noctSourceRepository: 'noct-night/noct', noctSourceBranch: 'main' } }),
  })).json();
  if (!/^dpl_[A-Za-z0-9]+$/.test(created.id ?? '')) throw new Error('Vercel did not return a deployment ID');
  log(`Vercel deployment ${created.id} created`);
  let previous: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const deployment = await (await api(`/v13/deployments/${created.id}`)).json();
    if (deployment.readyState !== previous) log(`Vercel state: ${deployment.readyState}`);
    previous = deployment.readyState;
    if (['ERROR', 'CANCELED', 'BLOCKED'].includes(deployment.readyState)) {
      throw new Error(`Vercel deployment ended in ${deployment.readyState}`);
    }
    if (deployment.readyState === 'READY') {
      if (deployment.projectId !== PROJECT_ID || deployment.target !== 'production'
        || deployment.meta?.noctSourceSha !== sourceSha
        || (deployment.ownerId && deployment.ownerId !== TEAM_ID)) {
        throw new Error('Vercel production deployment did not match the NOCT source and project');
      }
      if (deployment.aliasError) throw new Error('Vercel could not assign the production aliases');
      const assigned = await (await api(`/v2/deployments/${created.id}/aliases`)).json();
      const aliases = new Set((assigned.aliases ?? []).map((alias: { alias: string }) => alias.alias));
      if (PRODUCTION_ALIASES.every(alias => aliases.has(alias))) {
        log('deployed and verified https://noct.pro and https://www.noct.pro');
        return { id: created.id as string, url: 'https://noct.pro' };
      }
    }
    await wait(5_000);
  }
  throw new Error('Vercel deployment or production aliases did not become ready within 10 minutes');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = sourceFiles();
  const sourceSha = git(process.cwd(), ['rev-parse', 'HEAD']).trim();
  git(process.cwd(), ['diff', '--exit-code', 'HEAD', '--', ...files.map(file => file.file)]);
  const summary = sourceSummary(files);
  console.log(`NOCT source: ${summary.files} files, ${summary.bytes} bytes; largest ${summary.largest.bytes} bytes`);
  await deployNoct({ token: process.env.VERCEL_TOKEN, files, sourceSha });
}
