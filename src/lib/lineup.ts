/**
 * Pull a line-up out of an event title.
 *
 * 19hz is a text table — one row is "Title @ Venue (City)" and nothing else — so it carries no line-up field
 * at all, and it is the dominant source outside New York: 550 upcoming listings, 0 with a line-up. But the
 * artists are usually right there in the title ("Minimal Madness Ft. Zack Darza", "Niteharts: Isoxo, Jane
 * Remover, Frost Children"), so the title is the line-up field.
 *
 * Precision over recall, deliberately. These names become rows in `artist` and feed recommendations, so a
 * wrong split is worse than a missing one: "Pilsen Stand-Up Presents: Comedy Showcase En Tu Idioma" must stay
 * one title, not become an artist called "Comedy Showcase En Tu Idioma". b2b / vs splitting and (live) /
 * country suffixes are NOT handled here — `parse_lineup_item()` already does that downstream.
 */

/** Markers that almost always introduce performers rather than a show name. */
const FEAT = /\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s+w\/\s*/i;
/** "Party: A, B, C" is a line-up; "Party: One Show Name" is a title. Only the list form is taken. */
const COLON = /(?:\s+[-–—]\s+|\s*:\s*)/;
/* 19hz separates a bill with commas, pipes, asterisks or plus signs -- "Satoshi Tomiie * Garrett David". */
const SPLIT = /\s*(?:,|\||·|\*|\+|\s+&\s+|\s+and\s+|\s+[-–—]\s+|\s*\/\s*)\s*/i;

/** Phrases that are event furniture, never a performer. */
// \b, not \m: \m is PostgreSQL's word boundary and in JavaScript it is a literal "m", which made this whole
// filter a no-op until "House Dance Party" and "Rsvp" turned up in the artist table.
const NOT_A_NAME = new RegExp(
  '\\b(' + [
    'comedy show(case)?', 'stand[- ]?up', 'showcase', 'rooftop session', 'day party', 'after ?party',
    'free', 'rsvp', 'tickets?', 'sold out', 'open to close', 'all night long', 'more', 'guests?',
    'the album', 'listening (party|session)', 'release party', 'birthday', 'anniversary', 'edition',
    'presented by', 'season', 'vol\\.?', 'part (i|ii|iii|\\d)', 'night', 'party', 'sessions?',
    'memorial', 'ballroom', 'theat(re|er)', 'lounge', 'sets', 'fundraiser', 'benefit', 'market', 'fair',
    'mondays?', 'tuesdays?', 'wednesdays?', 'thursdays?', 'fridays?', 'saturdays?', 'sundays?', 'weekends?',
  ].join('|') + ')\\b', 'i');

const MAX_ITEMS = 15;
const MAX_NAME = 40;
const MIN_NAME = 2;

function clean(s: string): string {
  return s
    // a colon FOLLOWED BY A SPACE is a series or venue prefix ("Montecito 2026: Chainsmokers"); a colon
    // inside a word is part of the name (re:ni, Blu:sh, BLOND:ISH, 19:26), so only the spaced form is cut
    .replace(/^[^:]{2,40}:\s+/, '')
    .replace(/\([^)]*\)/g, ' ')          // "(Rooftop Session)", "(21+)"
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;.,&|]+|[\s\-–—:;.,&|]+$/g, '')
    .trim();
}

function plausible(name: string): boolean {
  if (!/[a-z]/i.test(name)) return false;                 // "2026", "///"
  if (/@|https?:|\d{1,2}\s*[/-]\s*\d{1,2}/.test(name)) return false;   // venues, urls, dates
  if (NOT_A_NAME.test(name)) return false;
  // "A b2b B" is one slot on the bill; parse_lineup_item() splits it downstream, so judge the halves here
  // rather than the whole, or every back-to-back reads as a sentence and is thrown away.
  const parts = name.split(/\s+(?:b2b|b3b|b4b|vs\.?|versus)\s+/i);
  return parts.every((p) => {
    const t = p.trim();
    return t.length >= MIN_NAME && t.length <= MAX_NAME && t.split(/\s+/).length <= 5;
  });
}

export interface TitleLineup {
  /** the part of the title that is not the line-up; never empty */
  headline: string;
  /** performer names in title order, already de-duplicated */
  lineup: string[];
}

export function lineupFromTitle(raw: string | null | undefined): TitleLineup {
  const title = (raw ?? '').trim();
  if (!title) return { headline: '', lineup: [] };

  let head = title;
  let tail = '';
  const feat = FEAT.exec(title);
  if (feat && feat.index > 0) {
    head = title.slice(0, feat.index);
    tail = title.slice(feat.index + feat[0].length);
  } else {
    // A colon list only counts when the tail really is a list; a single name after a colon is a show title.
    const m = COLON.exec(title);
    if (!m || m.index <= 0) return { headline: title, lineup: [] };
    const rest = title.slice(m.index + m[0].length);
    if (!/,|\bb2b\b|\|/i.test(rest)) return { headline: title, lineup: [] };
    head = title.slice(0, m.index);
    tail = rest;
  }

  const seen = new Set<string>();
  const lineup: string[] = [];
  for (const part of tail.split(SPLIT)) {
    const name = clean(part);
    if (!plausible(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lineup.push(name);
    if (lineup.length >= MAX_ITEMS) break;
  }
  // One survivor out of a long tail means the split found furniture, not a bill.
  if (!lineup.length) return { headline: title, lineup: [] };
  return { headline: clean(head) || title, lineup };
}

/**
 * When a title IS the act — "Ian Asher", "Green Velvet", "Fedde Le Grand" — there is no line-up to parse and
 * the reader can plainly see the artist the app claims not to know.
 *
 * This is for DISPLAY ONLY and must never reach `event.lineup` or the `artist` table. On a sample of bare
 * titles about three in four are real acts and the rest are things like "Reggaeton Fridays", "Scott Guerin
 * Memorial" and "Spothero Aragon Ballroom" — good enough to offer a tap, nowhere near good enough to write a
 * row that recommendations will then treat as a fact.
 */
export function actFromTitle(raw: string | null | undefined): string | null {
  const title = (raw ?? '').trim();
  if (!title) return null;
  // a title with a line-up marker is lineupFromTitle()'s job, not this one
  if (FEAT.test(title) || /[:|*]|\sb2b\s/i.test(title)) return null;
  // "& Friends", "Live", "All Night" describe the booking, not the booked: "Gianni Blu & Friends" is Gianni Blu
  const name = clean(title).replace(/\s+(?:&|and|b2b)\s+friends$|\s+(?:live|all night(?: long)?|dj set|extended set)$/i, '').trim();
  if (!plausible(name)) return null;
  if (name.split(/\s+/).length > 4) return null;
  // a trailing edition number is a series, not a person: "Various Distractions 002", "Deep Tech 38"
  if (/\s\d{1,4}$/.test(name)) return null;
  return name;
}
