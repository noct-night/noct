import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleIngest } from '../_lib/respond.js';

/**
 * GET|POST /api/ingest/all?from&to&limit — every enabled adapter in registry order, one ingest_run row each.
 * Vercel Cron's daily fallback target (vercel.json); pg_cron prefers the per-source routes so RA can run every 3 h.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  await handleIngest(req, res, 'all');
}
