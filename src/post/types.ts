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

/** The prototype's placeholder tones, `.x1`..`.x6` in app.css. Used when a slide has no photo. */
export const TONES = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'] as const;
export type Tone = (typeof TONES)[number];
export const toneSchema = z.enum(TONES).default('x1');

/**
 * One treatment across every flyer is what makes an inconsistent set of promoter artwork read as one feed.
 * Global per post, never per slide. The filter chains live in src/post/treat.ts.
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
export const slideImageSchema = z.object({
  src: z.string().url(),
  fit: fitSchema,
});
export type SlideImage = z.infer<typeof slideImageSchema>;

export const coverDataSchema = z.object({
  lede: text,
  date: text.default(''),
  foot: shortText.default(''),
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
});

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
  note: 'note',
  cta: 'cta',
};

/** Templates that draw a photo. The rest are type on the ground and ignore the treatment entirely. */
export const TAKES_IMAGE: ReadonlySet<Template> = new Set<Template>(['event', 'venue']);

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

export const SERIES = ['weekend', 'venues', 'single'] as const;
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
}

/** The subset of a post the studio may change. Status moves have their own route; publishing has its own. */
export const postPatchSchema = z.object({
  caption: z.string().max(CAPTION_MAX).optional(),
  status: z.enum(STATUSES).optional(),
  slides: z.array(slideSchema).max(CAROUSEL_MAX).optional(),
  treatment: treatmentSchema.optional(),
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
