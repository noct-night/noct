/**
 * The traffic report: who came, from where, and whether they came back -- read from NOCT's own tables (0030),
 * not from a third party. Everything here is an aggregate over anonymous accounts.
 *
 * Numbers are for a window (30 days by default) with a seven-day slice beside them, days are New York days so
 * a Saturday night counts as Saturday, and the funnel is distinct devices: visited -> opened a night -> saved
 * or going -> set a taste -> made or joined a plan. `devices` is distinct anonymous accounts, which is one per
 * browser rather than one per person; the word is chosen so nobody reads it as people.
 */
import { query } from '../lib/db.js';

export const WINDOW_DAYS = 30;
export const RECENT_DAYS = 7;
export const DAILY_DAYS = 14;
const DAY_TZ = 'America/New_York';

export interface TrafficCount { key: string; visits: number; devices: number }
export interface TrafficReport {
  generated_at: string;
  window_days: number;
  visits: { recent: number; window: number };
  devices: { recent: number; window: number; new_recent: number; new_window: number };
  /** share of the window's devices seen on two or more different days, in percent */
  returning_share: number;
  daily: { day: string; visits: number; devices: number }[];
  /** utm_source when the link carried one, otherwise the referrer folded to a name ("instagram", "direct") */
  sources: TrafficCount[];
  campaigns: { source: string; medium: string | null; campaign: string | null; visits: number }[];
  entry: TrafficCount[];
  city: TrafficCount[];
  device: TrafficCount[];
  lang: TrafficCount[];
  standalone: number;
  actions: TrafficCount[];
  funnel: { visited: number; opened_a_night: number; saved_or_going: number; set_taste: number; planned: number };
}

/**
 * A referrer host as a name worth reading. Instagram's in-app browser sends no referrer at all, so the client
 * writes `app.instagram` when the user agent says Instagram; the same fold catches l.instagram.com.
 */
export function foldRef(host: string | null | undefined): string {
  if (!host) return 'direct';
  const h = host.toLowerCase();
  if (h === 'app.instagram' || /(^|\.)instagram\.com$/.test(h)) return 'instagram';
  if (h === 'app.facebook' || h === 'fb.me' || /(^|\.)facebook\.com$/.test(h)) return 'facebook';
  if (h === 't.co' || /(^|\.)(twitter|x)\.com$/.test(h)) return 'x';
  if (/(^|\.)tiktok\.com$/.test(h)) return 'tiktok';
  if (/(^|\.)reddit\.com$/.test(h)) return 'reddit';
  if (/(^|\.)google\.[a-z.]+$/.test(h)) return 'google';
  if (/(^|\.)(bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org)$/.test(h)) return 'search';
  if (/(^|\.)linktr\.ee$/.test(h)) return 'linktree';
  if (/(^|\.)(discord\.com|discordapp\.com)$/.test(h)) return 'discord';
  if (/(^|\.)vercel\.app$/.test(h)) return 'preview';
  return h;
}

const W = 'make_interval(days => $1::int)';
const R = 'make_interval(days => $2::int)';

const TOTALS_SQL = `
  select count(*) filter (where at >= now() - ${R}) as visits_recent, count(*) as visits_window,
         count(distinct user_id) filter (where at >= now() - ${R}) as devices_recent, count(distinct user_id) as devices_window
  from visit where at >= now() - ${W}`;

const NEW_SQL = `
  select count(*) filter (where first_at >= now() - ${R}) as new_recent, count(*) as new_window
  from (select user_id, min(at) as first_at from visit group by 1) f
  where first_at >= now() - ${W}`;

const RETURNING_SQL = `
  select count(*) filter (where days >= 2) as returning, count(*) as devices
  from (select user_id, count(distinct (at at time zone '${DAY_TZ}')::date) as days
        from visit where at >= now() - ${W} group by 1) d`;

const DAILY_SQL = `
  select to_char((at at time zone '${DAY_TZ}')::date, 'YYYY-MM-DD') as day, count(*) as visits, count(distinct user_id) as devices
  from visit where at >= (now() at time zone '${DAY_TZ}')::date - ($1::int - 1)
  group by 1 order by 1`;

