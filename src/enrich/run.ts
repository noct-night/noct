/**
 * Genre / vibe enrichment runner (stages S1 rules -> S3 evidence -> S4 classifier -> S5 persist).
 *
 * For each candidate event: apply rules, build the evidence bundle, call the LLM when a client is available
 * (ANTHROPIC_API_KEY, an OpenAI-compatible provider via NOCT_LLM_*, or an injected client), merge, and write
 * everything in one transaction:
 * event.* denormalised columns, event_tag rows with provenance (human rows untouched), classification_run.
 * Without a key the run is rules-only: crosswalk genres capped at 0.5 confidence, rule vibes, rule scalars.
 */
import type pg from 'pg';
import { query, withTx } from '../lib/db.js';
import { env, type Env } from '../lib/env.js';
import { createLogger, type Logger } from '../lib/log.js';
import { classifyEvent, createClient, createClientChain, PROMPT_VERSION, resolveModel, type ClassifierClient, type ClassifierOutput, type ClassifyResult, type NamedClient, type TokenUsage } from './classify.js';
import { buildEvidenceBundle, CANDIDATE_SQL, computeInputHash, normalizeCandidate, toRuleInput, type CandidateRow } from './evidence.js';
import { applyRules, RULES_VERSION, type RuleOutput } from './rules.js';
import { isGenreCode, isVibeCode, type GenreCode, type VibeCode } from './taxonomy.js';

export interface EnrichOptions {
  env?: Env;
  log?: Logger;
  /** max events to classify in this invocation */
  limit?: number;
  /** re-run even if input_hash unchanged (also what a prompt / rules version bump does implicitly) */
  force?: boolean;
  /** only these event ids (narrows the candidates; unchanged events are still skipped unless `force`) */
  eventIds?: string[];
  /** injected classifier (tests); `null` forces rules-only even when ANTHROPIC_API_KEY is set */
  client?: ClassifierClient | null;
  /** overrides NOCT_ENRICH_MODEL */
  model?: string;
}

export interface EnrichSummary {
  /** model the classifier was asked for, or 'rules-only' when no client was available */
  model: string;
  considered: number;
  rulesApplied: number;
  classified: number;
  skipped: number;
  costUsd: number;
  errors: string[];
  /** true when the run ended early because the LLM provider returned 429 twice (remaining events stay pending) */
  quotaStopped?: boolean;
  /** true when the run ended early because NOCT_RUN_BUDGET_MS elapsed (remaining events stay pending) */
  budgetStopped?: boolean;
  /** events left pending after a transient provider error (5xx / network); retried on the next run */
  deferred?: number;
  /** how many events each backend classified, when a fallback chain is configured */
  byBackend?: Record<string, number>;
}

/** 429 / quota errors from either backend (Anthropic RateLimitError, OpenAI-compatible "RateLimitError 429: ..."). */
/**
 * A 429 that clears on its own. Groq answers "Rate limit reached ... on tokens per minute (TPM): Limit 8000
 * ... Please try again in 13.14s" -- a per-minute ceiling, not the day's allowance. Treating that as a wall
 * threw the whole backend away for the rest of the run, which is exactly what it did the first time.
 */
export function isPerMinuteLimit(message: string): boolean {
  if (!/\b429\b|RateLimitError|rate limit/i.test(message)) return false;
  if (/\bper[- ]day\b|\bdaily\b|\bper[- ]?d\b|RPD|TPD/i.test(message)) return false;
  if (/\bper[- ]minute\b|\bTPM\b|\bRPM\b|\bper[- ]second\b/i.test(message)) return true;
  // "try again in 42s" without a stated window: short enough to wait out, long enough to be the day's cap
  const m = /try again in ([\d.]+)\s*(ms|s|m)\b/i.exec(message);
  if (m) {
    const n = Number(m[1]);
    const secs = m[2]?.toLowerCase() === 'ms' ? n / 1000 : m[2]?.toLowerCase() === 'm' ? n * 60 : n;
    return Number.isFinite(secs) && secs <= 120;
  }
  return false;
}

