import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  attachPhoto, carryPhotos, creditsFor, detachPhoto, normalisePhoto, PhotoError, photoIdOf, photoIdsIn, withCredits,
} from '../../src/post/photos.js';
import { slideSchema, type Slide } from '../../src/post/types.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FLYER = 'https://images.ra.co/flyer.jpg';

const s = (o: unknown): Slide => slideSchema.parse(o);
const event = (name: string, src: string | null, extra: Record<string, unknown> = {}): Slide => s({
  template: 'event', data: { name, venue: 'Nowadays', tex: 'x1', image: src ? { src, fit: 'cover', ...extra } : null },
});
const venue = (name: string, src: string | null): Slide => s({
  template: 'venue', data: { name, image: src ? { src, fit: 'cover' } : null },
});
const cover = s({ template: 'cover', data: { lede: 'Where to rave' } });

describe('photo references', () => {
  it('accepts a studio photo or a flyer URL as a slide image, and nothing else', () => {
    expect(() => event('x', `photo:${A}`)).not.toThrow();
    expect(() => event('x', FLYER)).not.toThrow();
    expect(() => event('x', 'photo:not-a-uuid')).toThrow();
    expect(() => event('x', 'javascript:alert(1)')).toThrow();
  });

  it('reads the id out of a studio photo, and nothing out of a flyer', () => {
    expect(photoIdOf(`photo:${A}`)).toBe(A);
    expect(photoIdOf(FLYER)).toBeNull();
    expect(photoIdOf(undefined)).toBeNull();
  });

  it('lists the photos a deck uses once each, in slide order', () => {
    expect(photoIdsIn([cover, event('a', `photo:${B}`), event('b', FLYER), venue('c', `photo:${A}`), event('d', `photo:${B}`)]))
      .toEqual([B, A]);
  });
});

describe('credits', () => {
  const sources = new Map([[A, 'Nowadays / @nowadaysnyc'], [B, 'Ryan Muir']]);

  it('credits each photo once, in slide order', () => {
    expect(creditsFor([event('a', `photo:${B}`), venue('v', `photo:${A}`), event('b', `photo:${B}`)], sources))
      .toEqual(['Photo: Ryan Muir', 'Photo: Nowadays / @nowadaysnyc']);
  });

  it('puts credits before the hashtags, so the tags stay last', () => {
    const caption = 'Nowadays, Ridgewood, Queens.\n\nListings at noct.pro\n\n#nycnightlife #house';
    expect(withCredits(caption, ['Photo: Ryan Muir'])).toBe(
      'Nowadays, Ridgewood, Queens.\n\nListings at noct.pro\n\nPhoto: Ryan Muir\n\n#nycnightlife #house',
    );
  });

  it('appends credits when the caption has no hashtags, and leaves a caption with no photos alone', () => {
    expect(withCredits('A night.', ['Photo: A', 'Photo: B'])).toBe('A night.\n\nPhoto: A\nPhoto: B');
    expect(withCredits('A night.', [])).toBe('A night.');
  });
});

describe('attaching and removing', () => {
  it('attaches a photo and remembers the flyer it covers', () => {
    const [, e] = attachPhoto([cover, event('a', FLYER)], 1, A);
    expect(e).toMatchObject({ data: { image: { src: `photo:${A}`, fit: 'cover', flyer: FLYER } } });
  });

  it('keeps remembering the original flyer when a photo is replaced by another', () => {
    const once = attachPhoto([event('a', FLYER)], 0, A);
    const twice = attachPhoto(once, 0, B);
    expect(twice[0]).toMatchObject({ data: { image: { src: `photo:${B}`, flyer: FLYER } } });
  });

  it('puts the flyer back on removal, or leaves no image if there was none', () => {
    expect(detachPhoto(attachPhoto([event('a', FLYER)], 0, A), 0)[0]).toMatchObject({ data: { image: { src: FLYER } } });
    expect(detachPhoto(attachPhoto([venue('v', null)], 0, A), 0)[0]).toMatchObject({ data: { image: null } });
  });

  it('refuses a slide that has no photo to show', () => {
    const cta = s({ template: 'cta', data: { question: 'sick of checking 10 places?' } });
    expect(() => attachPhoto([cta], 0, A)).toThrow(PhotoError);
  });

  it('gives the cover a background photo, and removing it leaves the plain cover', () => {
    const [withPhoto] = attachPhoto([cover], 0, A);
    expect(withPhoto).toMatchObject({ template: 'cover', data: { image: { src: `photo:${A}` } } });
    expect(detachPhoto([withPhoto!], 0)[0]).toMatchObject({ data: { image: null } });
  });
});

