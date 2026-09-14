/**
 * OpenAI-compatible backend for the enrichment classifier.
 *
 * classify.ts builds an Anthropic-shaped request (system blocks + user bundle + zod output schema) and calls
 * `client.messages.parse()`. This module offers the same `ClassifierClient` shape over any
 * `POST <base>/chat/completions` endpoint — Google AI Studio (Gemini), Groq, Mistral, OpenRouter, Cerebras,
 * GitHub Models, Ollama — which is how NOCT runs the genre/vibe step on a free tier:
 *   NOCT_LLM_PROVIDER=openai  NOCT_LLM_BASE_URL=...  NOCT_LLM_API_KEY=...  NOCT_LLM_MODEL=...
 *
 * Translation: system text -> `system` message; the JSON schema (real enums from z.toJSONSchema, not the
 * Anthropic SDK's description-folded variant) -> `response_format: {type:'json_schema'}`; if the provider
 * rejects that (400), fall back once and stick to `json_object` with the schema spelled out in the prompt.
 * Free tiers are metered per minute and per day, so calls are spaced (minIntervalMs) and a 429 is retried
 * exactly once after Retry-After. Nothing here loops: one failed call = one rules-only event.
 */
import type { Logger } from '../lib/log.js';
import type { ClassifierClient, ClassifierResponse } from './classify.js';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** JSON schema for the classifier output (with enums); sent as response_format and, in fallback, as prompt text */
  jsonSchema: Record<string, unknown>;
  /** minimum spacing between calls, ms (free tiers: 4000 ≈ 15 requests/min) */
  minIntervalMs?: number;
  /** start in `json_object` mode (for providers known to reject json_schema) */
  jsonMode?: 'json_schema' | 'json_object';
  /** default 6000: reasoning models (Gemini 3.x, o-series) spend part of this on thinking */
  maxTokens?: number;
  /** OpenAI-style `reasoning_effort` ('low' | 'medium' | 'high'); omitted when unset — not every provider accepts it */
  reasoningEffort?: string;
  timeoutMs?: number;
  log?: Logger;
  // injectable for tests
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };
  error?: { message?: string } | string;
}

/** Anthropic `system` is a string or text blocks; `messages[].content` likewise. Flatten both to plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  return '';
}

/** Models sometimes wrap JSON in ```json fences or add a sentence before it; keep the outermost object. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function retryAfterMs(headers: Headers, body: string): number {
  const h = Number(headers.get('retry-after'));
  if (Number.isFinite(h) && h > 0) return Math.min(h * 1000, 60_000);
  // Groq/Gemini style: "Please try again in 7.3s" / "retry in 12 seconds"
  const m = /try again in\s+([\d.]+)\s*(ms|s|sec|seconds?)|retry(?:\s+after)?\s+(?:in\s+)?([\d.]+)\s*(ms|s|sec|seconds?)/i.exec(body);
  if (m) {
    const n = Number(m[1] ?? m[3]);
    const unit = (m[2] ?? m[4] ?? 's').toLowerCase();
    if (Number.isFinite(n)) return Math.min(Math.max(unit === 'ms' ? n : n * 1000, 2_000), 60_000);
  }
  return 20_000;
}

const looksLikeSchemaRejection = (status: number, body: string): boolean =>
  status === 400 && /response_format|json_schema|schema|structured output/i.test(body);

export function createOpenAICompatibleClient(cfg: OpenAICompatibleConfig): ClassifierClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = cfg.now ?? (() => Date.now());
  const minInterval = cfg.minIntervalMs ?? 4_000;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let jsonMode: 'json_schema' | 'json_object' = cfg.jsonMode ?? 'json_schema';
  let lastCallAt = 0;

  const schemaHint = () =>
    `\n\n## Output format\nRespond with ONLY a JSON object (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(cfg.jsonSchema)}`;

  function body(system: string, user: string): Record<string, unknown> {
    const fallback = jsonMode === 'json_object';
    return {
      model: cfg.model,
      messages: [
        { role: 'system', content: fallback ? system + schemaHint() : system },
        { role: 'user', content: user },
      ],
      max_tokens: cfg.maxTokens ?? 6000,
      ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
      response_format: fallback
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'noct_classification', schema: cfg.jsonSchema } },
    };
  }

  async function post(payload: Record<string, unknown>): Promise<{ status: number; headers: Headers; text: string }> {
    const wait = lastCallAt + minInterval - now();
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  async function complete(system: string, user: string): Promise<ChatCompletion> {
    let r = await post(body(system, user));
    if (looksLikeSchemaRejection(r.status, r.text) && jsonMode === 'json_schema') {
      cfg.log?.warn('provider rejected response_format json_schema; switching this client to json_object mode', { detail: r.text.slice(0, 200) });
      jsonMode = 'json_object';
      r = await post(body(system, user));
    }
    if (r.status === 429) {
      const wait = retryAfterMs(r.headers, r.text);
      cfg.log?.warn('rate limited by LLM provider; retrying once', { waitMs: wait });
      await sleep(wait);
      r = await post(body(system, user));
      if (r.status === 429) throw new Error(`RateLimitError 429: ${r.text.slice(0, 300)}`);
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} from ${url}: ${r.text.slice(0, 300)}`);
    try {
      return JSON.parse(r.text) as ChatCompletion;
    } catch {
      throw new Error(`non-JSON response from ${url}: ${r.text.slice(0, 200)}`);
    }
  }

  return {
    messages: {
      async parse(params): Promise<ClassifierResponse> {
        const system = textOf(params.system);
        const user = params.messages.map((m) => textOf(m.content)).join('\n\n');
        const data = await complete(system, user);
        const choice = data.choices?.[0];
        const usage = data.usage ?? {};
        const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
        const base: Omit<ClassifierResponse, 'stop_reason' | 'parsed_output'> = {
          model: data.model || cfg.model,
          usage: {
            input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
            output_tokens: usage.completion_tokens ?? 0,
            cache_read_input_tokens: cached,
            cache_creation_input_tokens: 0,
          },
        };
        if (!choice) return { ...base, stop_reason: 'no_choice', parsed_output: null };
        if (choice.message?.refusal) {
          return { ...base, stop_reason: 'refusal', stop_details: { type: 'refusal', explanation: choice.message.refusal }, parsed_output: null };
        }
        if (choice.finish_reason === 'content_filter') {
          return { ...base, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'content_filter' }, parsed_output: null };
        }
        const parsed = choice.message?.content ? extractJson(choice.message.content) : null;
        const stop = choice.finish_reason === 'length' ? 'max_tokens' : parsed === null ? 'parse_error' : 'end_turn';
        return { ...base, stop_reason: stop, parsed_output: parsed };
      },
    },
  };
}
