import type { Env } from '../lib/env.js';
import { env } from '../lib/env.js';
import type { SourceAdapter, SourceKey } from './types.js';
import { ra } from './ra.js';
import { dice } from './dice.js';
import { elsewhere } from './elsewhere.js';
import { goodroom } from './goodroom.js';
import { publicrecords } from './publicrecords.js';
import { ticketmaster } from './ticketmaster.js';
import { edmtrain } from './edmtrain.js';
import { silo } from './silo.js';
import { hz19 } from './hz19.js';

/** Order = default run order. Priorities live on each adapter. */
export const ADAPTERS: SourceAdapter[] = [ra, dice, elsewhere, goodroom, publicrecords, silo, hz19, ticketmaster, edmtrain];

export function getAdapter(key: string): SourceAdapter {
  const a = ADAPTERS.find((x) => x.key === key);
  if (!a) throw new Error(`Unknown source "${key}". Known: ${ADAPTERS.map((x) => x.key).join(', ')}`);
  return a;
}

/** Adapters selected by NOCT_SOURCES (or all) that also have their prerequisites (keys) satisfied. */
export function enabledAdapters(e: Env = process.env, only?: string[]): { run: SourceAdapter[]; skipped: { key: SourceKey; reason: string }[] } {
  const wanted = only?.length ? only : (env('NOCT_SOURCES', undefined, e)?.split(',').map((s) => s.trim()).filter(Boolean) ?? ADAPTERS.map((a) => a.key));
  const run: SourceAdapter[] = [];
  const skipped: { key: SourceKey; reason: string }[] = [];
  for (const key of wanted) {
    const a = getAdapter(key);
    const st = a.enabled(e);
    if (st.ok) run.push(a);
    else skipped.push({ key: a.key, reason: st.reason });
  }
  return { run, skipped };
}