/** The day's allowance is gone: this backend has nothing left to give until it resets. */
export function isQuotaError(message: string): boolean {
  if (isPerMinuteLimit(message)) return false;
  return /\bRateLimitError\b|\b429\b|quota|rate limit/i.test(message);
}

/** Server-side or network failures worth retrying later without recording anything (5xx, overload, timeouts). */
export function isTransientError(message: string): boolean {
  return /\bHTTP 5\d\d\b|InternalServerError|OverloadedError|\boverloaded\b|high demand|UNAVAILABLE|fetch failed|ECONNRESET|ETIMEDOUT|timed? ?out|APIConnectionError/i.test(message);
}

interface TagSource { source: string; evidence: string; weight: number }
interface MergedTag { kind: 'genre' | 'vibe'; code: string; confidence: number; sources: TagSource[] }

export interface Merged {
  genres: { code: GenreCode; confidence: number; sources: TagSource[] }[];
  vibes: { code: VibeCode; sources: TagSource[] }[];
  scalars: { energy: number | null; darkness: number | null; crowd_size: number | null; start_lateness: number | null; end_lateness: number | null; price_tier: number | null; underground_index: number | null };
  sound_summary: string | null;
  is_electronic: boolean | null;
  needs_review: boolean;
  flags: string[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Final labels = human-verified tags first, then LLM genres (or crosswalk top codes capped at 0.5 when there is
 * no LLM), minus anything humans rejected. Vibes are the union of rule vibes and LLM vibes.
 */
export function mergeOutputs(c: CandidateRow, rules: RuleOutput, llm: ClassifierOutput | null): Merged {
  const rejected = new Set(c.human_tags.filter((t) => t.status === 'rejected').map((t) => `${t.kind}:${t.code}`));
  const human = c.human_tags.filter((t) => t.status === 'confirmed' || t.status === 'community');

  const genres = new Map<GenreCode, { confidence: number; sources: TagSource[] }>();
  const upsertGenre = (code: string, confidence: number, src: TagSource): void => {
    if (!isGenreCode(code) || rejected.has(`genre:${code}`)) return;
    const cur = genres.get(code);
    if (cur) { cur.confidence = Math.max(cur.confidence, confidence); cur.sources.push(src); }
    else genres.set(code, { confidence, sources: [src] });
  };
  for (const t of human.filter((t) => t.kind === 'genre')) upsertGenre(t.code, Math.max(t.confidence, 0.9), { source: t.status === 'confirmed' ? 'curator' : 'community', evidence: `${t.status} by humans`, weight: 1 });
  if (llm) {
    for (const gx of llm.genres) upsertGenre(gx.code, gx.confidence, { source: 'llm', evidence: gx.why, weight: gx.confidence });
  } else {
    // rules-only: crosswalk ranking, never above 0.5 — nobody has reconciled the evidence
    for (const rk of rules.crosswalk.ranked.slice(0, 3)) upsertGenre(rk.code, Math.min(0.5, rk.weight), { source: 'crosswalk', evidence: rk.sources.join('; '), weight: rk.weight });
    if (genres.size === 0) {
      for (const p of rules.genre_priors.filter((p) => p.source === 'promoter_prior' || p.source === 'venue_prior').slice(0, 2)) {
        upsertGenre(p.code, Math.min(0.4, p.weight), { source: p.source, evidence: p.evidence, weight: p.weight });
      }
    }
  }
  // provenance for codes the LLM picked that rules also saw
  for (const p of rules.genre_priors) {
    const cur = genres.get(p.code);
    if (cur && !cur.sources.some((s) => s.source === p.source && s.evidence === p.evidence)) cur.sources.push({ source: p.source, evidence: p.evidence, weight: p.weight });
  }
  const genreList = [...genres.entries()]
    .map(([code, gx]) => ({ code, confidence: r2(gx.confidence), sources: gx.sources }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  const vibes = new Map<VibeCode, TagSource[]>();
  const addVibe = (code: string, src: TagSource): void => {
    if (!isVibeCode(code) || rejected.has(`vibe:${code}`)) return;
    const cur = vibes.get(code);
    if (cur) cur.push(src); else vibes.set(code, [src]);
  };
  for (const t of human.filter((t) => t.kind === 'vibe')) addVibe(t.code, { source: t.status === 'confirmed' ? 'curator' : 'community', evidence: `${t.status} by humans`, weight: 1 });
  for (const v of rules.vibes) addVibe(v.code, { source: `rule:${v.rule}`, evidence: v.evidence, weight: 0.8 });
  for (const v of llm?.vibes ?? []) addVibe(v.code, { source: 'llm', evidence: v.why, weight: 0.7 });

  const s = rules.scalars;
  const scalars: Merged['scalars'] = llm
    ? { ...llm.scalars }
    : { energy: null, darkness: null, crowd_size: s.crowd_size ?? null, start_lateness: s.start_lateness ?? null, end_lateness: s.end_lateness ?? null, price_tier: s.price_tier ?? null, underground_index: s.underground_index ?? null };
  // the rules read the clock directly; keep their timing scalars when the model disagrees with the listing
  if (llm && s.start_lateness !== undefined) scalars.start_lateness = s.start_lateness;
  if (llm && s.end_lateness !== undefined) scalars.end_lateness = s.end_lateness;
  if (llm && s.price_tier !== undefined) scalars.price_tier = s.price_tier;

  const topConf = genreList[0]?.confidence ?? 0;
  const flags = llm ? [...llm.flags] : [];
  const needs_review = topConf < 0.5 || flags.length > 0;
  return {
    genres: genreList,
    vibes: [...vibes.entries()].map(([code, sources]) => ({ code, sources })),
    scalars,
    sound_summary: llm?.sound_summary || null,
    is_electronic: llm ? llm.is_electronic : rules.crosswalk.is_electronic,
    needs_review,
    flags,
  };
}

interface RunRecord {
  model: string | null;
  input: unknown;
  output: unknown;
  usage: TokenUsage | null;
  costUsd: number;
  error: string | null;
}

async function persist(client: pg.PoolClient, c: CandidateRow, merged: Merged, inputHash: string, version: string, run: RunRecord): Promise<void> {
  const tags: MergedTag[] = [
    ...merged.genres.map((gx) => ({ kind: 'genre' as const, code: gx.code, confidence: gx.confidence, sources: gx.sources })),
    // a vibe is as sure as its strongest witness: human 1, a rule reading the listing 0.8, the model alone 0.7
    ...merged.vibes.map((vx) => ({ kind: 'vibe' as const, code: vx.code, confidence: r2(Math.max(...vx.sources.map((s) => s.weight))), sources: vx.sources })),
  ];
  await client.query(
    `update event set
       primary_genre = $2, genre_codes = $3, genre_confidence = $4, vibe_codes = $5,
       energy = $6, darkness = $7, crowd_size = $8, start_lateness = $9, end_lateness = $10, price_tier = $11, underground_index = $12,
       sound_summary = $13, is_electronic = $14, needs_review = $15, classification_version = $16, classified_at = now(), input_hash = $17
     where event_id = $1`,
    [
      c.event_id, merged.genres[0]?.code ?? null, merged.genres.map((gx) => gx.code), merged.genres[0]?.confidence ?? null,
      merged.vibes.map((vx) => vx.code),
      merged.scalars.energy, merged.scalars.darkness, merged.scalars.crowd_size, merged.scalars.start_lateness, merged.scalars.end_lateness,
      merged.scalars.price_tier, merged.scalars.underground_index,
      merged.sound_summary, merged.is_electronic, merged.needs_review, version, inputHash,
    ],
  );
  // replace the machine-written rows only; confirmed / community / rejected rows are human state
  await client.query(`delete from event_tag where event_id = $1 and status = 'auto'`, [c.event_id]);
  if (tags.length) {
    // A human-held row keeps its status, confidence and human-origin evidence; only the machine provenance
    // is refreshed (not appended — a nightly re-run must not pile up duplicate 'llm' entries).
    await client.query(
      `insert into event_tag (event_id, kind, code, confidence, sources, status)
       select $1, t.kind, t.code, t.confidence, t.sources, 'auto'
       from jsonb_to_recordset($2::jsonb) as t(kind text, code text, confidence numeric, sources jsonb)
       on conflict (event_id, kind, code) do update
         set sources = (select coalesce(jsonb_agg(s), '[]'::jsonb) from jsonb_array_elements(event_tag.sources) s
                         where s->>'source' in ('community', 'curator', 'manual'))
                    || (select coalesce(jsonb_agg(s), '[]'::jsonb) from jsonb_array_elements(excluded.sources) s
                         where s->>'source' not in ('community', 'curator', 'manual')),
             updated_at = now()
         where event_tag.status in ('confirmed', 'community')`,
      [c.event_id, JSON.stringify(tags)],
    );
  }
  await client.query(
    `insert into classification_run (event_id, model, prompt_version, rules_version, input, output, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, cost_usd, error)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
    [
      c.event_id, run.model, PROMPT_VERSION, RULES_VERSION, JSON.stringify(run.input), JSON.stringify(run.output),
      run.usage?.input_tokens ?? 0, run.usage?.cache_read_input_tokens ?? 0, run.usage?.cache_creation_input_tokens ?? 0, run.usage?.output_tokens ?? 0,
      run.costUsd, run.error,
    ],
  );
}

export async function runEnrichment(opts: EnrichOptions = {}): Promise<EnrichSummary> {
  const e = opts.env ?? process.env;
  const log = opts.log ?? createLogger('enrich');
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  const model = opts.model ?? resolveModel(e);
  // An explicitly injected client (tests) stays a chain of one; otherwise the primary plus any free-tier
  // fallback whose key is configured.
  const chain: NamedClient[] = opts.client === undefined
    ? createClientChain(e, log)
    : (opts.client ? [{ name: 'injected', model, client: opts.client }] : []);
  const client = chain[0]?.client ?? null;
  /** Backends that answered "out of quota" this run; skipped for every remaining event. */
  const exhausted = new Set<string>();
  const versionPrefix = `${RULES_VERSION}/${PROMPT_VERSION}/`;
  const summary: EnrichSummary = { model: client ? model : 'rules-only', considered: 0, rulesApplied: 0, classified: 0, skipped: 0, costUsd: 0, errors: [] };
  if (!client) log.info('no classifier client (no ANTHROPIC_API_KEY / NOCT_LLM_API_KEY): rules-only pass');
  if (chain.length > 1) log.info('classifier chain', { order: chain.map((c) => `${c.name}:${c.model}`).join(' -> ') });

  const eventIds = opts.eventIds?.length ? opts.eventIds : null;
  // over-fetch: some rows will be skipped as unchanged; the SQL ordering keeps never-classified events first
  const fetchLimit = eventIds ? eventIds.length : Math.min(limit * 4, 1000);
  const res = await query(CANDIDATE_SQL, [Boolean(opts.force), versionPrefix, eventIds, fetchLimit]);
  const candidates = res.rows.map((row) => normalizeCandidate(row));
  log.info('candidates fetched', { fetched: candidates.length, limit, model: client ? model : 'rules-only' });

  // Vercel functions are capped at 300 s; leave the remainder un-run rather than being killed mid-write.
  const budgetMs = Number(env('NOCT_RUN_BUDGET_MS', '270000', e));
  const startedAt = Date.now();
  let processed = 0;
  for (const c of candidates) {
    if (processed >= limit) break;
    if (Date.now() - startedAt > budgetMs) {
      summary.budgetStopped = true;
      log.warn('time budget reached; remaining events stay pending for the next run', { processed, budgetMs });
      break;
    }
    summary.considered++;
    const inputHash = computeInputHash(c);
    // same inputs under the same rules/prompt version -> nothing new to learn (and no tokens to spend)
    if (!opts.force && c.input_hash === inputHash && c.classification_version?.startsWith(versionPrefix)) {
      summary.skipped++;
      continue;
    }
    processed++;
    try {
      const rules = applyRules(toRuleInput(c));
      summary.rulesApplied++;
      const bundle = buildEvidenceBundle(c, rules);
      let llm: ClassifierOutput | null = null;
      let record: RunRecord = { model: null, input: { bundle, rules: { vibes: rules.vibes, scalars: rules.scalars, flags: rules.flags } }, output: null, usage: null, costUsd: 0, error: null };
      let usedModel = 'rules';
      // Walk the chain: a backend that has hit its daily wall is skipped, and quota on one is a reason to ask
      // the next one, not to end the run.
      let outcome: 'ok' | 'defer' | 'quota' | 'failed' | 'none' = 'none';
      for (const backend of chain) {
        if (exhausted.has(backend.name)) continue;
        const result: ClassifyResult = await classifyEvent({ bundle, client: backend.client, model: backend.model, log });
        summary.costUsd = r2Money(summary.costUsd + result.costUsd);
        if (result.ok) {
          llm = result.output;
          usedModel = result.model;
          record = { ...record, model: result.model, output: result.output, usage: result.usage, costUsd: result.costUsd };
          summary.classified++;
          summary.byBackend = { ...summary.byBackend, [backend.name]: (summary.byBackend?.[backend.name] ?? 0) + 1 };
          outcome = 'ok';
          break;
        }
        if (isTransientError(result.error) || isPerMinuteLimit(result.error)) {
          // Provider hiccup (5xx / network / timeout): try the next backend, and if there is none, leave the
          // event pending for the next run rather than writing a rules-only result over it.
          summary.errors.push(`${c.event_id} [${backend.name}]: ${result.error}`);
          log.warn('transient provider error', { event: c.event_id, backend: backend.name, error: result.error.slice(0, 160) });
          outcome = 'defer';
          continue;
        }
        if (isQuotaError(result.error)) {
          // Daily quota on a free tier: this backend is done for the run, but the others are not.
          exhausted.add(backend.name);
          summary.errors.push(`${c.event_id} [${backend.name}]: ${result.error}`);
          log.warn('backend out of quota; falling through', { event: c.event_id, backend: backend.name });
          outcome = 'quota';
          continue;
        }
        // A real refusal or a bad request is about this event, not this backend: rules-only, flagged.
        usedModel = result.model;
        record = { ...record, model: result.model, output: null, usage: result.usage, costUsd: result.costUsd, error: result.error };
        summary.errors.push(`${c.event_id} [${backend.name}]: ${result.error}`);
        log.warn('classifier failed; persisting rules-only', { event: c.event_id, backend: backend.name, error: result.error, refusal: result.refusal });
        outcome = 'failed';
        break;
      }
      if (outcome === 'defer' || outcome === 'quota') {
        // Nothing answered. Do NOT persist rules-only with the new input_hash — that would park the event
        // until its inputs change. Leave it pending; the next run picks it up.
        summary.deferred = (summary.deferred ?? 0) + 1;
        if (outcome === 'quota' && chain.every((b) => exhausted.has(b.name))) {
          summary.quotaStopped = true;
          log.warn('every backend is out of quota; stopping this run', { event: c.event_id });
          break;
        }
        continue;
      }
      const merged = mergeOutputs(c, rules, llm);
      // a refusal or API error still gets rules-only labels but stays flagged for a human look
      if (client && !llm) merged.needs_review = true;
      // A rules-only result nobody asked an LLM about is PROVISIONAL. The candidate query excludes anything
      // whose classification_version starts with the current rules/prompt prefix, so writing the plain version
      // here would park the event at rules quality for good -- the exact trap the quota branch avoids. The
      // `provisional/` prefix keeps it eligible, and the ordering (never-classified first) means new events
      // still get the model before these are revisited.
      if (outcome === 'none' && !llm) merged.needs_review = true;
      const version = outcome === 'none' && !llm
        ? `provisional/${RULES_VERSION}/${PROMPT_VERSION}/rules`
        : `${RULES_VERSION}/${PROMPT_VERSION}/${usedModel}`;
      await withTx((tx) => persist(tx, c, merged, inputHash, version, record));
      log.info('enriched', { event: c.event_id, title: c.title.slice(0, 50), genres: merged.genres.map((gx) => `${gx.code}@${gx.confidence}`), vibes: merged.vibes.length, model: usedModel });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${c.event_id}: ${msg}`);
      log.error('enrichment failed', { event: c.event_id, error: msg });
    }
  }
  log.info('enrichment done', { ...summary, errors: summary.errors.length });
  return summary;
}

const r2Money = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
