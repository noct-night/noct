import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstParam, handleIngest } from '../_lib/respond.js';

/**
 * GET|POST /api/ingest/<ra|dice|elsewhere|goodroom|publicrecords|ticketmaster|edmtrain|all>?from&to&limit
 * Bearer CRON_SECRET. Called by pg_cron (noct_call in 0008_cron.sql) and by hand; returns the IngestSummary.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  await handleIngest(req, res, firstParam(req.query.source));
}
