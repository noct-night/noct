/**
 * Opt-in network tests for the venue-direct adapters: NOCT_LIVE=1 npx vitest run tests/live
 * Each one fetches the next 14 nights from the real site and checks that the parser still understands the markup.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/log.js';
import { localDatePlus } from '../../src/lib/time.js';
import { elsewhere } from '../../src/sources/elsewhere.js';
import { goodroom } from '../../src/sources/goodroom.js';
import { publicrecords } from '../../src/sources/publicrecords.js';
import type { FetchContext, SourceAdapter } from '../../src/sources/types.js';

const live = Boolean(process.env.NOCT_LIVE);

function ctx(key: string): FetchContext {
  return { env: process.env, log: createLogger(`live:${key}`), fromDate: localDatePlus(0), toDate: localDatePlus(14) };
}

async function runAdapter(adapter: SourceAdapter) {
  const res = await adapter.fetch(ctx(adapter.key));
  expect(res.listings.length).toBeGreaterThanOrEqual(1);
  for (const l of res.listings) {
    expect(l.source).toBe(adapter.key);
    expect(l.sourceId).toBeTruthy();
    expect(l.title).toBeTruthy();
    expect(l.night).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(l.venueName).toBeTruthy();
  }
  return res;
}

describe('venue-direct adapters (live)', () => {
  it.skipIf(!live)('elsewhere: timed listings with Eventbrite refs', async () => {
    const res = await runAdapter(elsewhere);
    expect(res.listings.every((l) => l.hasTime && l.startsAt)).toBe(true);
    expect(res.listings.every((l) => l.externalRefs.length === 1)).toBe(true);
    expect(res.window).not.toBeNull();
  }, 120_000);

  it.skipIf(!live)('goodroom: date-only listings from the http homepage', async () => {
    const res = await runAdapter(goodroom);
    expect(res.listings.every((l) => !l.hasTime && l.venueName === 'Good Room')).toBe(true);
    expect(res.window).toBeNull();
  }, 120_000);

  it.skipIf(!live)('publicrecords: rows parse with rooms and DICE short links', async () => {
    const res = await runAdapter(publicrecords);
    expect(res.listings.every((l) => l.venueName === 'Public Records')).toBe(true);
    expect(res.listings.some((l) => l.externalRefs[0]?.source === 'dice_short')).toBe(true);
    // a weekday mismatch means the year inference or the site's own labels are off — surface it
    expect(res.warnings.filter((w) => /printed/.test(w))).toEqual([]);
  }, 120_000);
});
