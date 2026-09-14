/**
 * Stage S4: Claude reconciles the evidence bundle into genres / vibes / scalars with structured outputs.
 *
 * Design points:
 *  - The system prompt (taxonomy, vibe definitions, rubrics, NYC glossary) is frozen text cached for 1h;
 *    only the per-event bundle varies, so cache reads cover ~80% of input tokens.
 *  - Structured outputs cannot express numeric min/max, so scalars and confidence are string enums parsed
 *    back to numbers here.
 *  - The client is injectable (anything with `messages.parse`) so unit tests use a fake and never touch the API.
 *  - Model comes from NOCT_ENRICH_MODEL (default claude-opus-5). We never silently downgrade.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from '../lib/env.js';
import type { Logger } from '../lib/log.js';
import { GENRES, GENRE_CODES, VIBES, VIBE_CODES, VIBE_KINDS, type GenreCode, type VibeCode } from './taxonomy.js';

export const PROMPT_VERSION = 'p1';
export const DEFAULT_MODEL = 'claude-opus-5';

// ---- output schema --------------------------------------------------------------------------------
const CONFIDENCE_BINS = ['0.2', '0.35', '0.5', '0.65', '0.8', '0.9'] as const;
const FIVE = ['1', '2', '3', '4', '5'] as const;
const PRICE = ['0', '1', '2', '3', '4'] as const;
export const FLAGS = ['needs_review', 'not_electronic', 'ambiguous_artist', 'conflicting_sources', 'sparse_input'] as const;
export type ClassifierFlag = (typeof FLAGS)[number];

export const OutputSchema = z.object({
  genres: z.array(z.object({
    code: z.enum(GENRE_CODES as [string, ...string[]]),
    confidence: z.enum(CONFIDENCE_BINS),
    why: z.string(),
  })).min(1).max(3),
  vibes: z.array(z.object({
    code: z.enum(VIBE_CODES as [string, ...string[]]),
    why: z.string(),
  })).max(6),
  scalars: z.object({
    energy: z.enum(FIVE),
    darkness: z.enum(FIVE),
    crowd_size: z.enum(FIVE),
    start_lateness: z.enum(FIVE),
    end_lateness: z.enum(FIVE),
    underground_index: z.enum(FIVE),
    price_tier: z.enum(PRICE),
  }),
  sound_summary: z.string(),
  is_electronic: z.boolean(),
  flags: z.array(z.enum(FLAGS)),
});
export type RawClassifierOutput = z.infer<typeof OutputSchema>;

export interface ClassifierOutput {
  genres: { code: GenreCode; confidence: number; why: string }[];
  vibes: { code: VibeCode; why: string }[];
  scalars: { energy: number; darkness: number; crowd_size: number; start_lateness: number; end_lateness: number; underground_index: number; price_tier: number };
  sound_summary: string;
  is_electronic: boolean;
  flags: ClassifierFlag[];
}

export function toClassifierOutput(raw: RawClassifierOutput): ClassifierOutput {
  return {
    genres: raw.genres.map((x) => ({ code: x.code, confidence: Number(x.confidence), why: x.why })),
    vibes: raw.vibes.map((x) => ({ code: x.code, why: x.why })),
    scalars: {
      energy: Number(raw.scalars.energy), darkness: Number(raw.scalars.darkness), crowd_size: Number(raw.scalars.crowd_size),
      start_lateness: Number(raw.scalars.start_lateness), end_lateness: Number(raw.scalars.end_lateness),
      underground_index: Number(raw.scalars.underground_index), price_tier: Number(raw.scalars.price_tier),
    },
    sound_summary: raw.sound_summary.trim(),
    is_electronic: raw.is_electronic,
    flags: [...new Set(raw.flags)],
  };
}

// ---- pricing ($ per MTok; cache write shown for the 5-minute and 1-hour TTLs) -----------------------
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** breakdown of cache_creation_input_tokens by TTL when the API reports it */
  cache_creation_1h_tokens?: number;
  cache_creation_5m_tokens?: number;
}