const dim = (expr: string) => `
  select ${expr} as key, count(*) as visits, count(distinct user_id) as devices
  from visit where at >= now() - ${W} group by 1 order by 2 desc, 1`;
const SOURCE_SQL = dim(`coalesce(nullif(lower(utm_source), ''), ref, '')`);
const ENTRY_SQL = dim('entry');
const CITY_SQL = dim(`coalesce(city, '')`);
const DEVICE_SQL = dim(`coalesce(device, '')`);
const LANG_SQL = dim(`coalesce(lower(split_part(lang, '-', 1)), '')`);
const STANDALONE_SQL = `select count(*) as n from visit where standalone and at >= now() - ${W}`;
const CAMPAIGN_SQL = `
  select lower(utm_source) as source, nullif(lower(utm_medium), '') as medium, nullif(lower(utm_campaign), '') as campaign, count(*) as visits
  from visit where at >= now() - ${W} and nullif(utm_source, '') is not null
  group by 1, 2, 3 order by 4 desc, 1 limit 12`;

const ACTIONS_SQL = `
  select kind as key, count(*) as visits, count(distinct user_id) as devices
  from action where at >= now() - ${W} group by 1 order by 2 desc, 1`;

const FUNNEL_SQL = `
  with v as (select distinct user_id from visit where at >= now() - ${W})
  select count(*) as visited,
         count(*) filter (where exists (select 1 from action a where a.user_id = v.user_id and a.kind = 'event_open' and a.at >= now() - ${W})) as opened_a_night,
         count(*) filter (where exists (select 1 from saved s where s.user_id = v.user_id and s.created_at >= now() - ${W})
                             or exists (select 1 from going g where g.user_id = v.user_id and g.created_at >= now() - ${W})) as saved_or_going,
         count(*) filter (where exists (select 1 from profile p where p.user_id = v.user_id and coalesce(cardinality(p.taste_genres), 0) > 0)) as set_taste,
         count(*) filter (where exists (select 1 from group_session gs where gs.owner_id = v.user_id and gs.created_at >= now() - ${W})
                             or exists (select 1 from group_vote gv where gv.user_id = v.user_id and gv.created_at >= now() - ${W})) as planned
  from v`;

type Row = Record<string, string | number | null>;
const n = (v: unknown): number => Number(v ?? 0);
const counts = (rows: Row[], fold: (k: string) => string = (k) => k || 'unknown', limit = 12): TrafficCount[] => {
  const acc = new Map<string, TrafficCount>();
  for (const r of rows) {
    const key = fold(String(r.key ?? ''));
    const cur = acc.get(key) ?? { key, visits: 0, devices: 0 };
    cur.visits += n(r.visits);
    cur.devices += n(r.devices);   // devices can double-count across folded hosts; close enough for a fold of a few
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key)).slice(0, limit);
};

