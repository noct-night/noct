/**
 * Stage S1: deterministic rules. Pure, versioned, no I/O.
 *
 * Rules produce what can be READ OFF the listing without judgement: time-of-day vibes and scalars, price and
 * age policy, venue / promoter priors, format cues in the billing, plus genre priors from the crosswalk. The
 * classifier (classify.ts) reconciles on top; when no API key is configured these outputs ARE the labels.
 *
 * Bump RULES_VERSION whenever a rule changes so classification_version marks affected events for re-run.
 */
import { parseLineupItem } from '../lib/normalize.js';
import { toLocalParts } from '../lib/time.js';
import { crosswalk, type CrosswalkResult } from './crosswalk.js';
import type { GenreCode, VibeCode } from './taxonomy.js';
import { isVibeCode } from './taxonomy.js';

export const RULES_VERSION = 'rules-v1';

export interface RuleVenue {
  name: string;
  kind?: string | null;
  space_types: string[];
  outdoor: boolean | null;
  phone_policy: 'none' | 'no_photos' | 'pouch' | null;
  capacity: number | null;
  typical_genres: string[];
  vibe_priors: string[];
  underground_prior: number | null;
}

export interface RulePromoter {
  name: string;
  genre_priors: string[];
  vibe_priors: string[];
  underground_prior: number | null;
}

export interface RuleInput {
  title: string;
  lineup: string[];
  /** ISO instants (UTC) or null */
  starts_at: string | null;
  ends_at: string | null;
  has_time: boolean;
  /** YYYY-MM-DD nightlife date in the event's time zone */
  night: string;
  /** IANA time zone for local-time rules (default America/New_York) */
  tz?: string;
  price_min: number | null;
  price_max: number | null;
  price_note?: string | null;
  age_min: number | null;
  description: string | null;
  sold_out?: boolean | null;
  interested_count?: number | null;
  venue: RuleVenue | null;
  promoter_priors: RulePromoter[];
  /** event.source_tags — {"ra": {...}, "dice": {...}}; keys tell us which sources list the event */
  source_tags: Record<string, unknown>;
  /** raw genre labels per source (listing.genres grouped by listing.source_key) */
  source_genres?: { source: string; labels: string[] }[];
}

export interface RuleVibe { code: VibeCode; rule: string; evidence: string }
export interface RuleScalars {
  start_lateness?: number;
  end_lateness?: number;
  price_tier?: number;
  crowd_size?: number;
  underground_index?: number;
}
export interface GenrePrior { code: GenreCode; weight: number; source: string; evidence: string }

export interface RuleOutput {
  version: string;
  vibes: RuleVibe[];
  scalars: RuleScalars;
  genre_priors: GenrePrior[];
  /** data-quality notes for the classifier / reviewer: 'no_time', 'no_price', 'no_venue', 'no_lineup', 'sparse_description' */
  flags: string[];
  crosswalk: CrosswalkResult;
  /** derived timing, handy for the evidence bundle */
  timing: { start_local: string | null; end_local: string | null; duration_h: number | null; weekday: number | null };
}

// ---- helpers ---------------------------------------------------------------------------------------
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)));

interface Timing {
  startHour: number | null;    // local wall clock of the start with minutes as a fraction, 0..24
  startT: number | null;       // start on the night axis: hours since the NIGHT's midnight (a 04:00 afters start is 28)
  endT: number | null;         // end on the same axis: 21 = 21:00 same day, 29 = 05:00 next morning, 35 = 11:00 after an afters
  durationH: number | null;
  weekday: number | null;
  startLocal: string | null;
  endLocal: string | null;
}

const NO_TIMING: Timing = { startHour: null, startT: null, endT: null, durationH: null, weekday: null, startLocal: null, endLocal: null };

function timing(input: RuleInput): Timing {
  if (!input.has_time || !input.starts_at) return NO_TIMING;
  const start = new Date(input.starts_at);
  if (Number.isNaN(start.getTime())) return NO_TIMING;
  const tz = input.tz ?? 'America/New_York';
  const sp = toLocalParts(start, tz);
  const startHour = sp.hour + sp.minute / 60;
  // Anything before 06:00 belongs to the previous night (night_date()), so put it past 24 on the night axis:
  // an afters running 04:00–11:00 then ends at 35 (after sunrise), not at "11" like a brunch party would.
  const startT = startHour < 6 ? startHour + 24 : startHour;
  let endT: number | null = null, durationH: number | null = null, endLocal: string | null = null;
  const end = input.ends_at ? new Date(input.ends_at) : null;
  if (end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime()) {
    durationH = (end.getTime() - start.getTime()) / 3_600_000;
    endT = startT + durationH;
    endLocal = toLocalParts(end, tz).time;
  }
  return { startHour, startT, endT, durationH, weekday: sp.weekday, startLocal: sp.time, endLocal };
}

