import { describe, expect, it } from 'vitest';
import { routeName } from '../../api/read/[fn].js';

/** The one-function dispatcher behind /api/search, /api/taste, /api/night, /api/ics, /api/health, /api/recommend. */
describe('api/read dispatcher', () => {
  it('names the route from the public path, the rewritten path, or the route segment', () => {
    expect(routeName({ url: '/api/search?q=kobosil', query: { q: 'kobosil' } })).toBe('search');
    expect(routeName({ url: '/api/read/night?e=abc', query: { fn: 'night', e: 'abc' } })).toBe('night');
    expect(routeName({ url: '/api/ics?e=abc', query: { fn: 'ics' } })).toBe('ics');
    expect(routeName({ url: undefined, query: { fn: 'health' } })).toBe('health');
  });
  it('the path wins over a caller-supplied fn, and unknown names are rejected', () => {
    // a caller cannot redirect /api/taste to another handler by adding ?fn=
    expect(routeName({ url: '/api/taste?fn=recommend&city=nyc', query: { fn: ['recommend', 'taste'], city: 'nyc' } })).toBe('taste');
    expect(routeName({ url: '/api/read/feed', query: { fn: 'feed' } })).toBeNull();
    expect(routeName({ url: '/api/searchx', query: {} })).toBeNull();
    expect(routeName({ url: '/api/read/', query: { fn: '__proto__' } })).toBeNull();
  });
});
