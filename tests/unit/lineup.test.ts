import { describe, expect, it } from 'vitest';
import { lineupFromTitle } from '../../src/lib/lineup.js';

/** Every title here is a real upcoming 19hz row. */
describe('lineupFromTitle', () => {
  it('reads a bill after feat. / ft. / w/', () => {
    expect(lineupFromTitle('Global Swing Presents Oxygen Ft. Satoshi Tomiie * Garrett David * Esoe').lineup)
      .toEqual(['Satoshi Tomiie', 'Garrett David', 'Esoe']);
    expect(lineupFromTitle('Baile World Ft Jyoty, Cquestt, DJ Nico').lineup)
      .toEqual(['Jyoty', 'Cquestt', 'DJ Nico']);
    // no space after the slash, which an \s+ marker would miss
    expect(lineupFromTitle('Azure Huntington Beach w/Shima').lineup).toEqual(['Shima']);
  });

  it('reads a comma list after a colon or dash', () => {
    expect(lineupFromTitle('In Between: Roman Flugel & Josh Caffe, Jane Margarette').lineup)
      .toEqual(['Roman Flugel', 'Josh Caffe', 'Jane Margarette']);
    expect(lineupFromTitle('Spooky Disco Luau - Kyrxmi, Chlophonic, Car Car').lineup)
      .toEqual(['Kyrxmi', 'Chlophonic', 'Car Car']);
  });

  it('leaves b2b joined for parse_lineup_item, and drops (live)', () => {
    // the whole phrase is one slot on the bill; splitting it is the database's job, not the title's
    expect(lineupFromTitle('Flowers Of Romance Ft. Andi b2b Justin Aulis Long * Club Drippy (Live) * Nolia').lineup)
      .toEqual(['Andi b2b Justin Aulis Long', 'Club Drippy', 'Nolia']);
  });

  it('does not invent artists out of show names', () => {
    // one name after a colon is a title, not a bill -- this is why a colon needs a list to count
    for (const t of [
      'Pilsen Stand-Up Presents: Comedy Showcase En Tu Idioma',
      'Goods Thursdays: Dirty Dish',
      'House Worx (High Octane House Anthems - All Nite Long)',
      'Passport To Nigeria - Nigerian Independence Celebration',
      'Distrikt Fundraiser',
      'Soulwax',
      'Bean There Done That',
    ]) expect(lineupFromTitle(t), t).toEqual({ headline: t, lineup: [] });
  });

  it('rejects event furniture (the \\b bug: \\m is Postgres, and made this filter a no-op)', () => {
    // "House Dance Party" and "Rsvp" reached the artist table before the boundary was a real one
    expect(lineupFromTitle('Night Ft. House Dance Party, Rsvp, Kygo').lineup).toEqual(['Kygo']);
    expect(lineupFromTitle('X Ft. Anniversary Edition, Zedd').lineup).toEqual(['Zedd']);
  });

  it('strips a series prefix but keeps a colon that is part of the name', () => {
    // the difference is the space: "Montecito 2026: Chainsmokers" is a prefix, "re:ni" is an artist
    expect(lineupFromTitle('Party Ft. Montecito 2026: Chainsmokers, Kygo').lineup)
      .toEqual(['Chainsmokers', 'Kygo']);
    expect(lineupFromTitle('X Ft. re:ni, Blu:sh, BLOND:ISH').lineup)
      .toEqual(['re:ni', 'Blu:sh', 'BLOND:ISH']);
  });

  it('keeps the headline and de-duplicates', () => {
    const r = lineupFromTitle('Party Ft. Ada, Ada, Bee');
    expect(r.headline).toBe('Party');
    expect(r.lineup).toEqual(['Ada', 'Bee']);
  });

  it('survives empty and junk input', () => {
    expect(lineupFromTitle('')).toEqual({ headline: '', lineup: [] });
    expect(lineupFromTitle(null).lineup).toEqual([]);
    expect(lineupFromTitle('Night Ft. 2026, ///').lineup).toEqual([]);
  });
});