describe('redrafting keeps chosen photos', () => {
  it('carries a photo to the same night and the same venue in the new draft', () => {
    const before = [cover, event('MERGE', `photo:${A}`, { flyer: FLYER }), venue('Nowadays', `photo:${B}`)];
    const after = carryPhotos(before, [cover, event('MERGE', FLYER), event('New night', FLYER), venue('Nowadays', null)]);
    expect(after[1]).toMatchObject({ data: { image: { src: `photo:${A}`, flyer: FLYER } } });
    expect(after[2]).toMatchObject({ data: { image: { src: FLYER } } });
    expect(after[3]).toMatchObject({ data: { image: { src: `photo:${B}` } } });
  });

  it('keeps the cover background through a redraft, whatever the new cover says', () => {
    const before = attachPhoto([cover], 0, A);
    const next = s({ template: 'cover', data: { lede: 'A different weekend' } });
    expect(carryPhotos(before, [next])[0]).toMatchObject({ data: { lede: 'A different weekend', image: { src: `photo:${A}` } } });
  });

  it('drops a photo whose night is no longer in the draft, rather than moving it onto another', () => {
    const after = carryPhotos([event('Gone', `photo:${A}`)], [event('Different', FLYER)]);
    expect(photoIdsIn(after)).toEqual([]);
  });

  it('keeps a slide whose words were rewritten exactly as it was left', () => {
    const mine = s({ template: 'event', data: { name: 'MERGE ft Someone', venue: 'Nowadays', time: '', genre: '', ref: 'ev1', edited: true } });
    const redrafted = s({ template: 'event', data: { name: 'MERGE ft Someone, Someone Else, And Another', venue: 'Nowadays', time: '23:00', genre: 'Techno', ref: 'ev1' } });
    expect(carryPhotos([mine], [redrafted])[0]).toEqual(mine);
  });

  it('finds the same night by its feed event even after the title was changed', () => {
    const before = [s({ template: 'event', data: { name: 'Short title', venue: 'Nowadays', ref: 'ev1', image: { src: `photo:${A}`, fit: 'cover' } } })];
    const after = carryPhotos(before, [s({ template: 'event', data: { name: 'The long feed title', venue: 'Nowadays', ref: 'ev1', image: null } })]);
    expect(after[0]).toMatchObject({ data: { name: 'The long feed title', image: { src: `photo:${A}` } } });
  });

  it('matches a slide drafted before events were referenced by name and venue', () => {
    const after = carryPhotos([event('MERGE', `photo:${A}`)], [s({ template: 'event', data: { name: 'MERGE', venue: 'Nowadays', ref: 'ev1' } })]);
    expect(photoIdsIn(after)).toEqual([A]);
  });

  it('carries a look chosen for a flyer onto the flyer the new draft found', () => {
    const after = carryPhotos([event('MERGE', FLYER, { treatment: 'none', grain: true })], [event('MERGE', 'https://images.ra.co/new.jpg')]);
    expect(after[0]).toMatchObject({ data: { image: { src: 'https://images.ra.co/new.jpg', treatment: 'none', grain: true } } });
  });
});

describe('normalisePhoto', () => {
  it('re-encodes to JPEG within the size limit', async () => {
    const png = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#445566' } }).png().toBuffer();
    const { jpeg, width, height } = await normalisePhoto(png);
    expect((await sharp(jpeg).metadata()).format).toBe('jpeg');
    expect(Math.max(width, height)).toBe(2400);
  });

  it('drops metadata, which is where a phone writes the location', async () => {
    const tagged = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } })
      .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'somewhere' } } }).toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const { jpeg } = await normalisePhoto(tagged);
    expect((await sharp(jpeg).metadata()).exif).toBeUndefined();
  });

  it('refuses something that is not an image', async () => {
    await expect(normalisePhoto(Buffer.from('not an image at all'))).rejects.toThrow(PhotoError);
  });
});
