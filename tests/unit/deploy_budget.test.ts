/**
 * How many serverless functions a deployment may have.
 *
 * Vercel counts one function per file under api/, and the plan this project is on allows twelve. Going over
 * does not fail loudly in the repo: it fails the *deployment*, hours later, after a merge, with the site
 * still serving the previous build -- which is exactly how a studio change nobody could see was diagnosed as
 * a caching problem for half an hour.
 *
 * So the budget is a test. Adding a thirteenth endpoint should fail here, in seconds, with somewhere to read
 * about what to do instead: fold the route into a neighbour that already exists (a query parameter on
 * /api/posts, a path segment on a dynamic route like api/ingest/[source].ts), or raise the plan.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Vercel's Hobby limit. Raise this only alongside the plan it describes. */
const FUNCTION_BUDGET = 12;

async function functionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    // _lib is shared code, not an endpoint: Vercel ignores directories that start with an underscore.
    if (entry.name.startsWith('_')) continue;
    if (entry.isDirectory()) out.push(...await functionFiles(join(dir, entry.name)));
    else if (entry.name.endsWith('.ts')) out.push(join(dir, entry.name));
  }
  return out;
}

describe('the deployment’s function budget', () => {
  it('stays within what the plan allows', async () => {
    const files = await functionFiles(join(process.cwd(), 'api'));
    expect(files.length, `api/ has ${files.length} functions:\n${files.join('\n')}`).toBeLessThanOrEqual(FUNCTION_BUDGET);
  });
});
