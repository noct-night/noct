/**
 * The studio's vocabulary: slide templates, their data, and the review states.
 *
 * Templates and every type size in src/post/templates.ts came from the review prototype
 * (docs/INSTAGRAM.md records where). The schemas here are what /api/render and /api/publish validate
 * against, so a malformed slide is a 400 rather than a blank 1080x1350 rectangle on the account.
 *
 * Slide data is deliberately flat display strings, not event ids. A post is a snapshot of how the feed
 * read when it was drafted: an event that changes door time or sells out afterwards must not silently
 * rewrite a deck she already reviewed.
 */
import { z } from 'zod';

/** Instagram portrait. Every render is exactly this, so the publish step never has to think about aspect. */
export const CANVAS = { w: 1080, h: 1350 } as const;

/** Instagram's own ceiling on a carousel, and ours on a caption. */
export const CAROUSEL_MAX = 10;
export const CAPTION_MAX = 2200;
/** House rule, not a platform limit: max 5 hashtags, closest to the specific event. */
export const HASHTAG_MAX = 5;
/** Beyond seven rows the type has to shrink to fit, so the deck gets a second table slide instead. */
export const TABLE_ROWS_MAX = 7;
/** Rows across all of a deck's table slides: two slides at seven rows is the most a deck has room for. */
export const TABLE_ROWS_TOTAL = TABLE_ROWS_MAX * 2;

/** The prototype's placeholder tones, `.x1`..`.x6` in app.css. Used when a slide has no photo. */
export const TONES = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'] as const;
export type Tone = (typeof TONES)[number];
export const toneSchema = z.enum(TONES).default('x1');

/**
 * One treatment across every flyer is what makes an inconsistent set of promoter artwork read as one feed, so
 * the post carries a default. A slide can still choose its own (SlideImage.treatment): after review, a raw
 * photo next to mono flyers was sometimes the right call, and only a person looking at it can make it.
 * The filter chains live in src/post/treat.ts.
 */
export const TREATMENTS = ['none', 'mono', 'crush', 'warm'] as const;
export type Treatment = (typeof TREATMENTS)[number];
export const treatmentSchema = z.enum(TREATMENTS).default('mono');

/**
 * How a flyer fills the 1080x1350 frame. `cover` is the design (full bleed, type at the bottom) and the
 * default; `contain` letterboxes onto the ground. The escape hatch matters because promoter flyers carry
 * their own type near the edges and arrive in whatever aspect the promoter exported -- of the RA flyers
 * checked while building this, one of three was 4:5 and the rest needed cropping. A centre crop that eats
 * half the artist's name is worse than a letterbox, and only a human looking at it can tell which.
 */
export const FITS = ['cover', 'contain'] as const;
export type Fit = (typeof FITS)[number];
export const fitSchema = z.enum(FITS).default('cover');

const text = z.string().max(400);
const shortText = z.string().max(120);

