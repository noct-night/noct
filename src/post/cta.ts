/**
 * The closing slide's words, kept as a setting rather than as a constant.
 *
 * Every deck ends with the same call to action, which is the point of it: a follower sees the same line
 * every weekend and learns what NOCT is for. That also makes it the one piece of copy most worth being able
 * to change without a deploy -- it is marketing, it gets rewritten, and rewriting it in the studio and
 * having the next draft use it is the whole ask.
 *
 * Stored in app_setting (0008) as JSON, so there is no new table and no migration. The default below is
 * what a deployment that has never been edited uses, and what an unreadable or malformed row falls back to,
 * because a deck without its last slide is worse than a deck with the old wording.
 */
import { query } from '../lib/db.js';
import { CTA_SLIDE } from './draft.js';
import { ctaDataSchema, type CtaData, type Slide } from './types.js';

const SETTING = 'ig_cta';

/** What a deployment nobody has edited uses: the copy as written, from the pure drafting side. */
export const CTA_DEFAULT: CtaData = CTA_SLIDE.template === 'cta' ? CTA_SLIDE.data : ctaDataSchema.parse({ question: '' });

/** The closing slide as a deck carries it. */
export const ctaSlide = (copy: CtaData = CTA_DEFAULT): Slide => ({ template: 'cta', data: copy });

/**
 * The words the next draft will use.
 *
 * Never throws: drafting a whole weekend must not fail because one setting row is unreadable, so anything
 * unparseable is the default.
 */
export async function currentCta(): Promise<CtaData> {
  try {
    const { rows } = await query<{ value: string }>(`select value from app_setting where key = $1`, [SETTING]);
    if (!rows[0]) return CTA_DEFAULT;
    const parsed = ctaDataSchema.safeParse(JSON.parse(rows[0].value));
    return parsed.success ? parsed.data : CTA_DEFAULT;
  } catch {
    return CTA_DEFAULT;
  }
}

/** Store the words. Returns what was stored, as the schema read it. */
export async function saveCta(copy: CtaData): Promise<CtaData> {
  const value = ctaDataSchema.parse(copy);
  await query(
    `insert into app_setting (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETTING, JSON.stringify(value)],
  );
  return value;
}
