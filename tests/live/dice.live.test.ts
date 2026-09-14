/**
 * Live smoke test against the DICE partner Events API. Opt-in twice over: NOCT_LIVE=1 AND a DICE_API_KEY that
 * DICE issued to NOCT (see docs/sources/dice.md). Never run with a key found in a dice.fm page.
 *
 *   NOCT_LIVE=1 DICE_API_KEY=... npx vitest run tests/live/dice.live.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/log.js';
import { fetchJson } from '../../src/lib/http.js';
import { localDatePlus } from '../../src/lib/time.js';
import { NYC_BBOX, buildEventsUrl, dice, parseEventsPayload } from '../../src/sources/dice.js';

const live = Boolean(process.env.NOCT_LIVE) && Boolean(process.env.DICE_API_KEY);

describe('dice live', () => {
  it.skipIf(!live)('page 1 still has the documented envelope and event shape', async () => {
    const body = await fetchJson<unknown>(buildEventsUrl(1), { headers: { 'x-api-key': process.env.DICE_API_KEY as string } });
    const events = parseEventsPayload(body);
    expect(events.length).toBeGreaterThan(0);
    const e = events[0]!;
    expect(typeof e.id).toBe('string');
    expect(typeof e.date).toBe('string');
    expect(Array.isArray(e.type_tags)).toBe(true);
    expect(Array.isArray(e.ticket_types)).toBe(true);
    expect(Array.isArray(e.flags)).toBe(true);
  });

  it.skipIf(!live)('fetches a handful of NYC club listings for the next two weeks', async () => {
    const res = await dice.fetch({
      env: process.env,
      log: createLogger('test:dice'),
      fromDate: localDatePlus(0),
      toDate: localDatePlus(14),
      limit: 5,
    });
    expect(res.listings.length).toBeGreaterThan(0);
    expect(res.listings.length).toBeLessThanOrEqual(5);
    for (const l of res.listings) {
      expect(l.source).toBe('dice');
      expect(l.sourceUrl).toMatch(/^https:\/\/dice\.fm\/event\//);
      expect(l.startsAt).toMatch(/Z$/);
      expect(l.hasTime).toBe(true);
      expect(l.venueName).toBeTruthy();
      expect(l.currency).toBe('USD');
      const tags = l.sourceTags.dice_type_tags as string[];
      const genreTags = l.sourceTags.dice_genre_tags as string[];
      expect(tags.some((t) => t === 'music:dj' || t === 'music:party') || genreTags.some((g) => /^(dj|party):/.test(g))).toBe(true);
      if (l.venueLat !== null && l.venueLng !== null) {
        const inBox = l.venueLat >= NYC_BBOX.latMin && l.venueLat <= NYC_BBOX.latMax && l.venueLng >= NYC_BBOX.lngMin && l.venueLng <= NYC_BBOX.lngMax;
        const raw = l.raw as { location?: { state?: string | null } | null };
        expect(inBox || raw.location?.state === 'New York').toBe(true);
      }
    }
  }, 120_000);
});