/** An image a slide draws: a source URL we are allowed to fetch, plus how to frame it. */
/** A photo added in the studio, as a slide references it: `photo:` and the ig_photo row's uuid. */
export const PHOTO_SRC = /^photo:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const slideImageSchema = z.object({
  /** A flyer URL from the feed, or `photo:<uuid>` for one added in the studio. */
  src: z.string().refine((s) => PHOTO_SRC.test(s) || /^https?:\/\//.test(s), 'must be an http(s) URL or photo:<uuid>'),
  fit: fitSchema,
  /** The flyer a studio photo replaced, so removing the photo puts the flyer back rather than nothing. */
  flyer: z.string().url().optional(),
  /** This slide's own look. Unset means the post's treatment and grain. */
  treatment: z.enum(TREATMENTS).optional(),
  grain: z.boolean().optional(),
});
export type SlideImage = z.infer<typeof slideImageSchema>;

export const coverDataSchema = z.object({
  lede: text,
  date: text.default(''),
  foot: shortText.default(''),
  /** A background photograph, added in the studio. Without one the cover is type on the ground. */
  image: slideImageSchema.nullable().default(null),
  /** Set once a person has rewritten the words, so redrafting keeps them. See carryPhotos. */
  edited: z.boolean().optional(),
});

export const eventDataSchema = z.object({
  /** "Friday" or "Friday / 01" -- the slide's place in the deck, in words rather than a dot leader. */
  position: shortText.default(''),
  name: text,
  venue: shortText.default(''),
  time: shortText.default(''),
  genre: shortText.default(''),
  tex: toneSchema,
  image: slideImageSchema.nullable().default(null),
  /** The feed event this slide is about, so the studio can show which nights a deck was built from. */
  ref: shortText.optional(),
  edited: z.boolean().optional(),
  /**
   * Something a person has to confirm before this goes out, in their words. Never rendered: it is a note to
   * the reviewer, shown in the studio, the way `verified` is on a venue slide. Set when a name was matched
   * to Spotify on a guess (src/post/artists.ts).
   */
  check: z.string().max(300).optional(),
});

export const tableRowSchema = z.object({
  day: shortText,
  time: shortText.default(''),
  event: text,
  venue: shortText.default(''),
});

export const tableDataSchema = z.object({
  kicker: shortText.default(''),
  when: text,
  rows: z.array(tableRowSchema).max(TABLE_ROWS_MAX),
});

export const listingDataSchema = z.object({
  kicker: shortText.default('Tonight in New York'),
  when: text,
  events: z.array(z.object({
    time: shortText.default(''),
    name: text,
    venue: shortText.default(''),
    genre: shortText.default(''),
  })).max(4),
});

export const venueDataSchema = z.object({
  /** "01 / 04". Rendered right of the word "Venues", which is why it is a string and not a pair of ints. */
  index: shortText.default(''),
  name: text,
  hood: shortText.default(''),
  note: z.string().max(600).default(''),
  foot: text.default(''),
  image: slideImageSchema.nullable().default(null),
  /**
   * Whether a person has checked this venue's address and details. Most come from listings, not from anyone
   * looking, and a venue post prints the address in public -- so the studio says so before approval.
   */
  verified: z.boolean().default(true),
  edited: z.boolean().optional(),
});

/**
 * A record label: the title set inside a white circle on the black ground, split above and below the centre
 * hole, with the side and speed marks on the label's waist and the small print under it.
 *
 * The words are two blocks rather than one because a label is read as two -- the line above the hole and the
 * line below it -- and because satori cannot flow one paragraph around a hole punched in its middle.
 */
export const vinylDataSchema = z.object({
  /** Above the hole. */
  title: text,
  /** Below it. May be empty, which leaves the lower half of the label bare. */
  sub: text.default(''),
  /** The label's waist, either side of the hole. */
  side: shortText.default('SIDE A'),
  rpm: shortText.default('33 1/3 RPM'),
  /** The small print under the label, one item per line. */
  note: z.string().max(300).default(''),
  foot: shortText.default(''),
  /** A background photograph, added in the studio. The label sits on it; without one it is the ground. */
  image: slideImageSchema.nullable().default(null),
  edited: z.boolean().optional(),
});

/**
 * A venue post's opening card: the series line, then the room's name at the size a name deserves.
 *
 * Split out of `venue`, which used to carry the name, the neighbourhood, a paragraph and the address on one
 * slide. The name could never be large there because the paragraph had to fit under it.
 */
export const venueTitleDataSchema = z.object({
  kicker: shortText.default('Where to dance in NY'),
  sub: shortText.default('NOCT Guide'),
  name: text,
  hood: shortText.default(''),
  /** The address. This is the slide that prints it, which is why `verified` lives here. */
  foot: text.default(''),
  image: slideImageSchema.nullable().default(null),
  /**
   * Whether a person has checked this venue's address. Most come from listings, not from anyone looking,
   * and a venue post prints an address in public -- so the studio warns before approval.
   */
  verified: z.boolean().default(true),
  edited: z.boolean().optional(),
});

/**
 * The second card: what the room is, and what people say about it.
 *
 * `says` has no source. Nothing in the feed carries a review, a quote or a rating, so the drafter leaves it
 * empty and a person fills it in the studio. One quote per line; the slide draws the quotation marks.
 */
export const venueStoryDataSchema = z.object({
  /** The venue, small, at the top -- this slide follows its title card and should say whose it is. */
  name: text,
  note: z.string().max(600).default(''),
  says: z.string().max(600).default(''),
  foot: shortText.default(''),
  edited: z.boolean().optional(),
});

export const venueCoverDataSchema = z.object({
  lede: text,
  sub: text.default(''),
  foot: shortText.default(''),
});

/** The closing call to action. The icon is part of the template; the data is only words. */
export const ctaDataSchema = z.object({
  question: text,
  answer: text.default(''),
  link: shortText.default(''),
  note: shortText.default(''),
  edited: z.boolean().optional(),
});
/** The words on the closing slide, which are a setting as well as slide data. See src/post/cta.ts. */
export type CtaData = z.infer<typeof ctaDataSchema>;

export const noteDataSchema = z.object({
  text: text,
  after: z.string().max(600).default(''),
  foot: shortText.default(''),
});

/**
 * A slide is a template plus its data. Discriminated on `template` so a table's rows can never end up
 * being read as an event's lineup.
 */
export const slideSchema = z.discriminatedUnion('template', [
  z.object({ template: z.literal('cover'), data: coverDataSchema }),
  z.object({ template: z.literal('event'), data: eventDataSchema }),
  z.object({ template: z.literal('table'), data: tableDataSchema }),
  z.object({ template: z.literal('listing'), data: listingDataSchema }),
  z.object({ template: z.literal('venue'), data: venueDataSchema }),
  z.object({ template: z.literal('venuecover'), data: venueCoverDataSchema }),
  z.object({ template: z.literal('vinyl'), data: vinylDataSchema }),
  z.object({ template: z.literal('venuetitle'), data: venueTitleDataSchema }),
  z.object({ template: z.literal('venuestory'), data: venueStoryDataSchema }),
  z.object({ template: z.literal('note'), data: noteDataSchema }),
  z.object({ template: z.literal('cta'), data: ctaDataSchema }),
]);
export type Slide = z.infer<typeof slideSchema>;
export type Template = Slide['template'];

/** What a slide looks like on the page, for the studio's per-template label. */
export const TEMPLATE_LABEL: Record<Template, string> = {
  cover: 'carousel',
  event: 'event',
  table: 'table',
  listing: 'listing',
  venue: 'venue',
  venuecover: 'venues',
  vinyl: 'record',
  venuetitle: 'venue title',
  venuestory: 'venue story',
  note: 'note',
  cta: 'cta',
};

/** Templates that draw a photo. The rest are type on the ground and ignore the treatment entirely. */
export const TAKES_IMAGE: ReadonlySet<Template> = new Set<Template>(['cover', 'event', 'venue', 'vinyl', 'venuetitle']);

/**
 * What Meta is handed at the end. A carousel is N `image_url` children with is_carousel_item; a reel is
 * one `video_url` with media_type=REELS. Everything before that -- drafting, the caption rules, the review
 * states, the publish claim -- is shared, which is why this is a discriminator on ig_post and not a second
 * table. See supabase/migrations/0032_ig_reels.sql.
 */
export const KINDS = ['carousel', 'reel'] as const;
export type PostKind = (typeof KINDS)[number];
export const kindSchema = z.enum(KINDS).default('carousel');

/**
 * What ffprobe said about the encoded reel. Stored because nearly every Graph API rejection of a reel is a
 * spec violation, and these are the specs -- without them a failure can only be diagnosed by finding the
 * file again. Loose on purpose: it is a record of what was measured, never an input to a decision.
 */
export const videoMetaSchema = z.object({
  seconds: z.number().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  fps: z.number().nonnegative(),
  bytes: z.number().int().nonnegative(),
  vcodec: z.string().max(40),
  acodec: z.string().max(40).nullable(),
// Every field optional so an older row, or one written before a field existed, still reads. Not
// passthrough: an index signature here would stop the concrete VideoMeta in src/video/spec.ts from being
// assignable, and this type exists to receive exactly that.
}).partial();
export type StoredVideoMeta = z.infer<typeof videoMetaSchema>;

export const SERIES = ['weekend', 'venues', 'single', 'genre', 'artists'] as const;
export type Series = (typeof SERIES)[number];

export const STATUSES = ['queued', 'approved', 'passed', 'posted'] as const;
export type PostStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<PostStatus, string> = {
  queued: 'In queue',
  approved: 'Approved',
  passed: 'Passed',
  posted: 'Published',
};

/** One row of ig_post as the studio page sees it. */
export interface Post {
  id: string;
  series: Series;
  kind: PostKind;
  /** YYYY-MM-DD, or null for the evergreen series. */
  slot: string | null;
  status: PostStatus;
  /** Which post within the series and slot: a genre family, an event id, a venue. Null for the weekend deck. */
  edition: string | null;
  caption: string;
  /** Empty for a reel. */
  slides: Slide[];
  /** Set for a reel only: the public MP4 Meta fetches, and an optional cover frame beside it. */
  video_url: string | null;
  cover_url: string | null;
  video_meta: StoredVideoMeta;
  treatment: Treatment;
  grain: boolean;
  ig_permalink: string | null;
  posted_at: string | null;
  updated_at: string;
  /** Photo credits added to the caption on publish ("Photo: ..."). Attached by the API, not stored. */
  credits?: string[];
}

/** The subset of a post the studio may change. Status moves have their own route; publishing has its own. */
export const postPatchSchema = z.object({
  caption: z.string().max(CAPTION_MAX).optional(),
  status: z.enum(STATUSES).optional(),
  slides: z.array(slideSchema).max(CAROUSEL_MAX).optional(),
  // Not treatmentSchema: its default('mono') fills in a treatment on every patch that does not send one, so
  // saving a caption or approving a post silently reset the look chosen for it.
  treatment: z.enum(TREATMENTS).optional(),
  grain: z.boolean().optional(),
}).strict();
export type PostPatch = z.infer<typeof postPatchSchema>;

/** What /api/render accepts: one slide, plus the post-level look it is being drawn under. */
export const renderRequestSchema = z.object({
  slide: slideSchema,
  treatment: treatmentSchema,
  grain: z.boolean().default(false),
});
export type RenderRequest = z.infer<typeof renderRequestSchema>;
