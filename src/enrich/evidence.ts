/**
 * Stage S3: candidate selection + evidence bundle.
 *
 * One SQL statement pulls every event that may need (re)classification together with its venue priors,
 * matched promoter priors, per-source raw genre labels, sold-out / price notes from live listings, artist
 * genre profiles (when the artist cron has filled them) and any human / community tags. TS then computes the
 * stable input hash and renders a compact text bundle (<= ~500 tokens) for the classifier.
 */
import { createHash } from 'node:crypto';
import { cleanText } from '../lib/normalize.js';
import { toLocalParts } from '../lib/time.js';
import { type RuleInput, type RuleOutput } from './rules.js';

export interface CandidateRow {
  city?: string;
  tz?: string;
  event_id: string;
  title: string;
  night: string;
  starts_at: string | null;
  ends_at: string | null;
  has_time: boolean;
  status: string;
  age_min: number | null;
  genres: string[];
  lineup: string[];
  description: string | null;
  interested_count: number | null;
  source_tags: Record<string, unknown>;
  input_hash: string | null;
  classification_version: string | null;
  venue_id: string | null;
  venue: {
    name: string; kind: string; neighborhood: string | null; borough: string | null; capacity: number | null;
    space_types: string[]; outdoor: boolean | null; phone_policy: 'none' | 'no_photos' | 'pouch' | null;
    typical_genres: string[]; vibe_priors: string[]; underground_prior: number | null; notes: string | null;
  } | null;
  promoters: { promoter_id: string; name: string; genre_priors: string[]; vibe_priors: string[]; underground_prior: number | null; notes: string | null }[];
  listing_promoters: string[];
  source_genres: { source: string; labels: string[] }[];
  price_min: number | null;
  price_max: number | null;
  price_note: string | null;
  sold_out: boolean | null;
  artist_profiles: { name: string; source: string; status: string; release_count: number | null; taxonomy: Record<string, number> | null; styles: Record<string, number> | null }[];
  human_tags: { kind: 'genre' | 'vibe'; code: string; status: string; confidence: number }[];
}

/**
 * $1 = force (bool), $2 = version prefix ('rules-v1/p1/'), $3 = event ids (uuid[] or null), $4 = limit.
 * Ordered so never-classified events come first; stale ones (updated since classification or produced by an
 * older rules/prompt version) follow. The TS side still compares input_hash and skips unchanged events.
 */