export function startLateness(startHour: number): number {
  if (startHour < 6) return 5;      // after midnight (an afters)
  if (startHour < 17) return 1;
  if (startHour < 20) return 2;
  if (startHour < 22) return 3;
  return 4;
}

export function endLateness(endT: number): number {
  if (endT <= 22) return 1;
  if (endT <= 25) return 2;  // <= 01:00
  if (endT <= 28) return 3;  // <= 04:00
  if (endT <= 30) return 4;  // <= 06:00
  return 5;
}

export function priceTier(min: number | null, max: number | null): number | undefined {
  if (min === null && max === null) return undefined;
  const entry = min ?? max ?? 0;
  if (entry <= 0) return 0;
  if (entry <= 15) return 1;
  if (entry <= 30) return 2;
  if (entry <= 60) return 3;
  return 4;
}

export function crowdSize(capacity: number | null): number | undefined {
  if (!capacity || capacity <= 0) return undefined;
  if (capacity < 150) return 1;
  if (capacity < 400) return 2;
  if (capacity < 1000) return 3;
  if (capacity < 3000) return 4;
  return 5;
}

const LIVE_TITLE_RE = /\((?:live|hybrid(?: set)?|live set|live pa)\)|\blive\s+(?:set|pa|show)\b/i;
const ALL_NIGHT_RE = /\ball\s+(?:night|day)(?:\s+long)?\b|\bopen\s+to\s+close\b|\bextended\s+set\b|\bmarathon\s+set\b/i;
const B2B_RE = /\b(?:b2b|b3b|b4b|back\s+to\s+back)\b|\bvs\.?\s/gi;
const FREE_TITLE_RE = /\bfree\b|\brsvp\b|\bno\s+cover\b/i;
const FREE_DESC_RE = /\bfree\s+(?:entry|admission|event|party|with\s+rsvp|w\/\s*rsvp|all\s+night)\b|\brsvp\s+(?:for\s+)?free\b|\bno\s+cover\b|\bfree\s+before\s+\d/i;
const CHEAP_EARLY_RE = /(?:\$\s?\d+(?:\.\d\d)?|\bfree|\boff\b|cheaper|reduced|discount)[^.\n]{0,40}?\bbefore\s+(?:midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|h)?)\b|\bbefore\s+(?:midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|h)?)[^.\n]{0,30}?\$\s?\d+|\bearly\s?bird\b/i;
const PHONE_FREE_RE = /\bno\s+(?:photos?|phones?|cameras?|photography|filming)\b|\bphone[- ]?free\b|\bcamera[- ]free\b|\bstickers?\s+(?:over|on)\s+(?:your\s+)?(?:phone\s+)?cameras?\b|\bphone\s+pouch/i;
const WAREHOUSE_RE = /\bwarehouse\b/i;
const BASEMENT_RE = /\bbasement\b/i;
const OUTDOOR_RE = /\b(?:the\s+yard|garden\s+party|patio|outdoor|open[- ]air|courtyard|the\s+ruins|backyard)\b/i;
const ROOFTOP_RE = /\brooftop\b|\broof\s+party\b|\bon\s+the\s+roof\b/i;
const BOAT_RE = /\b(?:boat|yacht|cruise|sail(?:ing)?|on\s+the\s+water)\b/i;
const PIER_RE = /\bpier\s+\d+\b|\bthe\s+pier\b|\bbeach\s+party\b|\bin\s+the\s+park\b/i;
const SECRET_RE = /\bsecret\s+location\b|\blocation\s+tba\b|\bvenue\s+tba\b|\bundisclosed\b|\baddress\s+(?:sent|revealed|announced|emailed)\b|\btba\b/i;
const FESTIVAL_RE = /\bfestival\b|\bfest\b/i;
const WEEKLY_RE = /\bweekly\b|\bevery\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b/i;
const ONE_OFF_RE = /\banniversary\b|\bclosing\s+party\b|\bopening\s+party\b|\bone[- ]off\b|\bfarewell\b|\bfinal\s+(?:party|edition|night)\b|\blast\s+dance\b|\bgrand\s+opening\b|\bseason\s+(?:opener|closer|closing)\b/i;
const QUEER_RE = /\b(?:queer|lgbtq\+?|gay|lesbian|dyke|trans|kiki|vogue|voguing|drag)\b/i;
const LATINX_RE = /\b(?:latinx|latin[ao]s?|perreo|reggaet[oó]n|dembow|cumbia|noche\s+latina)\b/i;
const DIASPORA_RE = /\b(?:afrobeats|amapiano|dancehall|soca|gqom|afro\s?house|carnival)\b/i;
const PERFORMANCE_RE = /\bdrag\s+show\b|\bcabaret\b|\bburlesque\b|\bperformances?\s+by\b|\bperformance\s+art\b/i;
const LISTENING_RE = /\blistening\s+(?:session|party|bar|room)\b|\bhi-?fi\b|\baudiophile\b/i;
const SOUNDSYSTEM_RE = /\bsound\s?system\b|\bsoundsystem\b|\bon\s+the\s+(?:klipsch|funktion|void)\b/i;
const DRESS_RE = /\bdress\s+code\b|\bdress\s+to\b|\bdress\s+up\b|\bno\s+(?:sneakers|athletic\s+wear)\b/i;
const SOBER_RE = /\bsober\b|\balcohol[- ]free\b|\bdry\s+party\b/i;
const ALL_AGES_RE = /\ball\s+ages\b/i;