/** every one of the last `days` New York days, zero-filled, oldest first */
export function fillDays(rows: { day: string; visits: number; devices: number }[], days: number, today: string): TrafficReport['daily'] {
  const have = new Map(rows.map((r) => [r.day, r]));
  const out: TrafficReport['daily'] = [];
  const t = new Date(`${today}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(t.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const r = have.get(d);
    out.push({ day: d, visits: r ? n(r.visits) : 0, devices: r ? n(r.devices) : 0 });
  }
  return out;
}

export async function trafficReport(windowDays = WINDOW_DAYS): Promise<TrafficReport> {
  const pw = [windowDays];                       // window only
  const pr = [windowDays, RECENT_DAYS];          // window and the recent slice
  const [totals, fresh, ret, daily, source, entry, city, device, lang, standalone, campaigns, actions, funnel, today] = await Promise.all([
    query<Row>(TOTALS_SQL, pr), query<Row>(NEW_SQL, pr), query<Row>(RETURNING_SQL, pw),
    query<Row>(DAILY_SQL, [DAILY_DAYS]),
    query<Row>(SOURCE_SQL, pw), query<Row>(ENTRY_SQL, pw), query<Row>(CITY_SQL, pw), query<Row>(DEVICE_SQL, pw), query<Row>(LANG_SQL, pw),
    query<Row>(STANDALONE_SQL, pw), query<Row>(CAMPAIGN_SQL, pw), query<Row>(ACTIONS_SQL, pw), query<Row>(FUNNEL_SQL, pw),
    query<Row>(`select to_char((now() at time zone '${DAY_TZ}')::date, 'YYYY-MM-DD') as day`),
  ]);
  const t = totals.rows[0] ?? {};
  const f = fresh.rows[0] ?? {};
  const r = ret.rows[0] ?? {};
  const fu = funnel.rows[0] ?? {};
  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    visits: { recent: n(t.visits_recent), window: n(t.visits_window) },
    devices: { recent: n(t.devices_recent), window: n(t.devices_window), new_recent: n(f.new_recent), new_window: n(f.new_window) },
    returning_share: n(r.devices) ? Math.round((n(r.returning) / n(r.devices)) * 1000) / 10 : 0,
    daily: fillDays(daily.rows as never, DAILY_DAYS, String(today.rows[0]?.day)),
    // a utm_source is a name and stands as written; a host (has a dot) or nothing at all is folded
    sources: counts(source.rows, (k) => (k && !k.includes('.') ? k : foldRef(k || null))),
    campaigns: campaigns.rows.map((c) => ({ source: String(c.source), medium: c.medium == null ? null : String(c.medium), campaign: c.campaign == null ? null : String(c.campaign), visits: n(c.visits) })),
    entry: counts(entry.rows),
    city: counts(city.rows),
    device: counts(device.rows),
    lang: counts(lang.rows, (k) => k || 'unknown', 6),
    standalone: n(standalone.rows[0]?.n),
    actions: counts(actions.rows, (k) => k, 32),
    funnel: { visited: n(fu.visited), opened_a_night: n(fu.opened_a_night), saved_or_going: n(fu.saved_or_going), set_taste: n(fu.set_taste), planned: n(fu.planned) },
  };
}

/** the report as a few lines for a terminal (`npm run noct -- traffic`) */
export function formatTraffic(t: TrafficReport): string {
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  const list = (rows: TrafficCount[], k = 6) => rows.slice(0, k).map((r) => `${r.key} ${r.visits}`).join(' · ') || '-';
  const bar = (v: number, max: number) => '#'.repeat(max ? Math.round((v / max) * 24) : 0);
  const max = Math.max(1, ...t.daily.map((d) => d.visits));
  return [
    `traffic · last ${t.window_days} days (7-day slice in brackets)`,
    `visits ${t.visits.window} [${t.visits.recent}] · devices ${t.devices.window} [${t.devices.recent}] · new devices ${t.devices.new_window} [${t.devices.new_recent}] · returning ${t.returning_share}% · home screen ${t.standalone}`,
    '',
    ...t.daily.map((d) => `${d.day.slice(5)}  ${String(d.visits).padStart(4)} ${bar(d.visits, max)}`),
    '',
    `sources   ${list(t.sources)}`,
    `entry     ${list(t.entry)}`,
    `city      ${list(t.city)}`,
    `device    ${list(t.device)}`,
    `language  ${list(t.lang)}`,
    ...(t.campaigns.length ? [`campaigns ${t.campaigns.map((c) => `${[c.source, c.medium, c.campaign].filter(Boolean).join('/')} ${c.visits}`).join(' · ')}`] : []),
    `actions   ${list(t.actions, 12)}`,
    `funnel    visited ${t.funnel.visited} → opened a night ${t.funnel.opened_a_night} (${pct(t.funnel.opened_a_night, t.funnel.visited)}) → saved/going ${t.funnel.saved_or_going} (${pct(t.funnel.saved_or_going, t.funnel.visited)}) → taste ${t.funnel.set_taste} (${pct(t.funnel.set_taste, t.funnel.visited)}) → plan ${t.funnel.planned} (${pct(t.funnel.planned, t.funnel.visited)})`,
  ].join('\n');
}