export const CANDIDATE_SQL = `
with cand as (
  select e.*
  from event e
  where e.merged_into is null
    and e.status <> 'removed'
    and ($3::uuid[] is not null or e.night >= current_date - 1)
    and ($3::uuid[] is null or e.event_id = any($3::uuid[]))
    and ($1::boolean or $3::uuid[] is not null or e.classified_at is null or e.updated_at > e.classified_at
         or e.classification_version is null or e.classification_version not like $2::text || '%')
  order by (e.classified_at is null) desc, e.night asc, e.event_id
  limit $4::int
),
live as (
  select l.* from listing l where l.gone_at is null and l.event_id in (select event_id from cand)
),
promo_names as (
  select c.event_id, array_agg(distinct p) as names
  from cand c join live l on l.event_id = c.event_id, unnest(l.promoters) p
  group by c.event_id
),
promo as (
  select c.event_id, jsonb_agg(distinct jsonb_build_object(
           'promoter_id', pr.promoter_id, 'name', pr.name, 'genre_priors', to_jsonb(pr.genre_priors), 'vibe_priors', to_jsonb(pr.vibe_priors),
           'underground_prior', pr.underground_prior, 'notes', pr.notes)) as promoters
  from cand c
  left join promo_names pn on pn.event_id = c.event_id
  join promoter pr on (
       pr.name_norm = any (select norm_text(x) from unnest(coalesce(pn.names, '{}'::text[])) x)
    or exists (select 1 from unnest(pr.aliases) a where norm_text(a) = any (select norm_text(x) from unnest(coalesce(pn.names, '{}'::text[])) x))
    or (length(pr.name_norm) >= 5 and position(pr.name_norm in c.title_norm) > 0)
    or exists (select 1 from unnest(pr.aliases) a where length(norm_text(a)) >= 5 and position(norm_text(a) in c.title_norm) > 0)
  )
  group by c.event_id
),
src_genres as (
  select event_id, jsonb_agg(jsonb_build_object('source', source_key, 'labels', to_jsonb(genres)) order by source_key) as source_genres
  from (select l.event_id, l.source_key, array_agg(distinct g order by g) as genres from live l, unnest(l.genres) g group by l.event_id, l.source_key) s
  group by event_id
),
sales as (
  select l.event_id, min(l.price_min) as price_min, max(l.price_max) as price_max, bool_or(l.sold_out) as sold_out,
         (array_remove(array_agg(l.price_note order by l.source_key), null))[1] as price_note,
         array_remove(array_agg(distinct p), null) as listing_promoters
  from live l left join lateral unnest(l.promoters) p on true
  group by l.event_id
),
profiles as (
  select ea.event_id, jsonb_agg(jsonb_build_object('name', a.name, 'source', ap.source, 'status', ap.status, 'release_count', ap.release_count,
                                                   'taxonomy', ap.taxonomy, 'styles', ap.styles) order by ea.position) as artist_profiles
  from event_artist ea
  join artist a on a.artist_id = ea.artist_id
  join lateral (
    select * from artist_genre_profile p where p.artist_id = a.artist_id and (p.expires_at is null or p.expires_at > now())
    order by p.fetched_at desc limit 1
  ) ap on true
  where ea.event_id in (select event_id from cand)
  group by ea.event_id
),
human as (
  select event_id, jsonb_agg(jsonb_build_object('kind', kind, 'code', code, 'status', status, 'confidence', confidence)) as human_tags
  from event_tag where status in ('confirmed', 'community', 'rejected') and event_id in (select event_id from cand)
  group by event_id
)
select c.event_id, c.title, c.night::text as night, c.starts_at, c.ends_at, c.has_time, c.status, c.age_min, c.genres, c.lineup,
       c.description, c.interested_count, c.source_tags, c.input_hash, c.classification_version, c.venue_id,
       case when v.venue_id is null then null else jsonb_build_object(
         'name', v.name, 'kind', v.kind, 'neighborhood', v.neighborhood, 'borough', v.borough, 'capacity', v.capacity,
         'space_types', to_jsonb(v.space_types), 'outdoor', v.outdoor, 'phone_policy', v.phone_policy,
         'typical_genres', to_jsonb(v.typical_genres), 'vibe_priors', to_jsonb(v.vibe_priors), 'underground_prior', v.underground_prior, 'notes', v.notes) end as venue,
       coalesce(p.promoters, '[]'::jsonb) as promoters,
       coalesce(s.listing_promoters, '{}'::text[]) as listing_promoters,
       coalesce(sg.source_genres, '[]'::jsonb) as source_genres,
       s.price_min, s.price_max, s.price_note, s.sold_out,
       coalesce(pf.artist_profiles, '[]'::jsonb) as artist_profiles,
       coalesce(h.human_tags, '[]'::jsonb) as human_tags
from cand c
left join venue v on v.venue_id = c.venue_id
left join promo p on p.event_id = c.event_id
left join src_genres sg on sg.event_id = c.event_id
left join sales s on s.event_id = c.event_id
left join profiles pf on pf.event_id = c.event_id
left join human h on h.event_id = c.event_id
order by (c.classified_at is null) desc, c.night asc, c.event_id`;

/** pg returns timestamptz as Date and numerics as strings; normalise to the CandidateRow contract. */
export function normalizeCandidate(raw: Record<string, unknown>): CandidateRow {
  const iso = (x: unknown): string | null => (x instanceof Date ? x.toISOString() : typeof x === 'string' ? new Date(x).toISOString() : null);
  const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
  return {
    ...(raw as unknown as CandidateRow),
    starts_at: iso(raw.starts_at),
    ends_at: iso(raw.ends_at),
    price_min: num(raw.price_min),
    price_max: num(raw.price_max),
    age_min: num(raw.age_min),
    interested_count: num(raw.interested_count),
    sold_out: raw.sold_out === null || raw.sold_out === undefined ? null : Boolean(raw.sold_out),
    human_tags: ((raw.human_tags as CandidateRow['human_tags']) ?? []).map((t) => ({ ...t, confidence: Number(t.confidence) })),
  };
}

