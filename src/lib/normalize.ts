/**
 * Text normalisation shared by adapters. The database owns the authoritative versions
 * (norm_text / norm_title / parse_lineup_item in 0002_core.sql); these are lighter TS mirrors used
 * for pre-cleaning source payloads and for offline tests.
 */
import { createHash } from 'node:crypto';

export function stripAccents(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** lower, strip accents, collapse non-alphanumerics to single spaces. */
export function normText(s: string | null | undefined): string {
  if (!s) return '';
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Collapse whitespace, decode a few HTML entities, trim. */
export function cleanText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&#8211;|&ndash;/g, '–').replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8216;|&lsquo;/g, '‘').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const B2B_SPLIT = /\s+(?:b2b|b3b|b4b|vs\.?|versus)\s+/i;
const LIVE_RE = /\((?:live|hybrid(?: set)?|live set|live pa)\)|\b(?:live|live set|hybrid set)\s*$/i;
const NOISE_RE = /\s*\b(?:all night(?: long)?|all day(?: long)?|extended set|open to close|dj set|hybrid set|live set|live|closing set|opening set)\b\s*$/i;

export interface LineupItem {
  name: string;
  isLive: boolean;
  /** ISO-ish country hint from "(US)", "(UK)" */
  disambig: string | null;
  /** items that came from the same "A b2b B" group share a groupIndex */
  groupIndex: number;
}

/** Split one billing line ("A b2b B (live)") into artists. Keeps display casing; strips qualifiers. */
export function parseLineupItem(item: string, groupIndex = 0): LineupItem[] {
  return item
    .split(B2B_SPLIT)
    .map((part) => {
      const isLive = LIVE_RE.test(part);
      const dis = /\((US|UK|DE|FR|IT|ES|NL|BE|JP|AU|CA|BR|MX|AR|CL|CO|ZA|IE|PT|PL|SE|NO|DK|FI|CH|AT|RU|IL|TR|KR|CN|IN|NZ|GR|CZ|HU|RO|UA|LT|LV|EE|GE|AM|AZ)\)/i.exec(part);
      const name = part.replace(/\s*\([^)]*\)/g, ' ').replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
      return { name, isLive, disambig: dis ? dis[1]!.toUpperCase() : null, groupIndex };
    })
    .filter((x) => x.name.length > 0);
}

/** Flatten a list of billing lines into distinct artist display names, preserving order. */
export function flattenLineup(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  items.forEach((it, i) => {
    for (const a of parseLineupItem(it, i)) {
      const k = normText(a.name);
      if (k && !seen.has(k)) { seen.add(k); out.push(a.name); }
    }
  });
  return out;
}

/** "$22.66", "$5-$30", "10.00", "From $38.17" -> [min, max] in dollars; nulls when nothing parses. */
export function parseMoneyRange(text: string | null | undefined): [number | null, number | null] {
  if (!text) return [null, null];
  const nums = [...text.matchAll(/\$?\s*(\d{1,4}(?:\.\d{1,2})?)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
  if (/\bfree\b|\brsvp\b/i.test(text) && !nums.some((n) => n > 0)) return [0, 0];
  if (!nums.length) return [null, null];
  return [Math.min(...nums), Math.max(...nums)];
}

/** "21+", "This is a 21+ event.", "18 & over" -> 21 / 18; "All Ages" -> 0; null when unknown. */
export function parseAge(text: string | null | undefined): number | null {
  if (!text) return null;
  if (/all\s*ages/i.test(text)) return 0;
  const m = /(\d{2})\s*(?:\+|&\s*(?:over|up)|and\s*(?:over|up)|\s*plus)/i.exec(text);
  return m ? Number(m[1]) : null;
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function cents(n: number | null | undefined): number | null {
  return n === null || n === undefined ? null : Math.round(n) / 100;
}
