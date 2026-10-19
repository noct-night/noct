import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deployNoct, PROJECT_ID, sourceFiles, sourceSummary, TEAM_ID } from '../../scripts/deploy-vercel.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function checkout() {
  const directory = mkdtempSync(join(tmpdir(), 'noct-deploy-source-'));
  directories.push(directory);
  const fixture: Record<string, string> = {
    'package.json': '{}', 'package-lock.json': '{}', 'tsconfig.json': '{}', 'vercel.json': '{}',
    'index.html': '<!doctype html><title>NOCT</title>', 'api/health.ts': 'export default () => null;',
    'src/allowed.ts': 'export const ok = true;', 'src/ignored.ts': 'ignore me',
    'src/omitted.ts': 'omit me', 'src/.env.production': 'not deployment source',
    '.gitignore': 'src/ignored.ts\n', '.vercelignore': 'src/omitted.ts\n',
    '.env.example': 'not deployment source', 'supabase/config.toml': 'not deployment source',
    'docs/notes.md': 'not deployment source', 'node_modules/local/index.js': 'not deployment source',
  };
  for (const [file, contents] of Object.entries(fixture)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', '-f', '.'], { cwd: directory });
  writeFileSync(join(directory, 'src/untracked.ts'), 'do not upload');
  return directory;
}

const sourceSha = 'a'.repeat(40);
const data = Buffer.from('<!doctype html><title>NOCT</title>');
const files = [{ file: 'index.html', data, size: data.length,
  sha: createHash('sha1').update(data).digest('hex') }];
const project = { id: PROJECT_ID, name: 'noct', accountId: TEAM_ID };
const ready = { readyState: 'READY', projectId: PROJECT_ID, target: 'production', ownerId: TEAM_ID,
  meta: { noctSourceSha: sourceSha } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('NOCT source deployment', () => {
  it('uploads tracked runtime files while honoring both ignore files and excluding credentials and database files', () => {
    const result = sourceFiles(checkout());
    const paths = result.map(file => file.file);
    expect(paths).toContain('api/health.ts');
    expect(paths).toContain('src/allowed.ts');
    for (const excluded of ['src/ignored.ts', 'src/omitted.ts', 'src/untracked.ts',
      'src/.env.production', '.env.example', 'supabase/config.toml', 'docs/notes.md', 'node_modules/local/index.js']) {
      expect(paths).not.toContain(excluded);
    }
    expect(sourceSummary(result).bytes).toBe(result.reduce((sum, file) => sum + file.data.length, 0));
  });

  it('rejects symlinks instead of reading files outside the checkout', () => {
    const directory = checkout();
    symlinkSync(join(directory, '.env.example'), join(directory, 'src/link.ts'));
    execFileSync('git', ['add', 'src/link.ts'], { cwd: directory });
    expect(() => sourceFiles(directory)).toThrow('regular files only');
  });

  it('refuses a different owner before uploading or creating a deployment', async () => {
    const methods: string[] = [];
    await expect(deployNoct({ token: 'test-only', files, sourceSha, fetchImpl: async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return json({ ...project, accountId: 'team_wrong' });
    } })).rejects.toThrow('project identity');
    expect(methods).toEqual(['GET']);
  });

  it('uses only project APIs and verifies both existing domains point to the new production deployment', async () => {
    const requests: { path: string; init?: RequestInit }[] = [];
    const logs: string[] = [];
    let aliasChecks = 0;
    const result = await deployNoct({ token: 'test-only', files, sourceSha,
      log: message => logs.push(message), wait: async () => {}, attempts: 2,
      fetchImpl: async (url, init) => {
        const parsed = new URL(url);
        expect(parsed.origin).toBe('https://api.vercel.com');
        expect(parsed.searchParams.get('teamId')).toBe(TEAM_ID);
        requests.push({ path: parsed.pathname, init });
        if (parsed.pathname === `/v9/projects/${PROJECT_ID}`) return json(project);
        if (parsed.pathname === '/v2/files') return new Response(null, { status: 200 });
        if (parsed.pathname === '/v13/deployments') {
          const payload = JSON.parse(String(init?.body));
          expect(payload).toMatchObject({ project: PROJECT_ID, target: 'production',
            meta: { noctSourceSha: sourceSha } });
          expect(payload.env).toBeUndefined();
          expect(payload.projectSettings).toBeUndefined();
          expect(payload.gitSource).toBeUndefined();
          expect(payload.files).toEqual(files.map(({ file, sha, size }) => ({ file, sha, size })));
          return json({ id: 'dpl_test' });
        }
        if (parsed.pathname === '/v13/deployments/dpl_test') return json(ready);
        if (parsed.pathname === '/v2/deployments/dpl_test/aliases') {
          aliasChecks++;
          return json({ aliases: (aliasChecks === 1 ? ['noct.pro'] : ['noct.pro', 'www.noct.pro'])
            .map(alias => ({ alias })) });
        }
        throw new Error('Unexpected API endpoint');
      } });
    expect(result).toEqual({ id: 'dpl_test', url: 'https://noct.pro' });
    expect(aliasChecks).toBe(2);
    expect(requests.some(request => request.path.includes('/user') || request.path.includes('/env'))).toBe(false);
    expect(logs.join('\n')).not.toContain('test-only');
  });

  it('does not report success for a failed remote build', async () => {
    const logs: string[] = [];
    await expect(deployNoct({ token: 'test-only', files, sourceSha, log: message => logs.push(message),
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path.startsWith('/v9/projects/')) return json(project);
        if (path === '/v2/files') return new Response(null, { status: 200 });
        if (path === '/v13/deployments') return json({ id: 'dpl_test' });
        return json({ readyState: 'ERROR' });
      } })).rejects.toThrow('ended in ERROR');
    expect(logs.some(message => message.includes('deployed and verified'))).toBe(false);
  });

  it('keeps API response bodies out of failures', async () => {
    await expect(deployNoct({ token: 'test-only', files, sourceSha,
      fetchImpl: async () => json({ privateValue: 'must not be logged' }, 403) }))
      .rejects.toThrow(`Vercel GET /v9/projects/${PROJECT_ID}: HTTP 403`);
  });
});
