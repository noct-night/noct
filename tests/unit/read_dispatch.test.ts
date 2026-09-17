import { describe, expect, it } from 'vitest';
import { routeName } from '../../api/read/[fn].js';

/** The one-function dispatcher behind /api/search, /api/taste, /api/night, /api/ics, /api/health, /api/recommend, /api/traffic. */
describe('api/read dispatcher', () => {
  it('names the route from the public path, the rewritten path, or the route segment', () => {
    expect(routeName({ url: '/api/search?q=kobosil', query: { q: 'kobosil' } })).toBe('search');
    expect(routeName({ url: '/api/read/night?e=abc', query: { fn: 'night', e: 'abc' } })).toBe('night');
    expect(routeName({ url: '/api/ics?e=abc', query: { fn: 'ics' } })).toBe('ics');
    expect(routeName({ url: undefined, query: { fn: 'health' } })).toBe('health');
    expect(routeName({ url: '/api/traffic?days=7', query: { days: '7' } })).toBe('traffic');
  });
  it('the path wins over a caller-supplied fn, and unknown names are rejected', () => {
    // a caller cannot redirect /api/taste to another handler by adding ?fn=
    expect(routeName({ url: '/api/taste?fn=recommend&city=nyc', query: { fn: ['recommend', 'taste'], city: 'nyc' } })).toBe('taste');
    expect(routeName({ url: '/api/read/feed', query: { fn: 'feed' } })).toBeNull();
    expect(routeName({ url: '/api/searchx', query: {} })).toBeNull();
    expect(routeName({ url: '/api/read/', query: { fn: '__proto__' } })).toBeNull();
  });
});

describe('/api/traffic is the studio\'s', () => {
  it('answers 401 without a studio session and never caches', async () => {
    const { default: traffic } = await import('../../api/_lib/routes/traffic.js');
    const headers: Record<string, string> = {};
    let status = 0; let body: unknown = null;
    const res = {
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; return res; },
      status(c: number) { status = c; return res; },
      json(b: unknown) { body = b; return res; },
      end() { return res; },
    };
    // a configured studio (a password set) wants its cookie; without one the report is not served
    const had = process.env.STUDIO_PASSWORD;
    process.env.STUDIO_PASSWORD = 'studio-test-password';
    try { await traffic({ method: 'GET', url: '/api/traffic', query: {}, headers: {} } as never, res as never); }
    finally { if (had === undefined) delete process.env.STUDIO_PASSWORD; else process.env.STUDIO_PASSWORD = had; }
    expect(status).toBe(401);
    expect(headers['cache-control']).toBe('no-store');
    expect(body).toMatchObject({ error: expect.stringMatching(/studio/) });
  });
});
