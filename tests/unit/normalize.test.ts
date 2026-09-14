import { describe, expect, it } from 'vitest';
import { cleanText, flattenLineup, normText, parseAge, parseLineupItem, parseMoneyRange } from '../../src/lib/normalize.js';

describe('normalize helpers', () => {
  it('normText strips accents and punctuation', () => {
    expect(normText('Suze Ijó & Co.')).toBe('suze ijo co');
    expect(normText('  BASEMENT  ')).toBe('basement');
  });
  it('parseLineupItem splits b2b and strips qualifiers', () => {
    expect(parseLineupItem('Jason Kendig b2b James Axon (US)')).toEqual([
      { name: 'Jason Kendig', isLive: false, disambig: null, groupIndex: 0 },
      { name: 'James Axon', isLive: false, disambig: 'US', groupIndex: 0 },
    ]);
    expect(parseLineupItem('Voices From The Lake (live)')[0]).toMatchObject({ name: 'Voices From The Lake', isLive: true });
    expect(parseLineupItem('Eamon Harkin All Day')[0]?.name).toBe('Eamon Harkin');
  });
  it('flattenLineup dedupes by normalised name', () => {
    expect(flattenLineup(['Theo Parrish', 'theo parrish', 'A b2b B'])).toEqual(['Theo Parrish', 'A', 'B']);
  });
  it('parseMoneyRange reads dollar strings', () => {
    expect(parseMoneyRange('$70')).toEqual([70, 70]);
    expect(parseMoneyRange('$5-$30')).toEqual([5, 30]);
    expect(parseMoneyRange('From $38.17')).toEqual([38.17, 38.17]);
    expect(parseMoneyRange('Free / RSVP')).toEqual([0, 0]);
    expect(parseMoneyRange(null)).toEqual([null, null]);
  });
  it('parseAge', () => {
    expect(parseAge('This is a 21+ event.')).toBe(21);
    expect(parseAge('18 & over')).toBe(18);
    expect(parseAge('All Ages')).toBe(0);
    expect(parseAge('')).toBeNull();
  });
  it('cleanText decodes entities and strips tags', () => {
    expect(cleanText('9.26 &#8211; <b>Denham</b> Audio')).toBe('9.26 – Denham Audio');
  });
});
