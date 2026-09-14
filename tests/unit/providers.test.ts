import { describe, expect, it } from 'vitest';
import { createClient, OUTPUT_JSON_SCHEMA, buildRequest, resolveModel, resolveProvider, supportsEffort } from '../../src/enrich/classify.js';
import { createOpenAICompatibleClient, extractJson } from '../../src/enrich/providers.js';

const GOOD = {
  genres: [{ code: 'house.deep', confidence: '0.8', why: 'RA tag Deep House' }],
  vibes: [{ code: 'sunny_day_party', why: 'rule' }],
  scalars: { energy: '3', darkness: '1', crowd_size: '3', start_lateness: '1', end_lateness: '1', underground_index: '4', price_tier: '1' },
  sound_summary: 'Sun-soaked deep house in the yard',
  is_electronic: true,
  flags: [],
};

type Call = { url: string; init: RequestInit; body: any };
function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch: no more responses');
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { 'content-type': 'application/json', ...(next.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const completion = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: 'gemini-2.5-flash',
  choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  usage: { prompt_tokens: 6100, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 5000 } },
  ...extra,
});
function client(responses: Parameters<typeof fakeFetch>[0], opts: Partial<Parameters<typeof createOpenAICompatibleClient>[0]> = {}) {
  const f = fakeFetch(responses);
  const waits: number[] = [];
  let t = 1_000_000;
  const c = createOpenAICompatibleClient({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: 'k',
    model: 'gemini-2.5-flash',
    jsonSchema: OUTPUT_JSON_SCHEMA,
    minIntervalMs: 4000,
    fetchImpl: f.impl,
    sleep: async (ms) => { waits.push(ms); t += ms; },
    now: () => t,
    ...opts,
  });
  return { c, calls: f.calls, waits, tick: (ms: number) => { t += ms; } };
}

describe('OUTPUT_JSON_SCHEMA (zod 4 native)', () => {
  it('keeps real enums, min/max items and additionalProperties:false (unlike the Anthropic SDK transform)', () => {
    const s = OUTPUT_JSON_SCHEMA as any;
    expect(s.properties.genres.minItems).toBe(1);
    expect(s.properties.genres.maxItems).toBe(3);
    expect(s.properties.genres.items.properties.code.enum).toContain('house.deep');
    expect(s.properties.scalars.properties.energy.enum).toEqual(['1', '2', '3', '4', '5']);
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['genres', 'vibes', 'scalars', 'sound_summary', 'is_electronic', 'flags']);
  });
});

