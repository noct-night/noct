/**
 * Opt-in live smoke test against ra.co/graphql:  NOCT_LIVE=1 npx vitest run tests/live/ra.live.test.ts
 * One small request (pageSize 5, today..+2 nights). Skipped by default so CI never talks to RA.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/log.js';
import { localDatePlus } from '../../src/lib/time.js';
import { ra } from '../../src/sources/ra.js';

describe('ra live', () => {
  it.skipIf(!process.env.NOCT_LIVE)('fetches a handful of upcoming New York listings', async () => {
    const res = await ra.fetch({ env: process.env, log: createLogger('live:ra'), fromDate: localDatePlus(0), toDate: localDatePlus(2), limit: 5 });
    expect(res.listings.length).toBeGreaterThanOrEqual(1);
    expect(res.listings.length).toBeLessThanOrEqual(5);
    const timed = res.listings.filter((l) => l.startsAt && l.venueName);
    expect(timed.length).toBeGreaterThanOrEqual(1);
    for (const l of res.listings) {
      expect(l.source).toBe('ra');
      expect(l.sourceUrl).toMatch(/^https:\/\/ra\.co\/events\/\d+$/);
      expect(l.night).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 60_000);
});