/** Unknown models cost 0 rather than a guess — the run record still stores tokens so it can be re-priced. */
export function estimateCostUsd(model: string, u: TokenUsage): number {
  const p = MODEL_PRICES[model];
  if (!p) return 0;
  const oneH = u.cache_creation_1h_tokens ?? (u.cache_creation_5m_tokens === undefined ? u.cache_creation_input_tokens : 0);
  const fiveM = u.cache_creation_5m_tokens ?? 0;
  const usd = (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.cacheRead + oneH * p.cacheWrite1h + fiveM * p.cacheWrite5m) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// ---- system prompt --------------------------------------------------------------------------------
const NYC_GLOSSARY = `NYC venue glossary (priors, not proof):
- Nowadays (Ridgewood): ~600 cap main room + large outdoor yard; Sunday day parties in the yard, all-night sessions indoors; sound-system focus; no-photo policy on the floor.
- Knockdown Center (Maspeth): ~3,000 cap former factory; Ruins = outdoor area; big warehouse bookings, day-into-night parties.
- Basement (Ridgewood, inside Knockdown): dark techno room, phone-camera stickers, 21+, late finishes.
- Bossa Nova Civic Club (Bushwick): small, sweaty, fog-heavy techno/house bar-club, cheap, local crews.
- Public Records (Gowanus): Sound Room = audiophile system, listening bar upstairs, house/disco/leftfield; Nursery = bigger room.
- Good Room (Greenpoint): mid-size house/disco/techno club, Bad Room second room.
- Elsewhere (Bushwick): The Hall (~700), Zone One (~200), Rooftop (summer), Loft; mixed club nights and live gigs.
- Paragon (Bushwick): underground techno/house, phone-free stickers.
- Mood Ring, H0L0, Market Hotel, The Sultan Room, Jupiter Disco, Rash, Mansions: small Bushwick/Ridgewood rooms; Jupiter Disco is a bar name, not a genre.
- Avant Gardner / Brooklyn Mirage (East Williamsburg): 6,000 cap open-air Mirage + Great Hall + Kings Hall; big-room / melodic / EDM-scale production, pricey.
- Brooklyn Army Terminal, Under the K Bridge Park, The Lot Radio (yard): large outdoor / day formats.
- Mister Saturday Night / Mister Sunday: Eamon Harkin & Justin Carter's house-and-disco community party, all-day residents, Nowadays yard.
- Teksupport: large warehouse techno/house productions with touring headliners.`;

function genreCatalogue(): string {
  const byFamily = new Map<string, string[]>();
  for (const gd of GENRES) {
    const list = byFamily.get(gd.family) ?? [];
    list.push(`  - ${gd.code} — ${gd.label}: ${gd.description}`);
    byFamily.set(gd.family, list);
  }
  return [...byFamily.entries()].map(([fam, rows]) => `${fam}:\n${rows.join('\n')}`).join('\n');
}

function vibeCatalogue(): string {
  return VIBE_KINDS.map((kind) => `${kind}:\n${VIBES.filter((x) => x.kind === kind).map((x) => `  - ${x.code} — ${x.label}: ${x.description}`).join('\n')}`).join('\n');
}

/** Frozen text: no dates, no per-run values — anything volatile here would silently invalidate the cache. */
export const SYSTEM_PROMPT = `You classify New York nightlife events for NOCT, a feed of club nights and parties. For each event you receive an evidence bundle: title, night and local times, venue with curated priors, promoter priors, lineup, price and age, raw genre labels from each source, crosswalk candidates, artist discography profiles, deterministic rule outputs, human-verified tags, and the description. Return the structured JSON the schema asks for.

## Genre taxonomy (use these codes only; 1 to 3 genres, best first)
${genreCatalogue()}

## Vibe vocabulary (0 to 6; add only what the evidence supports — the rules already cover time/price/age/venue, so add vibes the rules could not see: crowd, format, space cues from the text)
${vibeCatalogue()}

## Scalar rubrics
- energy: 1 ambient / listening, 2 slow and heady, 3 groovy mid-tempo, 4 driving peak-time, 5 hard and fast.
- darkness: 1 sunny / soulful / joyful, 2 warm, 3 neutral, 4 dark and moody, 5 industrial / abrasive.
- crowd_size: 1 <150, 2 150-400, 3 400-1,000, 4 1,000-3,000, 5 3,000+ (from venue capacity; use the room actually used, not the complex).
- start_lateness: 1 before 17:00, 2 17:00-20:00, 3 20:00-22:00, 4 22:00-00:00, 5 after midnight.
- end_lateness: 1 ends by 22:00, 2 by 01:00, 3 by 04:00, 4 by 06:00, 5 after 06:00 / afters.
- price_tier: 0 free, 1 <= $15, 2 <= $30, 3 <= $60, 4 > $60 (entry price; if unknown infer from venue and set sparse_input only if nothing else is known).
- underground_index: 1 mainstream / bottle service / EDM production, 2 commercial club, 3 mixed, 4 underground scene, 5 deep underground / DIY.
- confidence bins: 0.9 several independent sources agree; 0.8 one strong source (RA subgenre tag or headliner discography) plus consistent text; 0.65 one clear signal; 0.5 venue/promoter priors or generic family tag only; 0.35 weak inference; 0.2 a guess you would not show a user.

${NYC_GLOSSARY}

## Rules
1. Cite the evidence in every "why" (name the source: "RA tag", "DICE tag", "Discogs profile", "description", "venue prior", "promoter prior", "rule"). Keep each why under 25 words.
2. Never assign a subgenre from an artist's name alone. If the lineup is unknown to you and no profile, tag or text supports a subgenre, use the family's most generic code at <= 0.5 confidence and add ambiguous_artist. Artist knowledge you are confident about (well-known touring DJs) is allowed but say "model knowledge" in the why and cap it at 0.65.
3. When only venue or promoter priors exist (no source tags, no profiles, no genre words in text), cap every genre confidence at 0.5 and add sparse_input.
4. Generic family tags ("House", "Techno") establish the family, not the subgenre. Pick the subgenre from other evidence or use the family's generic code (house.deep for house, techno.peak for techno) at <= 0.65.
5. Respect human-verified tags: keep them, do not contradict them, and never re-assign a code listed as rejected.
6. is_electronic = false for live band gigs, comedy, theatre, hip-hop or R&B showcases with no DJ / club signal, and non-music events; add not_electronic. A DJ-led hip-hop or reggaeton party IS a club night (is_electronic = true).
7. conflicting_sources when sources disagree at the family level (e.g. RA says Techno, DICE says Reggaeton). needs_review when you would not stand behind the primary genre.
8. sound_summary: one human-facing sentence, at most 20 words, describing the sound and the setting ("Slow, psychedelic leftfield selections for a full night in Nowadays' main room").
9. Vibes must not repeat what the rules already emitted unless you disagree with the rule; prefer adding crowd/format vibes the text supports (queer_party, local_crews, international_headliner, listening_focus, live_act, black_diaspora_party, latinx_party).
10. Do not invent prices, times or venues that are not in the bundle.`;

// ---- client -----------------------------------------------------------------------------------------
/** Minimal structural view of `Anthropic['messages']['parse']` so tests can inject a fake. */
export interface ClassifierResponse {
  stop_reason: string | null;
  stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null;
  parsed_output: unknown;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null;
  };
}
export interface ClassifierClient {
  messages: { parse(params: Anthropic.MessageCreateParamsNonStreaming): Promise<ClassifierResponse> };
}

