/**
 * City registry — the one place that knows which cities NOCT can serve, their time zones and source ids.
 * Mirrored in the `city` table (0011). Ingestion runs for NOCT_CITIES (default: nyc); the feed serves any city
 * that has events. Adding a city = a row here + in 0011 (+ optional venue seed); nothing else is city-specific.
 */
import type { Env } from './env.js';
import { env } from './env.js';

export interface GeoBox { latMin: number; latMax: number; lngMin: number; lngMax: number }
export interface DiceTarget { names: string[]; state: string; bbox: GeoBox }

export interface City {
  key: string;
  name: string;
  country: string;
  tz: string;
  /** Resident Advisor area id (verified live 2026-09-14 via `area(areaUrlName, countryUrlCode)`) */
  raAreaId: number | null;
  /** 19hz.info regional list name (`eventlisting_<region>.php`), when one exists */
  hzRegion: string | null;
  /**
   * DICE targeting. `names` are DICE's own city filters (a metro can be several), and `state` + `bbox` are the
   * sanity check: DICE's city filter leaks — a Giza festival once arrived under New York — so an event counts
   * only when its state matches or its coordinates fall inside the box.
   */
  dice: DiceTarget | null;
  /** short aliases accepted by the API (`?city=`) */
  aliases: string[];
}

export const CITIES: readonly City[] = [
  { key: 'nyc', name: 'New York', country: 'US', tz: 'America/New_York', raAreaId: 8, hzRegion: null, dice: { names: ['New York', 'Brooklyn'], state: 'New York', bbox: { latMin: 40.49, latMax: 40.92, lngMin: -74.27, lngMax: -73.68 } }, aliases: ['new york', 'new-york', 'new_york', 'new york city', 'ny'] },
  { key: 'la', name: 'Los Angeles', country: 'US', tz: 'America/Los_Angeles', raAreaId: 23, hzRegion: 'LosAngeles', dice: { names: ['Los Angeles'], state: 'California', bbox: { latMin: 33.60, latMax: 34.34, lngMin: -118.70, lngMax: -117.60 } }, aliases: ['los angeles', 'los-angeles', 'losangeles'] },
  { key: 'sf', name: 'San Francisco', country: 'US', tz: 'America/Los_Angeles', raAreaId: 218, hzRegion: 'BayArea', dice: null, aliases: ['san francisco', 'bay area', 'bayarea', 'oakland'] },
  { key: 'chi', name: 'Chicago', country: 'US', tz: 'America/Chicago', raAreaId: 17, hzRegion: 'CHI', dice: { names: ['Chicago'], state: 'Illinois', bbox: { latMin: 41.55, latMax: 42.16, lngMin: -88.10, lngMax: -87.44 } }, aliases: ['chicago'] },
  { key: 'mia', name: 'Miami', country: 'US', tz: 'America/New_York', raAreaId: 38, hzRegion: 'Miami', dice: null, aliases: ['miami'] },
  { key: 'dc', name: 'Washington DC', country: 'US', tz: 'America/New_York', raAreaId: 22, hzRegion: 'DC', dice: null, aliases: ['washington', 'washington dc', 'washingtondc'] },
  { key: 'det', name: 'Detroit', country: 'US', tz: 'America/New_York', raAreaId: 19, hzRegion: 'Detroit', dice: null, aliases: ['detroit'] },
  { key: 'tor', name: 'Toronto', country: 'CA', tz: 'America/Toronto', raAreaId: 28, hzRegion: 'Toronto', dice: null, aliases: ['toronto'] },
  { key: 'ldn', name: 'London', country: 'UK', tz: 'Europe/London', raAreaId: 13, hzRegion: null, dice: null, aliases: ['london'] },
  { key: 'ber', name: 'Berlin', country: 'DE', tz: 'Europe/Berlin', raAreaId: 34, hzRegion: null, dice: null, aliases: ['berlin'] },
];

export const DEFAULT_CITY = 'nyc';
const BY_KEY: ReadonlyMap<string, City> = new Map(CITIES.map((c) => [c.key, c]));

export function getCity(key: string): City {
  const c = BY_KEY.get(key);
  if (!c) throw new Error(`Unknown city "${key}". Known: ${CITIES.map((x) => x.key).join(', ')}`);
  return c;
}

/** Resolve a user-facing value ('la', 'Los Angeles', 'new york') to a city; null when nothing matches. */
export function findCity(value: string | null | undefined): City | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  return CITIES.find((c) => c.key === v || c.name.toLowerCase() === v || c.aliases.includes(v)) ?? null;
}

/** NOCT_CITIES=nyc,la → the cities ingestion covers (always at least the default). Unknown keys throw. */
export function enabledCityKeys(e: Env = process.env): string[] {
  const raw = env('NOCT_CITIES', DEFAULT_CITY, e) as string;
  const keys = [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  for (const k of keys) getCity(k);
  return keys.length ? keys : [DEFAULT_CITY];
}
