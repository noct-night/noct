import { describe, expect, it } from 'vitest';
import { buildIcs, icsFold, icsText, type IcsRow } from '../../src/feed/ics.js';

const row = (over: Partial<IcsRow> = {}): IcsRow => ({
  event_id: '94252e88-d7a7-4f0c-a02e-32c6600793cc', title: 'Techno Brooklyn presents Cristobal Pesce',
  night: '2026-10-09', starts_at: '2026-10-10T02:00:00.000Z', ends_at: '2026-10-10T08:00:00.000Z', has_time: true,
  venue_name: 'Location TBA – Brooklyn', address: null, city: 'nyc', lineup: ['Cristobal Pesce'], description: null, ...over,
});
const NOW = new Date('2026-09-15T12:00:00Z');

describe('ics', () => {
  it('escapes the characters calendars trip on', () => {
    expect(icsText('Nowadays, Ridgewood; open-to-close\nyard')).toBe('Nowadays\\, Ridgewood\; open-to-close\\nyard');
    expect(icsText('back\\slash')).toBe('back\\\\slash');
  });

  it('folds long lines at 75 octets with a continuation space', () => {
    const folded = icsFold('DESCRIPTION:' + 'x'.repeat(200));
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n')[1]?.startsWith(' ')).toBe(true);
    // folding must be by octets, not characters: a multi-byte name must not be split mid-character
    const ko = icsFold('SUMMARY:' + '녹턴'.repeat(40));
    for (const part of ko.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(ko.replace(/\r\n /g, '')).toBe('SUMMARY:' + '녹턴'.repeat(40));
  });

  /** content checks read the unfolded text; folding is a wire concern and has its own test */
  const unfold = (s: string) => s.replace(/\r\n /g, '');

  it('writes a timed night in UTC with the stated end', () => {
    const raw = buildIcs(row(), NOW);
    const ics = unfold(raw);
    expect(raw).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('UID:94252e88-d7a7-4f0c-a02e-32c6600793cc@noct.pro');
    expect(ics).toContain('DTSTART:20261010T020000Z');
    expect(ics).toContain('DTEND:20261010T080000Z');
    expect(ics).toContain('SUMMARY:Techno Brooklyn presents Cristobal Pesce');
    expect(ics).toContain('URL:https://noct.pro/?e=94252e88-d7a7-4f0c-a02e-32c6600793cc&city=nyc&from=2026-10-09&to=2026-10-09');
    expect(raw.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('gives a night with no stated end a club-length default rather than zero minutes', () => {
    const ics = buildIcs(row({ ends_at: null }), NOW);
    expect(ics).toContain('DTSTART:20261010T020000Z');
    expect(ics).toContain('DTEND:20261010T070000Z');   // +5h
  });

  it('marks a night with no door time as all-day on its date, not at an invented hour', () => {
    const ics = buildIcs(row({ has_time: false, starts_at: null, ends_at: null }), NOW);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261009');
    expect(ics).toContain('DTEND;VALUE=DATE:20261010');
    expect(ics).not.toMatch(/DTSTART:\d{8}T/);
  });

  it('puts the line-up in the description and the venue in the location', () => {
    const ics = buildIcs(row({ address: '90 Scott Ave, Brooklyn' }), NOW).replace(/\r\n /g, '');
    expect(ics).toContain('LOCATION:Location TBA – Brooklyn\\, 90 Scott Ave\\, Brooklyn');
    expect(ics).toContain('DESCRIPTION:Line-up: Cristobal Pesce');
  });
});
