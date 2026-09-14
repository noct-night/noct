/**
 * Crosswalk: source genre labels -> NOCT taxonomy codes. Pure functions, no I/O.
 *
 * Every source has its own vocabulary (RA's 70 names, DICE's `dj:tech-house` tags, Elsewhere's six coarse
 * genres, Ticketmaster subGenre names, Discogs styles) and promoters write genres in free text. All of them
 * funnel into one index keyed by a "squashed" label (lower-case, accents stripped, no spaces/punctuation) so
 * 'Tech House', 'tech-house', 'techhouse' and 'dj:tech house' are the same key.
 *
 * Output weights are priors, not truths: RA event tags are promoter-curated (0.8), DICE tags are broader (0.6),
 * Elsewhere / Ticketmaster are coarse (0.45), free text in a title (0.55) beats a description (0.35). Labels
 * that only name a family ("House") are multiplied down and flagged `generic`.
 */
import { stripAccents } from '../lib/normalize.js';
import {
  ELECTRONIC_GENERIC_LABELS, GENERIC_LABELS, GENRES, GENRE_BY_CODE, NON_ELECTRONIC_LABELS,
  type GenreCode, type GenreDef, type VibeCode,
} from './taxonomy.js';

export type CrosswalkSource = 'ra' | 'dice' | 'elsewhere' | 'ticketmaster' | 'discogs' | 'text:title' | 'text:description' | (string & {});

export interface CrosswalkHit {
  code: GenreCode;
  /** 0..1 prior strength for this single label */
  weight: number;
  source: CrosswalkSource;
  /** the label as the source wrote it */
  label: string;
  /** label only named a family; subgenre is a placeholder */
  generic: boolean;
  /** what the label says about "is this a club / electronic night": true, false, or null (says nothing) */
  electronic: boolean | null;
}

export interface CrosswalkResult {
  hits: CrosswalkHit[];
  /** codes ranked by combined weight (1 - prod(1 - w)), best first */
  ranked: { code: GenreCode; weight: number; sources: string[] }[];
  /** true when any label signals DJ/club music; false when only non-electronic labels exist; null when unknown */
  is_electronic: boolean | null;
  /** vibe hints carried by tags rather than genres (DICE 'lgbtq+' -> queer_party, 'edm' -> mainstream_club) */
  vibe_hints: { code: VibeCode; source: string; label: string }[];
  /** labels no table knows; surfaced to the LLM and to whoever maintains the taxonomy */
  unmapped: { source: string; label: string }[];
}

export const SOURCE_WEIGHTS: Record<string, number> = {
  ra: 0.8, dice: 0.6, elsewhere: 0.45, ticketmaster: 0.45, discogs: 0.5, 'text:title': 0.55, 'text:description': 0.35,
};
const GENERIC_MULTIPLIER = 0.4;

