import { describe, expect, it } from 'vitest';
import {
  crosswalk, lookupLabel, mapDiceTag, mapElsewhereGenre, mapRaGenre, mapTicketmasterSubGenre, matchText, squash,
} from '../../src/enrich/crosswalk.js';

describe('crosswalk: RA genre names', () => {
  it('maps specific names at full weight and family names as generic', () => {
    expect(mapRaGenre('Deep House')).toMatchObject({ code: 'house.deep', weight: 0.8, generic: false, electronic: true, source: 'ra' });
    expect(mapRaGenre('House')).toMatchObject({ code: 'house.deep', weight: 0.32, generic: true });
    expect(mapRaGenre('Techno')).toMatchObject({ code: 'techno.peak', generic: true });
    expect(mapRaGenre('Afro Tech')?.code).toBe('house.afro');
    expect(mapRaGenre('Funk / Soul')?.code).toBe('disco.disco');
    expect(mapRaGenre('Dub')?.code).toBe('carib.reggae_dub');
    expect(mapRaGenre('Dub Techno')?.code).toBe('techno.dub');
    expect(mapRaGenre('Club')).toMatchObject({ code: 'bass.club', generic: true });
    expect(mapRaGenre('Minimal Techno')?.code).toBe('techno.minimal');
    expect(mapRaGenre('Drum & Bass')).toMatchObject({ code: 'dnb.neuro_jumpup', generic: true });
    expect(mapRaGenre('Not A Genre')).toBeNull();
  });
  it('flags non-club families through the electronic hint', () => {
    expect(mapRaGenre('Pop')).toMatchObject({ code: 'live.indie_electronic', electronic: false });
    expect(mapRaGenre('Hip-Hop')).toMatchObject({ code: 'hiphop.rap', electronic: false });
    expect(mapRaGenre('Electronica')).toMatchObject({ code: 'live.indie_electronic', electronic: true });
  });
});

describe('crosswalk: DICE genre_tags', () => {
  it('maps prefixed and bare suffixes', () => {
    expect(mapDiceTag('dj:tech-house').hit).toMatchObject({ code: 'house.tech', weight: 0.6, source: 'dice' });
    expect(mapDiceTag('tech house').hit?.code).toBe('house.tech');
    expect(mapDiceTag('dj:hard techno').hit?.code).toBe('techno.hard');
    expect(mapDiceTag('party:afro_house').hit?.code).toBe('house.afro');
    expect(mapDiceTag('afrohouse').hit?.code).toBe('house.afro');
    expect(mapDiceTag('dj:melodictechno').hit?.code).toBe('house.progressive');
    expect(mapDiceTag('dj:deephouse').hit?.code).toBe('house.deep');
    expect(mapDiceTag('dj:minimal').hit?.code).toBe('techno.minimal');
    expect(mapDiceTag('dj:industrial').hit?.code).toBe('electro.ebm_industrial');
    expect(mapDiceTag('dj:bass').hit).toMatchObject({ code: 'bass.club', generic: true });
    expect(mapDiceTag('dj:dub').hit?.code).toBe('carib.reggae_dub');
    expect(mapDiceTag('dj:psych').hit?.code).toBe('trance.psy');
    expect(mapDiceTag('dj:electronica').hit?.code).toBe('live.indie_electronic');
    expect(mapDiceTag('dj:progressivehouse').hit?.code).toBe('house.progressive');
    expect(mapDiceTag('dj:afrobeat').hit?.code).toBe('afro.afrobeats');
    expect(mapDiceTag('dj:jersey_club').hit?.code).toBe('bass.club');
    expect(mapDiceTag('dj:amapiano').hit?.code).toBe('afro.amapiano');
  });
  it('reads the prefix: gigs, comedy and non-music tags are not club nights', () => {
    expect(mapDiceTag('gig:indierock')).toMatchObject({ hit: null, electronic: false });
    expect(mapDiceTag('gig:hardcore')).toMatchObject({ hit: null, electronic: false, live: true });
    expect(mapDiceTag('comedy:comedy')).toMatchObject({ hit: null, electronic: false });
    expect(mapDiceTag('theatre:dragshow')).toMatchObject({ hit: null, electronic: false, vibe: 'performance_or_cabaret' });
    expect(mapDiceTag('gig:electronic')).toMatchObject({ hit: { code: 'live.indie_electronic' }, live: true });
    expect(mapDiceTag('dj:electronic')).toMatchObject({ hit: null, electronic: true });
    expect(mapDiceTag('dj:indie')).toMatchObject({ hit: { code: 'live.indie_electronic', electronic: false } });
  });
  it('turns identity / scale tags into vibe hints', () => {
    expect(mapDiceTag('dj:lgbtq+')).toMatchObject({ hit: null, vibe: 'queer_party' });
    expect(mapDiceTag('social:queer').vibe).toBe('queer_party');
    expect(mapDiceTag('dj:edm')).toMatchObject({ hit: null, vibe: 'mainstream_club', electronic: true });
  });
});

