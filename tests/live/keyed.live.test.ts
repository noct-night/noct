/**
 * Opt-in live checks for the key-gated official APIs. Each test needs NOCT_LIVE=1 plus the source's own key; without
 * them it is skipped, so `npx vitest run` stays offline-green.
 *
 *   NOCT_LIVE=1 TICKETMASTER_API_KEY=... npx vitest run tests/live/keyed.live.test.ts
 *   NOCT_LIVE=1 EDMTRAIN_CLIENT_KEY=... NOCT_EDMTRAIN_ACCEPT_TERMS=1 npx vitest run tests/live/keyed.live.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/log.js';
import { localDatePlus } from '../../src/lib/time.js';
import { edmtrain } from '../../src/sources/edmtrain.js';
import { ticketmaster } from '../../src/sources/ticketmaster.js';

const live = Boolean(process.env.NOCT_LIVE);
const ctx = (scope: string) => ({
  env: process.env,
  log: createLogger(`live:${scope}`),
  fromDate: localDatePlus(0),
  toDate: localDatePlus(14),
});

describe('live: Ticketmaster Discovery API', () => {
  it.skipIf(!live || !process.env.TICKETMASTER_API_KEY)('returns NY/NJ dance events for the next two weeks', async () => {
    const res = await ticketmaster.fetch({ ...ctx('tm'), limit: 25 });
    expect(res.listings.length).toBeGreaterThan(0);
    for (const l of res.listings) {
      expect(l.source).toBe('ticketmaster');
      expect(l.sourceId).toMatch(/\S/);
      expect(l.title).toMatch(/\S/);
      expect(l.night).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.sourceUrl).toMatch(/^https:\/\//);
      if (l.hasTime) expect(l.startsAt).toMatch(/Z$/);
      else expect(l.startsAt).toBeNull();
      expect(['scheduled', 'cancelled', 'postponed', 'rescheduled']).toContain(l.status);
      expect(l.sourceTags.tm_segment).toBe('Music');
    }
    // a capped run must not promise a window; an uncapped one must
    if (res.listings.length >= 25) expect(res.window).toBeNull();
    else expect(res.window).toEqual({ start: ctx('tm').fromDate, end: ctx('tm').toDate });
  });
});

describe('live: EDMTrain Event Search API', () => {
  const acknowledged = process.env.NOCT_EDMTRAIN_ACCEPT_TERMS === '1';
  it.skipIf(!live || !process.env.EDMTRAIN_CLIENT_KEY || !acknowledged)('returns date-only NYC events with unmodified links', async () => {
    const res = await edmtrain.fetch(ctx('edmtrain'));
    expect(res.listings.length).toBeGreaterThan(0);
    for (const l of res.listings) {
      expect(l.source).toBe('edmtrain');
      expect(l.hasTime).toBe(false);
      expect(l.startsAt).toBeNull();
      expect(l.night).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.sourceUrl).toMatch(/^https:\/\/edmtrain\.com\//);
      expect(l.title).toMatch(/\S/);
      expect(l.venueName).toMatch(/\S/);
    }
    expect(res.window).toEqual({ start: ctx('edmtrain').fromDate, end: ctx('edmtrain').toDate });
  });

  it.skipIf(!live)('reports a bad client key as an API error, not as listings', async () => {
    // "Invalid client" arrives as HTTP 200 + success:false; verified live 2026-09-13
    await expect(
      edmtrain.fetch({ ...ctx('edmtrain-badkey'), env: { ...process.env, EDMTRAIN_CLIENT_KEY: 'noct-invalid-key' } }),
    ).rejects.toThrow(/EDMTrain API error/);
  });
});