export function resolveModel(e: Record<string, string | undefined> = process.env): string {
  return env('NOCT_ENRICH_MODEL', DEFAULT_MODEL, e) as string;
}

/** Real client when ANTHROPIC_API_KEY is set; null otherwise (the runner then stays rules-only). */
export function createClient(e: Record<string, string | undefined> = process.env): ClassifierClient | null {
  const apiKey = env('ANTHROPIC_API_KEY', undefined, e);
  if (!apiKey) return null;
  return new Anthropic({ apiKey }) as unknown as ClassifierClient;
}

export type ClassifyResult =
  | { ok: true; output: ClassifierOutput; usage: TokenUsage; model: string; costUsd: number }
  | { ok: false; error: string; refusal: boolean; usage: TokenUsage | null; model: string; costUsd: number };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function usageOf(res: ClassifierResponse): TokenUsage {
  const u = res.usage;
  const out: TokenUsage = {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
  if (u.cache_creation) {
    out.cache_creation_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens;
    out.cache_creation_5m_tokens = u.cache_creation.ephemeral_5m_input_tokens;
  }
  return out;
}

export interface ClassifyOptions {
  bundle: string;
  client: ClassifierClient;
  model?: string;
  log?: Logger;
  /** wait before the single retry on 429 (tests pass 0) */
  retryDelayMs?: number;
}

export function buildRequest(bundle: string, model: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: bundle }],
    // Opus 5 runs adaptive thinking by default; effort 'medium' keeps reasoning proportionate to a classification
    output_config: { format: zodOutputFormat(OutputSchema), effort: 'medium' },
  };
}

export async function classifyEvent(opts: ClassifyOptions): Promise<ClassifyResult> {
  const model = opts.model ?? resolveModel();
  const params = buildRequest(opts.bundle, model);
  let res: ClassifierResponse;
  try {
    res = await callWithRetry(opts, params);
  } catch (err) {
    // the SDK's error classes do not set `name`, so the class name is the only readable type marker
    const message = err instanceof Anthropic.APIError ? `${err.constructor.name} ${err.status ?? ''}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, refusal: false, usage: null, model, costUsd: 0 };
  }
  const usage = usageOf(res);
  const costUsd = estimateCostUsd(res.model || model, usage);
  if (res.stop_reason === 'refusal') {
    const why = res.stop_details?.explanation ?? res.stop_details?.category ?? 'refusal';
    return { ok: false, error: `refusal: ${why}`, refusal: true, usage, model: res.model || model, costUsd };
  }
  if (res.parsed_output === null || res.parsed_output === undefined) {
    return { ok: false, error: `no parsed_output (stop_reason=${res.stop_reason})`, refusal: false, usage, model: res.model || model, costUsd };
  }
  const parsed = OutputSchema.safeParse(res.parsed_output);
  if (!parsed.success) return { ok: false, error: `schema mismatch: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`, refusal: false, usage, model: res.model || model, costUsd };
  return { ok: true, output: toClassifierOutput(parsed.data), usage, model: res.model || model, costUsd };
}

async function callWithRetry(opts: ClassifyOptions, params: Anthropic.MessageCreateParamsNonStreaming): Promise<ClassifierResponse> {
  try {
    return await opts.client.messages.parse(params);
  } catch (err) {
    if (!(err instanceof Anthropic.RateLimitError)) throw err;
    const retryAfter = Number(err.headers?.get?.('retry-after'));
    const wait = opts.retryDelayMs ?? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 20_000);
    opts.log?.warn('rate limited by Anthropic; retrying once', { waitMs: wait });
    await sleep(wait);
    return await opts.client.messages.parse(params);
  }
}