describe('createOpenAICompatibleClient', () => {
  it('translates the Anthropic-shaped request into a chat completion with json_schema', async () => {
    const { c, calls } = client([{ status: 200, body: completion(GOOD) }]);
    const res = await c.messages.parse(buildRequest('title: Mister Sunday', 'gemini-2.5-flash'));
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const b = calls[0]!.body;
    expect(b.model).toBe('gemini-2.5-flash');
    expect(b.messages[0].role).toBe('system');
    expect(b.messages[0].content).toContain('You classify New York nightlife events');
    expect(b.messages[1]).toEqual({ role: 'user', content: 'title: Mister Sunday' });
    expect(b.response_format.type).toBe('json_schema');
    expect(b.response_format.json_schema.schema.properties.genres.items.properties.code.enum).toContain('techno.dub');
    expect(b.max_tokens).toBe(2000);
    expect(b).not.toHaveProperty('output_config');
    expect(res.stop_reason).toBe('end_turn');
    expect(res.parsed_output).toEqual(GOOD);
    expect(res.model).toBe('gemini-2.5-flash');
    // OpenAI prompt_tokens includes cached tokens; Anthropic input_tokens excludes them
    expect(res.usage).toEqual({ input_tokens: 1100, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 });
  });
  it('strips code fences and leading prose from the JSON', async () => {
    const { c } = client([{ status: 200, body: completion('Sure! ```json\n' + JSON.stringify(GOOD) + '\n```') }]);
    const res = await c.messages.parse(buildRequest('x', 'm'));
    expect(res.parsed_output).toEqual(GOOD);
    expect(extractJson('nope')).toBeNull();
  });
  it('maps refusals, content filters, length and unparsable output', async () => {
    const { c } = client([
      { status: 200, body: completion(GOOD, { choices: [{ finish_reason: 'stop', message: { refusal: 'no' } }] }) },
      { status: 200, body: completion(GOOD, { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }) },
      { status: 200, body: completion(GOOD, { choices: [{ finish_reason: 'length', message: { content: '{"genres": [' } }] }) },
      { status: 200, body: completion('not json at all') },
    ]);
    expect((await c.messages.parse(buildRequest('x', 'm'))).stop_reason).toBe('refusal');
    expect((await c.messages.parse(buildRequest('x', 'm'))).stop_reason).toBe('refusal');
    expect((await c.messages.parse(buildRequest('x', 'm'))).stop_reason).toBe('max_tokens');
    const d = await c.messages.parse(buildRequest('x', 'm'));
    expect(d.stop_reason).toBe('parse_error');
    expect(d.parsed_output).toBeNull();
  });
  it('spaces calls by minIntervalMs and retries a 429 once after Retry-After', async () => {
    const { c, calls, waits } = client([
      { status: 200, body: completion(GOOD) },
      { status: 429, body: { error: { message: 'Rate limit reached. Please try again in 7.3s' } }, headers: { 'retry-after': '9' } },
      { status: 200, body: completion(GOOD) },
    ]);
    await c.messages.parse(buildRequest('a', 'm'));
    await c.messages.parse(buildRequest('b', 'm'));
    expect(calls.length).toBe(3);
    expect(waits).toEqual([4000, 9000]); // spacing before call 2, then the Retry-After header wins over the body hint
  });
  it('a second 429 surfaces as an error the classifier records', async () => {
    const { c } = client([
      { status: 429, body: { error: { message: 'slow down' } } },
      { status: 429, body: { error: { message: 'slow down' } } },
    ]);
    await expect(c.messages.parse(buildRequest('a', 'm'))).rejects.toThrow(/429/);
  });
  it('falls back to json_object (schema in the prompt) when the provider rejects json_schema, and stays there', async () => {
    const { c, calls } = client([
      { status: 400, body: { error: { message: "response_format 'json_schema' is not supported" } } },
      { status: 200, body: completion(GOOD) },
      { status: 200, body: completion(GOOD) },
    ]);
    await c.messages.parse(buildRequest('a', 'm'));
    await c.messages.parse(buildRequest('b', 'm'));
    expect(calls.map((x) => x.body.response_format.type)).toEqual(['json_schema', 'json_object', 'json_object']);
    expect(calls[1]!.body.messages[0].content).toContain('validates against this JSON Schema');
    expect(calls[1]!.body.messages[0].content).toContain('"house.deep"');
  });
  it('other HTTP errors throw with the status', async () => {
    const { c } = client([{ status: 500, body: { error: 'boom' } }]);
    await expect(c.messages.parse(buildRequest('a', 'm'))).rejects.toThrow(/HTTP 500/);
  });
});

describe('provider selection', () => {
  it('picks anthropic first, then openai, else none; explicit NOCT_LLM_PROVIDER wins', () => {
    expect(resolveProvider({})).toBe('none');
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'a' })).toBe('anthropic');
    expect(resolveProvider({ NOCT_LLM_API_KEY: 'g' })).toBe('openai');
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'a', NOCT_LLM_API_KEY: 'g' })).toBe('anthropic');
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'a', NOCT_LLM_API_KEY: 'g', NOCT_LLM_PROVIDER: 'openai' })).toBe('openai');
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'a', NOCT_LLM_PROVIDER: 'none' })).toBe('none');
    expect(() => resolveProvider({ NOCT_LLM_PROVIDER: 'gemini' })).toThrow(/anthropic \| openai \| none/);
  });
  it('resolveModel follows the provider', () => {
    expect(resolveModel({})).toBe('claude-opus-5');
    expect(resolveModel({ ANTHROPIC_API_KEY: 'a', NOCT_ENRICH_MODEL: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
    expect(resolveModel({ NOCT_LLM_API_KEY: 'g', NOCT_LLM_MODEL: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash');
  });
  it('createClient returns null without keys, throws on half-configured openai, builds the shim when complete', () => {
    expect(createClient({})).toBeNull();
    expect(() => createClient({ NOCT_LLM_API_KEY: 'g' })).toThrow(/NOCT_LLM_BASE_URL, NOCT_LLM_MODEL/);
    expect(() => createClient({ NOCT_LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    const c = createClient({ NOCT_LLM_API_KEY: 'g', NOCT_LLM_BASE_URL: 'https://api.groq.com/openai/v1', NOCT_LLM_MODEL: 'llama-3.3-70b-versatile' });
    expect(c).not.toBeNull();
    expect(typeof c!.messages.parse).toBe('function');
  });
  it('effort is only sent to Claude models that accept it', () => {
    expect(supportsEffort('claude-opus-5')).toBe(true);
    expect(supportsEffort('claude-sonnet-5')).toBe(true);
    expect(supportsEffort('claude-haiku-4-5')).toBe(false);
    expect(supportsEffort('gemini-2.5-flash')).toBe(false);
    expect((buildRequest('x', 'claude-haiku-4-5').output_config as any).effort).toBeUndefined();
    expect((buildRequest('x', 'claude-opus-5').output_config as any).effort).toBe('medium');
  });
});
