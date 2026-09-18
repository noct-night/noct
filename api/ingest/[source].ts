import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstParam, handleIngest } from '../_lib/respond.js';

/**
 * GET|POST /api/ingest/<ra|dice|elsewhere|goodroom|publicrecords|ticketmaster|edmtrain|all>?from&to&limit
 * Bearer CRON_SECRET. Called by pg_cron (noct_call in 0008_cron.sql) and by hand; returns the IngestSummary.
 *
 * `all` is a source name here rather than a file of its own: handleIngest has always treated it as "every
 * enabled adapter", and the second file cost one of the deployment's twelve functions for nothing. The
 * daily cron target (/api/ingest/all in vercel.json) is unchanged -- it lands here.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  await handleIngest(req, res, firstParam(req.query.source));
}
