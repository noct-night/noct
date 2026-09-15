import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildRequest, classifyEvent, createClientChain, estimateCostUsd, MODEL_PRICES, OutputSchema, PROMPT_VERSION,
  SYSTEM_PROMPT, toClassifierOutput,
  type ClassifierClient, type ClassifierResponse, type RawClassifierOutput } from '../../src/enrich/classify.js';
import { GENRE_CODES, VIBE_CODES } from '../../src/enrich/taxonomy.js';

const CANNED: RawClassifierOutput = {
  genres: [
    { code: 'leftfield.experimental', confidence: '0.8', why: 'description: psychedelic, coldwave, outsider dance music' },
    { code: 'techno.dub', confidence: '0.5', why: 'RA tag Techno + "low tempo" all-night resident set' },
  ],
  vibes: [{ code: 'underground', why: 'venue prior 5/5' }],
  scalars: { energy: '2', darkness: '4', crowd_size: '3', start_lateness: '4', end_lateness: '4', underground_index: '5', price_tier: '1' },
  sound_summary: 'Slow, psychedelic leftfield selections for a full night in the main room.',
  is_electronic: true,
  flags: [],
};

const USAGE = { input_tokens: 600, output_tokens: 400, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 };

function fakeClient(responses: Array<ClassifierResponse | Error>): { client: ClassifierClient; calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const queue = [...responses];
  const client: ClassifierClient = {
    messages: {
      async parse(params) {
        calls.push(params);
        const next = queue.shift();
        if (!next) throw new Error('fake client: no more responses');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { client, calls };
}

const ok = (parsed: unknown = CANNED, extra: Partial<ClassifierResponse> = {}): ClassifierResponse =>
  ({ stop_reason: 'end_turn', parsed_output: parsed, model: 'claude-opus-5', usage: USAGE, ...extra });

describe('classifier output schema', () => {
  it('accepts the canned output and maps enums to numbers', () => {
    expect(OutputSchema.safeParse(CANNED).success).toBe(true);
    const out = toClassifierOutput(CANNED);
    expect(out.genres[0]).toEqual({ code: 'leftfield.experimental', confidence: 0.8, why: CANNED.genres[0]!.why });
    expect(out.scalars).toEqual({ energy: 2, darkness: 4, crowd_size: 3, start_lateness: 4, end_lateness: 4, underground_index: 5, price_tier: 1 });
    expect(out.is_electronic).toBe(true);
  });
  it('rejects unknown codes, out-of-range enums and >3 genres', () => {
    expect(OutputSchema.safeParse({ ...CANNED, genres: [{ code: 'house.nope', confidence: '0.8', why: 'x' }] }).success).toBe(false);
    expect(OutputSchema.safeParse({ ...CANNED, scalars: { ...CANNED.scalars, energy: '6' } }).success).toBe(false);
    expect(OutputSchema.safeParse({ ...CANNED, genres: [] }).success).toBe(false);
    expect(OutputSchema.safeParse({ ...CANNED, genres: Array(4).fill(CANNED.genres[0]) }).success).toBe(false);
    expect(OutputSchema.safeParse({ ...CANNED, flags: ['made_up'] }).success).toBe(false);
  });
  it('the frozen system prompt lists every genre and vibe code and contains nothing volatile', () => {
    for (const code of GENRE_CODES) expect(SYSTEM_PROMPT).toContain(`- ${code} —`);
    for (const code of VIBE_CODES) expect(SYSTEM_PROMPT).toContain(`- ${code} —`);
    expect(SYSTEM_PROMPT).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(SYSTEM_PROMPT).toMatch(/Nowadays/);
    expect(PROMPT_VERSION).toBe('p1');
  });
});

describe('cost math', () => {
  it('prices opus / sonnet / haiku from the table, cache reads at 0.1x and 1h cache writes at 2x', () => {
    expect(MODEL_PRICES['claude-opus-5']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 });
    expect(estimateCostUsd('claude-opus-5', USAGE)).toBeCloseTo((600 * 5 + 400 * 25 + 2500 * 0.5) / 1e6, 8); // 0.01425
    expect(estimateCostUsd('claude-sonnet-5', USAGE)).toBeCloseTo((600 * 2 + 400 * 10 + 2500 * 0.2) / 1e6, 8); // 0.0057
    expect(estimateCostUsd('claude-haiku-4-5', USAGE)).toBeCloseTo((600 * 1 + 400 * 5 + 2500 * 0.1) / 1e6, 8);
    // first call of the hour writes the system prompt into the 1h cache
    expect(estimateCostUsd('claude-opus-5', { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 2500 })).toBeCloseTo((600 * 5 + 400 * 25 + 2500 * 10) / 1e6, 8);
    // when the API reports the TTL breakdown, price each bucket at its own rate
    expect(estimateCostUsd('claude-opus-5', { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 2500, cache_creation_5m_tokens: 2500, cache_creation_1h_tokens: 0 })).toBeCloseTo((600 * 5 + 400 * 25 + 2500 * 6.25) / 1e6, 8);
    expect(estimateCostUsd('claude-unknown', USAGE)).toBe(0);
  });
});

describe('classifyEvent with an injected client', () => {
  it('sends the frozen system prompt with a 1h cache breakpoint, the bundle, and the zod output format', async () => {
    const { client, calls } = fakeClient([ok()]);
    const res = await classifyEvent({ bundle: 'title: Vladimir Ivkovic All Night', client, model: 'claude-opus-5' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.genres.map((g) => g.code)).toEqual(['leftfield.experimental', 'techno.dub']);
    expect(res.output.genres[1]?.confidence).toBe(0.5);
    expect(res.usage).toEqual(USAGE);
    expect(res.model).toBe('claude-opus-5');
    expect(res.costUsd).toBeCloseTo(0.01425, 8);

    expect(calls).toHaveLength(1);
    const p = calls[0]!;
    expect(p.model).toBe('claude-opus-5');
    expect(p.max_tokens).toBe(2000);
    expect(p.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(p.messages).toEqual([{ role: 'user', content: 'title: Vladimir Ivkovic All Night' }]);
    expect(p.output_config?.effort).toBe('medium');
    expect(p.output_config?.format?.type).toBe('json_schema');
    expect(JSON.stringify(p.output_config?.format)).toContain('leftfield.experimental');
    expect('thinking' in p).toBe(false); // Opus 5 runs adaptive thinking by default; we do not pin a budget
  });
  it('defaults the model to NOCT_ENRICH_MODEL / claude-opus-5 and reports the model the API answered with', async () => {
    expect(buildRequest('x', 'claude-opus-5').model).toBe('claude-opus-5');
    const { client } = fakeClient([ok(CANNED, { model: 'claude-sonnet-5' })]);
    const res = await classifyEvent({ bundle: 'x', client, model: 'claude-sonnet-5' });
    expect(res.ok && res.model).toBe('claude-sonnet-5');
    expect(res.costUsd).toBeCloseTo(0.0057, 8);
  });
  it('treats a refusal as a skip with the refusal flagged, not a crash', async () => {
    const { client } = fakeClient([ok(null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other', explanation: 'declined' } })]);
    const res = await classifyEvent({ bundle: 'x', client, model: 'claude-opus-5' });
    expect(res).toMatchObject({ ok: false, refusal: true, error: 'refusal: declined' });
    expect(res.costUsd).toBeCloseTo(0.01425, 8);
  });
  it('null parsed_output and schema mismatches are errors', async () => {
    const { client } = fakeClient([ok(null, { stop_reason: 'max_tokens' }), ok({ ...CANNED, genres: [{ code: 'nope', confidence: '0.8', why: '' }] })]);
    const a = await classifyEvent({ bundle: 'x', client, model: 'claude-opus-5' });
    expect(a).toMatchObject({ ok: false, refusal: false });
    expect(!a.ok && a.error).toMatch(/no parsed_output \(stop_reason=max_tokens\)/);
    const b = await classifyEvent({ bundle: 'x', client, model: 'claude-opus-5' });
    expect(!b.ok && b.error).toMatch(/schema mismatch/);
  });
  it('retries exactly once on RateLimitError, then succeeds', async () => {
    const rl = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '1' }));
    const { client, calls } = fakeClient([rl, ok()]);
    const res = await classifyEvent({ bundle: 'x', client, model: 'claude-opus-5', retryDelayMs: 0 });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it('a second RateLimitError, other APIErrors and plain errors are recorded, never thrown', async () => {
    const rl = () => new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
    const twice = fakeClient([rl(), rl()]);
    const a = await classifyEvent({ bundle: 'x', client: twice.client, model: 'claude-opus-5', retryDelayMs: 0 });
    expect(a).toMatchObject({ ok: false, refusal: false, usage: null, costUsd: 0 });
    expect(!a.ok && a.error).toMatch(/RateLimitError 429/);
    expect(twice.calls).toHaveLength(2);

    const boom = fakeClient([new Anthropic.APIError(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }, 'boom', new Headers())]);
    const b = await classifyEvent({ bundle: 'x', client: boom.client, model: 'claude-opus-5', retryDelayMs: 0 });
    expect(!b.ok && b.error).toMatch(/APIError 500: .*boom/);
    expect(boom.calls).toHaveLength(1);

    const plain = fakeClient([new Error('socket hang up')]);
    const c = await classifyEvent({ bundle: 'x', client: plain.client, model: 'claude-opus-5' });
    expect(!c.ok && c.error).toBe('socket hang up');
  });
});

describe('rules-only provider selection', () => {
  it('NOCT_LLM_PROVIDER=none means none, even with a fallback key present', () => {
    const chain = createClientChain({ NOCT_LLM_PROVIDER: 'none', GROQ_API_KEY: 'gsk_test' });
    expect(chain).toEqual([]);
  });

  it('a fallback key adds a second backend behind the primary', () => {
    const chain = createClientChain({
      NOCT_LLM_PROVIDER: 'openai', NOCT_LLM_BASE_URL: 'https://x/v1', NOCT_LLM_API_KEY: 'k', NOCT_LLM_MODEL: 'm',
      GROQ_API_KEY: 'gsk_test',
    });
    expect(chain.map((c) => c.name)).toEqual(['openai', 'groq']);
  });

  it('no fallback key means the chain is just the primary', () => {
    const chain = createClientChain({
      NOCT_LLM_PROVIDER: 'openai', NOCT_LLM_BASE_URL: 'https://x/v1', NOCT_LLM_API_KEY: 'k', NOCT_LLM_MODEL: 'm',
    });
    expect(chain.map((c) => c.name)).toEqual(['openai']);
  });
});