/** Stable inputs only — counters like interested_count and volatile listing fields are excluded on purpose. */
export function computeInputHash(c: CandidateRow): string {
  const stable = {
    title: c.title,
    night: c.night,
    starts_at: c.starts_at,
    ends_at: c.ends_at,
    has_time: c.has_time,
    lineup: c.lineup,
    description: c.description,
    venue_id: c.venue_id,
    venue_priors: c.venue ? { space_types: c.venue.space_types, outdoor: c.venue.outdoor, phone_policy: c.venue.phone_policy, typical_genres: c.venue.typical_genres, vibe_priors: c.venue.vibe_priors, underground_prior: c.venue.underground_prior, capacity: c.venue.capacity } : null,
    promoters: c.promoters.map((p) => ({ id: p.promoter_id, g: p.genre_priors, v: p.vibe_priors, u: p.underground_prior })),
    price_min: c.price_min,
    price_max: c.price_max,
    age_min: c.age_min,
    sold_out: c.sold_out,
    source_genres: c.source_genres,
    artist_profiles: c.artist_profiles.map((p) => ({ n: p.name, t: p.taxonomy, s: p.status })),
    human_tags: c.human_tags.map((t) => `${t.kind}:${t.code}:${t.status}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function toRuleInput(c: CandidateRow): RuleInput {
  return {
    title: c.title,
    lineup: c.lineup,
    starts_at: c.starts_at,
    ends_at: c.ends_at,
    has_time: c.has_time,
    night: c.night,
    tz: c.tz ?? 'America/New_York',
    price_min: c.price_min,
    price_max: c.price_max,
    price_note: c.price_note,
    age_min: c.age_min,
    description: c.description,
    sold_out: c.sold_out,
    interested_count: c.interested_count,
    venue: c.venue ? { ...c.venue } : null,
    promoter_priors: c.promoters.map((p) => ({ name: p.name, genre_priors: p.genre_priors, vibe_priors: p.vibe_priors, underground_prior: p.underground_prior })),
    source_tags: c.source_tags ?? {},
    source_genres: c.source_genres,
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Trim a description to `max` words, stripping HTML and collapsing whitespace. */
export function trimWords(text: string | null | undefined, max = 250): string {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(' ') : `${words.slice(0, max).join(' ')} …`;
}

function money(n: number | null): string {
  return n === null ? '?' : n === 0 ? 'free' : `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** Compact, line-oriented evidence text for the classifier. Every line is a named evidence source it can cite. */
export function buildEvidenceBundle(c: CandidateRow, rules: RuleOutput): string {
  const lines: string[] = [];
  const nightDate = new Date(`${c.night}T12:00:00Z`);
  const weekday = WEEKDAYS[nightDate.getUTCDay()] ?? '';
  lines.push(`title: ${c.title}`);
  const startLocal = c.starts_at && c.has_time ? toLocalParts(new Date(c.starts_at), c.tz ?? 'America/New_York').time : null;
  const when = c.has_time && startLocal
    ? `${startLocal}–${rules.timing.end_local ?? '?'} local${rules.timing.duration_h ? ` (${rules.timing.duration_h}h)` : ''}`
    : 'time unknown';
  lines.push(`night: ${c.night} (${weekday}) · ${when} · status ${c.status}${c.city && c.city !== 'nyc' ? ` · city ${c.city}` : ''}`);
  if (c.venue) {
    const v = c.venue;
    const bits = [
      [v.neighborhood, v.borough].filter(Boolean).join(', '),
      v.kind !== 'venue' ? `kind ${v.kind}` : '',
      v.space_types.length ? `space ${v.space_types.join('/')}` : '',
      v.outdoor === true ? 'has outdoors' : '',
      v.capacity ? `capacity ${v.capacity}` : '',
      v.phone_policy && v.phone_policy !== 'none' ? `phones: ${v.phone_policy}` : '',
      v.typical_genres.length ? `typical ${v.typical_genres.join(', ')}` : '',
      v.vibe_priors.length ? `vibe priors ${v.vibe_priors.join(', ')}` : '',
      v.underground_prior ? `underground prior ${v.underground_prior}/5` : '',
      v.notes ? `note: ${trimWords(v.notes, 30)}` : '',
    ].filter(Boolean);
    lines.push(`venue: ${v.name}${bits.length ? ' · ' + bits.join(' · ') : ''}`);
  } else lines.push('venue: unresolved / TBA');
  if (c.promoters.length) {
    for (const p of c.promoters) {
      const bits = [p.genre_priors.length ? `genres ${p.genre_priors.join(', ')}` : '', p.vibe_priors.length ? `vibes ${p.vibe_priors.join(', ')}` : '', p.underground_prior ? `underground ${p.underground_prior}/5` : '', p.notes ? trimWords(p.notes, 25) : ''].filter(Boolean);
      lines.push(`promoter prior: ${p.name}${bits.length ? ' — ' + bits.join('; ') : ''}`);
    }
  } else if (c.listing_promoters.length) lines.push(`promoters (no prior on file): ${c.listing_promoters.slice(0, 4).join(', ')}`);
  lines.push(c.lineup.length ? `lineup: ${c.lineup.slice(0, 12).join(' | ')}${c.lineup.length > 12 ? ` | +${c.lineup.length - 12} more` : ''}` : 'lineup: none listed');
  const priceBits = [`price ${money(c.price_min)}${c.price_max !== null && c.price_max !== c.price_min ? `–${money(c.price_max)}` : ''}`];
  if (c.price_note) priceBits.push(`note "${trimWords(c.price_note, 20)}"`);
  priceBits.push(c.age_min === null ? 'age ?' : c.age_min === 0 ? 'all ages' : `${c.age_min}+`);
  if (c.sold_out) priceBits.push('SOLD OUT / off sale');
  if (c.interested_count) priceBits.push(`${c.interested_count} interested`);
  lines.push(priceBits.join(' · '));
  lines.push(c.source_genres.length
    ? `source genres: ${c.source_genres.map((s) => `${s.source}: ${s.labels.join(', ')}`).join(' | ')}`
    : `source genres: none (sources: ${Object.keys(c.source_tags ?? {}).join(', ') || 'unknown'})`);
  const xw = rules.crosswalk;
  if (xw.ranked.length) lines.push(`crosswalk candidates: ${xw.ranked.slice(0, 6).map((r) => `${r.code} ${r.weight} (${r.sources.slice(0, 2).join('; ')})`).join(' · ')}`);
  if (xw.unmapped.length) lines.push(`unmapped labels: ${xw.unmapped.map((u) => `${u.source}:${u.label}`).slice(0, 6).join(', ')}`);
  if (c.artist_profiles.length) {
    lines.push(`artist profiles: ${c.artist_profiles.slice(0, 6).map((p) => {
      if (p.status !== 'ok' || !p.taxonomy) return `${p.name}: ${p.status}`;
      const top = Object.entries(p.taxonomy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ');
      return `${p.name} (${p.source}, ${p.release_count ?? '?'} rel): ${top}`;
    }).join(' | ')}`);
  } else lines.push('artist profiles: none fetched');
  const s = rules.scalars;
  lines.push(`rules: vibes ${rules.vibes.length ? rules.vibes.map((v) => `${v.code}[${v.rule}]`).join(', ') : 'none'} · scalars ${Object.entries(s).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}${rules.flags.length ? ` · flags ${rules.flags.join(', ')}` : ''}`);
  const priorGenres = rules.genre_priors.filter((p) => p.source === 'venue_prior' || p.source === 'promoter_prior');
  if (priorGenres.length) lines.push(`prior genres: ${priorGenres.map((p) => `${p.code} (${p.source})`).join(', ')}`);
  if (c.human_tags.length) {
    const keep = c.human_tags.filter((t) => t.status !== 'rejected');
    const rej = c.human_tags.filter((t) => t.status === 'rejected');
    if (keep.length) lines.push(`human-verified tags (keep): ${keep.map((t) => `${t.kind}:${t.code} (${t.status})`).join(', ')}`);
    if (rej.length) lines.push(`rejected by humans (do not re-assign): ${rej.map((t) => `${t.kind}:${t.code}`).join(', ')}`);
  }
  lines.push(`description: ${c.description ? trimWords(c.description, 250) : '(none)'}`);
  return lines.join('\n');
}
