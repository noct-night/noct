/**
 * One night as an iCalendar file.
 *
 * .ics rather than a Google Calendar link because it is the one format every calendar imports: iOS Safari
 * opens it straight into the native "Add to Calendar" sheet, Google Calendar and Outlook import it, and no
 * platform sniffing is needed. The output is deliberately plain RFC 5545 — UTC times, folded lines, escaped
 * text — because calendar parsers are unforgiving and the failures are silent.
 */
import { query } from '../lib/db.js';
import { FeedParamError } from './query.js';

const SITE = 'https://noct.pro';
/** a club night without a stated end runs about this long */
const DEFAULT_HOURS = 5;

export interface IcsRow {
  event_id: string; title: string; night: string; starts_at: string | null; ends_at: string | null; has_time: boolean;
  venue_name: string | null; address: string | null; city: string | null; lineup: string[] | null; description: string | null;
}

const ICS_SQL = `
  select f.event_id::text, f.title, f.night::text as night, f.starts_at, f.ends_at, f.has_time,
         f.venue_name, v.address, f.city, f.lineup, f.description
  from event_feed f left join venue v on v.venue_id = f.venue_id
  where f.event_id = $1::uuid`;

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline are escaped in TEXT values. */
export function icsText(s: string | null | undefined): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 §3.1: lines longer than 75 octets are folded with CRLF + one space. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let buf = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > 75) { out.push(buf); buf = ' '; bytes = 1; }
    buf += ch; bytes += b;
  }
  out.push(buf);
  return out.join('\r\n');
}

const utc = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const ymd = (night: string): string => night.replace(/-/g, '');
const nextDay = (night: string): string => {
  const d = new Date(`${night}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d.toISOString().slice(0, 10));
};

export function buildIcs(r: IcsRow, now: Date = new Date()): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NOCT//noct.pro//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${r.event_id}@noct.pro`,
    `DTSTAMP:${utc(now)}`,
  ];
  if (r.has_time && r.starts_at) {
    const start = new Date(r.starts_at);
    const end = r.ends_at ? new Date(r.ends_at) : new Date(start.getTime() + DEFAULT_HOURS * 3_600_000);
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
  } else {
    // no door time on record: an all-day marker on the night, not a made-up hour
    lines.push(`DTSTART;VALUE=DATE:${ymd(r.night)}`, `DTEND;VALUE=DATE:${nextDay(r.night)}`);
  }
  const where = [r.venue_name, r.address].filter(Boolean).join(', ');
  const link = `${SITE}/?e=${r.event_id}&city=${encodeURIComponent(r.city ?? 'nyc')}&from=${r.night}&to=${r.night}`;
  const details = [
    r.lineup?.length ? `Line-up: ${r.lineup.join(', ')}` : '',
    r.description ? r.description.slice(0, 600) : '',
    link,
  ].filter(Boolean).join('\n\n');
  lines.push(`SUMMARY:${icsText(r.title)}`);
  if (where) lines.push(`LOCATION:${icsText(where)}`);
  lines.push(`DESCRIPTION:${icsText(details)}`, `URL:${link}`, 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

export async function icsFor(id: string | undefined): Promise<{ filename: string; body: string }> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new FeedParamError('e must be an event uuid');
  const res = await query<IcsRow>(ICS_SQL, [id]);
  const r = res.rows[0];
  if (!r) throw new FeedParamError('no such event');
  const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'night';
  return { filename: `noct-${slug}-${r.night}.ics`, body: buildIcs(r) };
}