// ---- main ------------------------------------------------------------------------------------------
export function applyRules(input: RuleInput): RuleOutput {
  const vibes = new Map<VibeCode, RuleVibe>();
  const add = (code: string, rule: string, evidence: string): void => {
    if (!isVibeCode(code) || vibes.has(code)) return;
    vibes.set(code, { code, rule, evidence });
  };
  const flags: string[] = [];
  const t = timing(input);
  const text = `${input.title}\n${input.description ?? ''}`;
  const lineupText = input.lineup.join(' | ');
  const artists = input.lineup.flatMap((item, i) => parseLineupItem(item, i));
  const distinctArtists = new Set(artists.map((a) => a.name.toLowerCase())).size;
  const scalars: RuleScalars = {};

  // -- time (startT / endT are on the night axis, see timing()) ------------------------------------
  if (t.startHour === null || t.startT === null) flags.push('no_time');
  else {
    scalars.start_lateness = startLateness(t.startHour);
    const local = `${t.startLocal}–${t.endLocal ?? '?'}`;
    const aftersStart = t.startT >= 26 && t.startT < 30; // 02:00–06:00
    if (t.endT !== null && t.durationH !== null) {
      scalars.end_lateness = endLateness(t.endT);
      if (t.startT <= 16 && t.endT <= 22) add('sunny_day_party', 'time.sunny_day_party', `${local} local`);
      if (t.startT <= 17 && t.endT >= 26) add('day_into_night', 'time.day_into_night', `${local} local`);
      if (aftersStart) add('afters_marathon', 'time.afters_start', `starts ${t.startLocal}`);
      else if (t.durationH >= 10 && t.endT >= 30) add('afters_marathon', 'time.afters_marathon', `${Math.round(t.durationH)}h ending ${t.endLocal}`);
      if (t.startT >= 19 && t.durationH >= 7 && t.endT >= 29) add('all_nighter', 'time.all_nighter', `${Math.round(t.durationH)}h, ${local}`);
      if (t.startT >= 18 && t.endT <= 25) add('early_finish', 'time.early_finish', `ends ${t.endLocal}`);
    } else if (aftersStart) add('afters_marathon', 'time.afters_start', `starts ${t.startLocal}`);
  }

  // -- format ---------------------------------------------------------------------------------------
  const allNightTitle = ALL_NIGHT_RE.test(input.title) || ALL_NIGHT_RE.test(lineupText);
  if (allNightTitle || (distinctArtists === 1 && (t.durationH ?? 0) >= 5)) {
    add('one_dj_all_night', 'format.one_dj_all_night', allNightTitle ? `billing says "${(ALL_NIGHT_RE.exec(input.title + ' ' + lineupText) ?? [''])[0]}"` : `single artist for ${Math.round(t.durationH ?? 0)}h`);
    add('long_sets', 'format.long_sets', 'one artist for the whole session');
  } else if (distinctArtists > 0 && (t.durationH ?? 0) >= 5 && (t.durationH ?? 0) / distinctArtists >= 3) {
    add('long_sets', 'format.long_sets', `${Math.round(t.durationH ?? 0)}h across ${distinctArtists} acts`);
  } else if (/\bextended\s+set\b|\ball\s+night\s+long\b/i.test(text)) add('long_sets', 'format.long_sets_text', 'description mentions extended sets');
  const b2bCount = (`${input.title} ${lineupText}`.match(B2B_RE) ?? []).length;
  if (b2bCount >= 2) add('b2b_heavy', 'format.b2b_heavy', `${b2bCount} b2b pairings`);
  if (artists.some((a) => a.isLive) || LIVE_TITLE_RE.test(input.title)) add('live_act', 'format.live_act', 'live / hybrid set on the bill');
  if (distinctArtists >= 7 || FESTIVAL_RE.test(input.title)) add('festival_scale_lineup', 'format.festival_scale', distinctArtists >= 7 ? `${distinctArtists} acts` : 'festival in title');
  if (LISTENING_RE.test(text)) add('listening_focus', 'format.listening_text', 'listening / hi-fi wording');
  if (SOUNDSYSTEM_RE.test(text)) add('sound_system_focus', 'format.sound_system_text', 'sound system wording');
  if (PERFORMANCE_RE.test(text)) add('performance_or_cabaret', 'format.performance_text', 'performance / drag / cabaret wording');

  // -- price ----------------------------------------------------------------------------------------
  const tier = priceTier(input.price_min, input.price_max);
  if (tier === undefined) flags.push('no_price');
  else scalars.price_tier = tier;
  const priceText = `${input.title}\n${input.description ?? ''}\n${input.price_note ?? ''}`;
  if (input.price_min === 0 && (input.price_max === null || input.price_max === 0)) add('free_rsvp', 'price.free', 'listed price is $0');
  else if (FREE_TITLE_RE.test(input.title) || FREE_DESC_RE.test(priceText)) add('free_rsvp', 'price.free_text', 'title / description says free or RSVP');
  if (CHEAP_EARLY_RE.test(priceText)) add('cheap_early', 'price.cheap_early', `"${(CHEAP_EARLY_RE.exec(priceText) ?? [''])[0].trim().slice(0, 60)}"`);
  if ((input.price_max ?? 0) > 60 || (input.price_min ?? 0) > 60) add('pricey', 'price.pricey', `top ticket $${input.price_max ?? input.price_min}`);

  // -- age ------------------------------------------------------------------------------------------
  if (input.age_min === 0 || ALL_AGES_RE.test(text)) add('all_ages', 'age.all_ages', 'all ages');
  else if (input.age_min === 18) add('18_plus', 'age.18_plus', '18+');
  else if ((input.age_min ?? 0) >= 21) add('21_plus', 'age.21_plus', `${input.age_min}+`);

  // -- venue ----------------------------------------------------------------------------------------
  const venue = input.venue;
  if (!venue) flags.push('no_venue');
  else {
    const st = new Set(venue.space_types);
    const cs = crowdSize(venue.capacity);
    if (cs !== undefined) scalars.crowd_size = cs;
    if (st.has('warehouse')) add('dark_warehouse', 'venue.space_type', `${venue.name} is a warehouse space`);
    if (st.has('basement')) add('sweaty_basement', 'venue.space_type', `${venue.name} is a basement`);
    // yards close early under NYC noise rules: an outdoor venue only earns the tag when the party starts in daylight
    if ((st.has('outdoor_yard') || venue.outdoor === true) && (t.startHour === null || t.startHour < 20)) add('outdoor_yard', 'venue.outdoor', `${venue.name} has an outdoor space`);
    if (st.has('rooftop')) add('rooftop', 'venue.space_type', `${venue.name} rooftop`);
    if (st.has('boat')) add('boat_party', 'venue.space_type', `${venue.name} is a boat`);
    if (st.has('art_space')) add('art_space', 'venue.space_type', `${venue.name} is an art space`);
    if (st.has('park') || st.has('pier')) add('park_or_pier', 'venue.space_type', `${venue.name} is a park / pier`);
    if (venue.kind === 'tba' || venue.kind === 'secret') add('pop_up_secret_location', 'venue.kind', `venue ${venue.kind}`);
    if ((venue.capacity ?? 0) >= 1000) add('big_room_club', 'venue.capacity', `capacity ${venue.capacity}`);
    else if (venue.capacity !== null && venue.capacity > 0 && venue.capacity < 200) add('intimate_room', 'venue.capacity', `capacity ${venue.capacity}`);
    if (venue.phone_policy === 'no_photos' || venue.phone_policy === 'pouch') add('phone_free', 'venue.phone_policy', `${venue.name}: ${venue.phone_policy}`);
    for (const code of venue.vibe_priors) add(code, 'venue_prior', `${venue.name} prior`);
  }
  if (PHONE_FREE_RE.test(text)) add('phone_free', 'policy.phone_free_text', 'no photos / phone-free wording');
  if (WAREHOUSE_RE.test(input.title)) add('dark_warehouse', 'title.warehouse', 'warehouse in title');
  if (BASEMENT_RE.test(input.title)) add('sweaty_basement', 'title.basement', 'basement in title');
  if (OUTDOOR_RE.test(text)) add('outdoor_yard', 'text.outdoor', 'outdoor / yard wording');
  if (ROOFTOP_RE.test(text)) add('rooftop', 'text.rooftop', 'rooftop wording');
  if (BOAT_RE.test(input.title)) add('boat_party', 'title.boat', 'boat / yacht in title');
  if (PIER_RE.test(text)) add('park_or_pier', 'text.pier', 'pier / park / beach wording');
  if (!venue || SECRET_RE.test(text)) add('pop_up_secret_location', venue ? 'text.secret' : 'venue.missing', venue ? 'secret / TBA wording' : 'no venue resolved');

  // -- promoter -------------------------------------------------------------------------------------
  for (const p of input.promoter_priors) for (const code of p.vibe_priors) add(code, 'promoter_prior', `${p.name} prior`);
  if (WEEKLY_RE.test(input.title)) add('weekly_residency', 'title.weekly', 'weekly in title');
  if (ONE_OFF_RE.test(input.title)) add('one_off_special', 'title.one_off', 'one-off wording in title');

  // -- crowd ----------------------------------------------------------------------------------------
  if (QUEER_RE.test(text)) add('queer_party', 'text.queer', 'queer / LGBTQ wording');
  if (LATINX_RE.test(text)) add('latinx_party', 'text.latinx', 'Latin wording');
  if (DIASPORA_RE.test(text)) add('black_diaspora_party', 'text.diaspora', 'diaspora sound named in text');
  if (DRESS_RE.test(text)) add('dress_code', 'policy.dress_text', 'dress code wording');
  if (SOBER_RE.test(text)) add('sober_friendly', 'policy.sober_text', 'sober / alcohol-free wording');
  const ugPromoter = input.promoter_priors.map((p) => p.underground_prior).filter((x): x is number => typeof x === 'number');
  const ug = ugPromoter.length ? ugPromoter.reduce((a, b) => a + b, 0) / ugPromoter.length : venue?.underground_prior ?? null;
  if (ug !== null) {
    scalars.underground_index = clamp(ug, 1, 5);
    if (ug >= 4) add('underground', 'prior.underground', `underground prior ${ug}`);
    else if (ug <= 2) add('mainstream_club', 'prior.mainstream', `underground prior ${ug}`);
  }
  if (input.sold_out === true) add('sold_out_risk', 'sales.sold_out', 'a source reports sold out / off sale');
  else if ((input.interested_count ?? 0) >= 1000) add('sold_out_risk', 'sales.interest', `${input.interested_count} interested`);

  // -- genre priors ---------------------------------------------------------------------------------
  const xw = crosswalk({ labelsBySource: input.source_genres ?? [], title: input.title, description: input.description });
  const genre_priors: GenrePrior[] = xw.hits.map((h) => ({ code: h.code, weight: h.weight, source: h.source, evidence: `${h.source}: ${h.label}${h.generic ? ' (generic)' : ''}` }));
  for (const code of venue?.typical_genres ?? []) genre_priors.push({ code: code as GenreCode, weight: 0.3, source: 'venue_prior', evidence: `${venue?.name} typically books this` });
  for (const p of input.promoter_priors) for (const code of p.genre_priors) genre_priors.push({ code: code as GenreCode, weight: 0.45, source: 'promoter_prior', evidence: `${p.name} series prior` });
  for (const hint of xw.vibe_hints) add(hint.code, `tag.${hint.source}`, `${hint.source} tag ${hint.label}`);
  if (xw.is_electronic === false) flags.push('source_says_not_electronic');

  // -- data quality ---------------------------------------------------------------------------------
  if (input.lineup.length === 0) flags.push('no_lineup');
  if (!input.description || input.description.trim().split(/\s+/).length < 12) flags.push('sparse_description');

  return {
    version: RULES_VERSION,
    vibes: [...vibes.values()],
    scalars,
    genre_priors,
    flags,
    crosswalk: xw,
    timing: { start_local: t.startLocal, end_local: t.endLocal, duration_h: t.durationH === null ? null : Math.round(t.durationH * 10) / 10, weekday: t.weekday },
  };
}
