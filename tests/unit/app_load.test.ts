import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * app.js has no test coverage of its own; this at least proves it LOADS. A top-level ReferenceError (a `let`
 * dropped by an edit, a helper used before it exists) kills the whole client -- every render path throws --
 * and `node --check` cannot see it because the syntax is fine.
 *
 * The script runs inside a `with` scope backed by a Proxy: any BROWSER name it reaches for (document, window,
 * MutationObserver, …) resolves to a permissive stub; every name the script declares itself is left alone, so
 * a missing declaration still throws exactly as it would in a browser. `?demo=1` keeps it off the network.
 */
function stub(): any {
  const fn: any = function stubFn() { return stub(); };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;
      if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === 'querySelectorAll' || prop === 'children') return prop === 'children' ? [] : () => [];
      if (prop === 'textContent' || prop === 'innerHTML' || prop === 'innerText' || prop === 'value' || prop === 'search') return '';
      if (prop === 'hidden' || prop === 'disabled' || prop === 'paused') return false;
      if (prop === 'length' || prop === 'scrollTop' || prop === 'offsetTop' || prop === 'scrollHeight') return 0;
      if (prop === 'getItem') return () => null;
      if (prop === 'matches') return () => false;
      return stub();
    },
    set() { return true; },
    apply() { return stub(); },
    construct() { return stub(); },
    has() { return true; },
  });
}

describe('app.js loads', () => {
  it('evaluates top to bottom without a ReferenceError', () => {
    const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
    const declared = new Set([...src.matchAll(/^(?:let|const|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1] as string));
    const location = { search: '?demo=1', origin: 'https://noct.pro', pathname: '/', protocol: 'https:', hostname: 'noct.pro', href: 'https://noct.pro/' };
    // browser-only names, and a few Node also has but must not really run here
    // what the script defers to the next tick or frame runs once the script has loaded, as the first frame would
    const later: (() => void)[] = [];
    const defer = (cb: unknown) => { if (typeof cb === 'function') later.push(cb as () => void); return 0; };
    const provided: Record<string, unknown> = {
      location, fetch: () => new Promise(() => {}), setTimeout: defer, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
      requestAnimationFrame: defer, navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };
    // The browser names the script may reach for. Only these are stubbed; any other undeclared name falls through
    // and throws, which is the point -- a dropped `let` must not be quietly stubbed into existence. A new browser
    // API in app.js means one more name here.
    const browser = new Set([...Object.keys(provided), 'document', 'window', 'history', 'addEventListener', 'removeEventListener', 'dispatchEvent',
      'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'matchMedia', 'getComputedStyle', 'scrollTo', 'open', 'alert', 'prompt', 'confirm',
      'Audio', 'Image', 'Event', 'CustomEvent', 'KeyboardEvent', 'PointerEvent', 'HTMLElement', 'Element', 'Node', 'AbortController', 'AbortSignal',
      'requestIdleCallback', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'crypto', 'performance', 'screen',
      'innerWidth', 'innerHeight', 'devicePixelRatio', 'visualViewport', 'TextEncoder', 'TextDecoder', 'L', 'gsap']);
    const scope = new Proxy({}, {
      has: (_t, k) => typeof k === 'string' && browser.has(k) && !declared.has(k),
      // `with` reads scope[Symbol.unscopables] and skips any name it marks truthy: a stub there would hide everything
      get: (_t, k) => (typeof k !== 'string' ? undefined : k in provided ? provided[k] : stub()),
    });
    const errors: string[] = [];
    const run = new Function('__scope', '__errors', `with (__scope) { try { ${src} } catch (e) { __errors.push(String((e && e.stack) || e)); } }`);
    run(scope, errors);
    for (const cb of later.splice(0)) { try { cb(); } catch (e) { errors.push(String((e && (e as Error).stack) || e)); } }
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