/** 'Tech House' / 'tech-house' / 'dj:tech_house' -> 'techhouse' */
export function squash(label: string): string {
  return stripAccents(label).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ---- label indexes ----------------------------------------------------------------------------------
type LabelIndex = ReadonlyMap<string, GenreCode>;
function buildIndex(pick: (def: GenreDef) => readonly string[]): LabelIndex {
  const idx = new Map<string, GenreCode>();
  for (const def of GENRES) for (const n of pick(def)) {
    const key = squash(n);
    if (key && !idx.has(key)) idx.set(key, def.code);
  }
  return idx;
}
/**
 * One index per source vocabulary, because the same squashed key can legitimately mean different things per
 * source: RA "Afrobeat" is the Fela-style genre while DICE's bare "afrobeat" party tag means afrobeats.
 * Each source consults its own index first and falls back to the general one.
 */
const RA_INDEX = buildIndex((d) => d.ra_names);
const DICE_INDEX = buildIndex((d) => d.dice_tags);
const DISCOGS_INDEX = buildIndex((d) => d.discogs_styles);
/** Shared fallback: curated source names (RA first) beat free-text aliases and labels; first claim wins. */
const GENERAL_INDEX: LabelIndex = (() => {
  const idx = new Map<string, GenreCode>();
  const passes: Array<(d: GenreDef) => readonly string[]> = [(d) => d.ra_names, (d) => d.dice_tags, (d) => d.discogs_styles, (d) => d.aliases, (d) => [d.label]];
  for (const pass of passes) for (const [key, code] of buildIndex(pass)) if (!idx.has(key)) idx.set(key, code);
  return idx;
})();

function lookupKey(key: string, own?: LabelIndex): GenreCode | null {
  return own?.get(key) ?? GENERAL_INDEX.get(key) ?? null;
}

/** Exact-label lookup shared by every source. Returns null for unknown labels. */
export function lookupLabel(label: string): GenreCode | null {
  return lookupKey(squash(label));
}

function electronicHint(code: GenreCode | null, key: string): boolean | null {
  if (NON_ELECTRONIC_LABELS.has(key)) return false;
  if (ELECTRONIC_GENERIC_LABELS.has(key)) return true;
  if (!code) return null;
  const def = GENRE_BY_CODE.get(code) as GenreDef;
  // hip-hop family is real nightlife but not "electronic"; the LLM decides routing with the wider context
  if (def.family === 'hiphop') return false;
  return true;
}

/** `key` is the squashed genre word itself ('house' for DICE's 'dj:house'); `label` stays as the source wrote it. */
function makeHit(source: CrosswalkSource, label: string, key: string, code: GenreCode, baseWeight: number): CrosswalkHit {
  const generic = GENERIC_LABELS.has(key);
  return {
    code, source, label, generic,
    weight: round2(generic ? baseWeight * GENERIC_MULTIPLIER : baseWeight),
    electronic: electronicHint(code, key),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- per-source mappers -----------------------------------------------------------------------------
export function mapRaGenre(name: string): CrosswalkHit | null {
  const key = squash(name);
  const code = lookupKey(key, RA_INDEX);
  return code ? makeHit('ra', name, key, code, SOURCE_WEIGHTS.ra as number) : null;
}

const DICE_NON_MUSIC_PREFIXES = new Set(['comedy', 'film', 'theatre', 'talks', 'workshop', 'social', 'sport', 'culture']);
/** gig:hardcore is hardcore punk, gig:house would be a live band called House — the `gig` prefix flips these. */
const DICE_GIG_NON_ELECTRONIC = new Set(['hardcore', 'house', 'garage', 'trance', 'punk', 'metal', 'psychedelica', 'goth', 'experimental']);
const DICE_VIBE_HINTS: Record<string, VibeCode> = { lgbtq: 'queer_party', lgbtqplus: 'queer_party', queer: 'queer_party', edm: 'mainstream_club', dragshow: 'performance_or_cabaret' };

export interface DiceTagResult { hit: CrosswalkHit | null; electronic: boolean | null; vibe: VibeCode | null; live: boolean }

/** Accepts 'dj:tech-house', 'party:afro_house', 'gig:indierock' or a bare suffix 'melodictechno'. */
export function mapDiceTag(tag: string): DiceTagResult {
  const idx = tag.indexOf(':');
  const prefix = idx >= 0 ? tag.slice(0, idx).toLowerCase() : null;
  const suffix = idx >= 0 ? tag.slice(idx + 1) : tag;
  const key = squash(suffix);
  const vibe = DICE_VIBE_HINTS[key] ?? (key.startsWith('lgbtq') ? 'queer_party' : null);
  if (prefix && DICE_NON_MUSIC_PREFIXES.has(prefix)) return { hit: null, electronic: false, vibe, live: false };
  const live = prefix === 'gig';
  if (live && DICE_GIG_NON_ELECTRONIC.has(key)) return { hit: null, electronic: false, vibe, live };
  // 'gig:electronic' is a live electronic act (Elsewhere's "Live Electronic"), not a DJ night with no genre
  const code = live && ELECTRONIC_GENERIC_LABELS.has(key) ? 'live.indie_electronic' : lookupKey(key, DICE_INDEX);
  if (vibe && !code) return { hit: null, electronic: key === 'edm' ? true : null, vibe, live };
  if (!code) return { hit: null, electronic: electronicHint(null, key), vibe, live };
  const hit = makeHit('dice', tag, key, code, SOURCE_WEIGHTS.dice as number);
  // a live electronic gig is electronic but not a DJ night; keep the hint neutral so the LLM weighs the lineup
  if (live && hit.electronic === true) hit.electronic = null;
  return { hit, electronic: hit.electronic, vibe, live };
}

const ELSEWHERE: Record<string, { code: GenreCode | null; electronic: boolean | null; live?: boolean }> = {
  electronic: { code: null, electronic: true },
  liveelectronic: { code: 'live.indie_electronic', electronic: true, live: true },
  indie: { code: null, electronic: false },
  rock: { code: null, electronic: false },
  pop: { code: null, electronic: false },
  hiphoprb: { code: 'hiphop.rap', electronic: false },
};
export function mapElsewhereGenre(name: string): { hit: CrosswalkHit | null; electronic: boolean | null; live: boolean } {
  const key = squash(name);
  const e = ELSEWHERE[key];
  if (e) {
    const hit = e.code ? { ...makeHit('elsewhere', name, key, e.code, SOURCE_WEIGHTS.elsewhere as number), electronic: e.electronic } : null;
    return { hit, electronic: e.electronic, live: e.live ?? false };
  }
  const code = lookupKey(key);
  return { hit: code ? makeHit('elsewhere', name, key, code, SOURCE_WEIGHTS.elsewhere as number) : null, electronic: electronicHint(code, key), live: false };
}

/** Ticketmaster Discovery subGenre / genre names ('House', 'Techno', 'Dance/Electronic', 'Hip-Hop/Rap', 'Reggae', ...). */
const TM_OVERRIDES: Record<string, GenreCode | null> = {
  danceelectronic: null, clubdance: null, electronic: null, dance: null,
  hiphoprap: 'hiphop.rap', reggae: 'carib.reggae_dub', latin: 'latin.reggaeton', world: 'jazz.balearic_global', rbsoul: 'hiphop.rnb',
};
export function mapTicketmasterSubGenre(name: string): { hit: CrosswalkHit | null; electronic: boolean | null } {
  const key = squash(name);
  const code = key in TM_OVERRIDES ? TM_OVERRIDES[key] ?? null : lookupKey(key);
  const electronic = key in TM_OVERRIDES && TM_OVERRIDES[key] === null ? true : electronicHint(code, key);
  return { hit: code ? makeHit('ticketmaster', name, key, code, SOURCE_WEIGHTS.ticketmaster as number) : null, electronic };
}

export function mapDiscogsStyle(style: string): CrosswalkHit | null {
  const key = squash(style);
  const code = lookupKey(key, DISCOGS_INDEX);
  return code ? makeHit('discogs', style, key, code, SOURCE_WEIGHTS.discogs as number) : null;
}

// ---- free text --------------------------------------------------------------------------------------
interface TextPattern { code: GenreCode; alias: string; re: RegExp }
/** Longest aliases first so "dub techno" is consumed before "techno"; matched spans are blanked out. */
const TEXT_PATTERNS: TextPattern[] = GENRES.flatMap((def) => def.aliases.map((alias) => ({ code: def.code, alias, re: aliasRegex(alias) })))
  .sort((a, b) => b.alias.length - a.alias.length);

function aliasRegex(alias: string): RegExp {
  const body = stripAccents(alias).toLowerCase().split(/[\s\-]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[\\s\\-]?');
  return new RegExp(`(?<![a-z0-9&])${body}(?![a-z0-9])`, 'g');
}

export interface TextHit extends CrosswalkHit { alias: string }

/** Word-boundary alias matching over a title or description. Returns at most one hit per code. */
export function matchText(text: string | null | undefined, source: 'text:title' | 'text:description'): TextHit[] {
  if (!text) return [];
  let hay = stripAccents(text).toLowerCase().replace(/\s+/g, ' ');
  const seen = new Set<GenreCode>();
  const out: TextHit[] = [];
  for (const p of TEXT_PATTERNS) {
    p.re.lastIndex = 0;
    if (!p.re.test(hay)) continue;
    hay = hay.replace(p.re, (m) => ' '.repeat(m.length));
    if (seen.has(p.code)) continue;
    seen.add(p.code);
    out.push({ ...makeHit(source, p.alias, squash(p.alias), p.code, SOURCE_WEIGHTS[source] as number), alias: p.alias });
  }
  return out;
}

// ---- aggregate --------------------------------------------------------------------------------------
export interface CrosswalkInput {
  /** per-source raw labels, e.g. [{source:'ra', labels:['House','Afro House']}, {source:'dice', labels:['dj:techno']}] */
  labelsBySource: { source: string; labels: string[] }[];
  title?: string | null;
  description?: string | null;
}

export function mapSourceLabel(source: string, label: string): { hit: CrosswalkHit | null; electronic: boolean | null; vibe: VibeCode | null } {
  switch (source) {
    case 'ra': { const hit = mapRaGenre(label); return { hit, electronic: hit ? hit.electronic : electronicHint(null, squash(label)), vibe: null }; }
    case 'dice': { const r = mapDiceTag(label); return { hit: r.hit, electronic: r.electronic, vibe: r.vibe }; }
    case 'elsewhere': { const r = mapElsewhereGenre(label); return { hit: r.hit, electronic: r.electronic, vibe: null }; }
    case 'ticketmaster': { const r = mapTicketmasterSubGenre(label); return { hit: r.hit, electronic: r.electronic, vibe: null }; }
    case 'discogs': { const hit = mapDiscogsStyle(label); return { hit, electronic: hit?.electronic ?? null, vibe: null }; }
    default: {
      // venue feeds (goodroom, publicrecords, edmtrain) rarely carry genres; treat anything they send as a plain label
      const key = squash(label);
      const code = lookupKey(key);
      const hit = code ? makeHit(source, label, key, code, SOURCE_WEIGHTS.elsewhere as number) : null;
      return { hit, electronic: electronicHint(code, key), vibe: null };
    }
  }
}

export function crosswalk(input: CrosswalkInput): CrosswalkResult {
  const hits: CrosswalkHit[] = [];
  const vibe_hints: CrosswalkResult['vibe_hints'] = [];
  const unmapped: CrosswalkResult['unmapped'] = [];
  const electronicVotes: (boolean | null)[] = [];
  for (const { source, labels } of input.labelsBySource) {
    for (const label of labels) {
      if (!label || !label.trim()) continue;
      const r = mapSourceLabel(source, label);
      if (r.hit) hits.push(r.hit);
      else if (r.electronic === null && !r.vibe) unmapped.push({ source, label });
      if (r.vibe) vibe_hints.push({ code: r.vibe, source, label });
      electronicVotes.push(r.electronic);
    }
  }
  const titleHits = matchText(input.title, 'text:title');
  const descHits = matchText(input.description, 'text:description');
  hits.push(...titleHits, ...descHits);
  // free text only ever votes "electronic", never "not electronic" (a rock gig can mention "disco night" in passing)
  for (const h of [...titleHits, ...descHits]) if (h.electronic) electronicVotes.push(true);

  const combined = new Map<GenreCode, { miss: number; sources: Set<string> }>();
  for (const h of hits) {
    const c = combined.get(h.code) ?? { miss: 1, sources: new Set<string>() };
    c.miss *= 1 - h.weight;
    c.sources.add(`${h.source}:${h.label}`);
    combined.set(h.code, c);
  }
  const ranked = [...combined.entries()]
    .map(([code, c]) => ({ code, weight: round2(1 - c.miss), sources: [...c.sources] }))
    .sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));

  const is_electronic = electronicVotes.some((x) => x === true) ? true : electronicVotes.some((x) => x === false) ? false : null;
  return { hits, ranked, is_electronic, vibe_hints, unmapped };
}