describe('crosswalk: Elsewhere and Ticketmaster', () => {
  it('Elsewhere six-genre vocabulary', () => {
    expect(mapElsewhereGenre('Electronic')).toMatchObject({ hit: null, electronic: true });
    expect(mapElsewhereGenre('Live Electronic')).toMatchObject({ hit: { code: 'live.indie_electronic', source: 'elsewhere' }, electronic: true, live: true });
    expect(mapElsewhereGenre('Indie')).toMatchObject({ hit: null, electronic: false });
    expect(mapElsewhereGenre('Rock').electronic).toBe(false);
    expect(mapElsewhereGenre('Pop').electronic).toBe(false);
    expect(mapElsewhereGenre('Hip Hop / R&B')).toMatchObject({ hit: { code: 'hiphop.rap' }, electronic: false });
  });
  it('Ticketmaster subGenre names', () => {
    expect(mapTicketmasterSubGenre('House').hit).toMatchObject({ code: 'house.deep', generic: true, source: 'ticketmaster' });
    expect(mapTicketmasterSubGenre('Techno').hit?.code).toBe('techno.peak');
    expect(mapTicketmasterSubGenre('Drum & Bass').hit?.code).toBe('dnb.neuro_jumpup');
    expect(mapTicketmasterSubGenre('Dance/Electronic')).toMatchObject({ hit: null, electronic: true });
    expect(mapTicketmasterSubGenre('Hip-Hop/Rap')).toMatchObject({ hit: { code: 'hiphop.rap' }, electronic: false });
    expect(mapTicketmasterSubGenre('Reggae').hit?.code).toBe('carib.reggae_dub');
    expect(mapTicketmasterSubGenre('Rock')).toMatchObject({ hit: null, electronic: false });
  });
});

describe('crosswalk: free text', () => {
  it('matches aliases on word boundaries, longest first, once per code', () => {
    expect(matchText('Dust Till Dawn — deep house all afternoon', 'text:title').map((h) => h.code)).toEqual(['house.deep']);
    const desc = matchText('Low tempo, psychedelic, drawing on coldwave and outsider dance music.', 'text:description');
    expect(desc.map((h) => h.code).sort()).toEqual(['electro.ebm_industrial', 'leftfield.experimental']);
    expect(desc[0]).toMatchObject({ source: 'text:description', weight: 0.35 });
    // "dub techno" is consumed before "dub"/"techno" could match
    expect(matchText('a night of dub techno', 'text:title').map((h) => h.code)).toEqual(['techno.dub']);
    expect(matchText('DUBSTEP takeover', 'text:title')[0]?.code).toBe('dubstep.140');
    expect(matchText('afrobeats party', 'text:title')[0]?.code).toBe('afro.afrobeats');
    expect(matchText('afrobeat orchestra', 'text:title')[0]?.code).toBe('afro.afrobeat');
    expect(matchText('R&B slow jams', 'text:title')[0]?.code).toBe('hiphop.rnb');
    expect(matchText('Ivkovic (Offen Music)', 'text:title')).toEqual([]);
  });
  it('does not fire on venue names that happen to be genre words', () => {
    expect(matchText('Jupiter Disco presents: Friday', 'text:title')).toEqual([]);
    expect(matchText('House of Yes: Ketamine, the Musical', 'text:title')).toEqual([]);
    expect(matchText('Garage Rooftop Party', 'text:title')).toEqual([]);
    expect(matchText('Basement: Friday', 'text:title')).toEqual([]);
    expect(matchText('Ballroom at Webster Hall', 'text:title')).toEqual([]);
    expect(matchText('electronic music showcase', 'text:title')).toEqual([]);
    expect(matchText(null, 'text:title')).toEqual([]);
  });
});

describe('crosswalk: aggregation', () => {
  it('combines independent labels per code and ranks them', () => {
    const r = crosswalk({
      labelsBySource: [{ source: 'ra', labels: ['House', 'Deep House'] }, { source: 'dice', labels: ['dj:deephouse', 'dj:tech-house', 'dj:lgbtq+'] }],
      title: 'Body Movements', description: null,
    });
    expect(r.ranked[0]).toMatchObject({ code: 'house.deep', weight: 0.95 });
    expect(r.ranked[0]?.sources).toEqual(expect.arrayContaining(['ra:House', 'ra:Deep House', 'dice:dj:deephouse']));
    expect(r.ranked[1]).toMatchObject({ code: 'house.tech', weight: 0.6 });
    expect(r.is_electronic).toBe(true);
    expect(r.vibe_hints).toEqual([{ code: 'queer_party', source: 'dice', label: 'dj:lgbtq+' }]);
    expect(r.unmapped).toEqual([]);
  });
  it('is_electronic is false for rock/indie-only or hip-hop-only sources, null when nothing is known', () => {
    expect(crosswalk({ labelsBySource: [{ source: 'dice', labels: ['gig:indierock', 'gig:rock'] }] }).is_electronic).toBe(false);
    expect(crosswalk({ labelsBySource: [{ source: 'ra', labels: ['Hip-Hop', 'R&B'] }] }).is_electronic).toBe(false);
    expect(crosswalk({ labelsBySource: [{ source: 'dice', labels: ['dj:hiphop', 'dj:house'] }] }).is_electronic).toBe(true);
    expect(crosswalk({ labelsBySource: [], title: 'Untitled', description: null }).is_electronic).toBeNull();
    // free text can only vote "electronic", never against
    expect(crosswalk({ labelsBySource: [], title: 'Hard techno all night' }).is_electronic).toBe(true);
  });
  it('surfaces unknown labels instead of guessing', () => {
    const r = crosswalk({ labelsBySource: [{ source: 'dice', labels: ['dj:zzznotreal'] }, { source: 'goodroom', labels: ['Disco'] }] });
    expect(r.unmapped).toEqual([{ source: 'dice', label: 'dj:zzznotreal' }]);
    expect(r.ranked[0]?.code).toBe('disco.disco');
  });
  it('squash and lookupLabel are the shared normalisation', () => {
    expect(squash('Tech-House')).toBe('techhouse');
    expect(squash('Drum & Bass')).toBe('drumbass');
    expect(lookupLabel('UK Garage')).toBe('house.garage');
    expect(lookupLabel('Speed Garage')).toBe('house.garage');
    expect(lookupLabel('Abstract')).toBe('leftfield.experimental');
  });
});
