#!/usr/bin/env tsx
/**
 * NOCT command line.
 *
 *   npm run fetch -- ra --limit 5           # run one adapter, print normalised listings (no database)
 *   npm run fetch -- dice --json > out.json
 *   npm run ingest -- ra dice               # fetch + upsert + resolve into DATABASE_URL
 *   npm run ingest -- all
 *   npm run enrich -- --limit 50            # genre/vibe pass over events needing it
 *   npm run noct -- tracks --limit 400      # representative tracks for artists on upcoming nights (iTunes Search)
 *   npm run clip -- night.mov --len 30 --title "SACRO"   # cut a reel, queue it in the studio
 */
import { parseArgs } from 'node:util';
import { getAdapter } from './sources/registry.js';
import { createLogger } from './lib/log.js';
import { localDatePlus } from './lib/time.js';
import type { FetchContext } from './sources/types.js';

const log = createLogger('cli');

async function main(argv: string[]): Promise<number> {
  // `clip` is delegated before the shared parser runs, because it has a dozen flags of its own (--framing,
  // --title, --cover-at) and folding them in here would make `fetch --help` describe options it ignores.
  if (argv[0] === 'clip') {
    const { runClip } = await import('./video/command.js');
    return runClip(argv.slice(1), log.child('clip'));
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string' },
      days: { type: 'string', default: '30' },
      from: { type: 'string' },
      to: { type: 'string' },
      json: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    console.log('usage: noct <fetch|ingest|enrich|tracks|clip> [sources...] [--limit N] [--days N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json] [--raw] [--force]');
    return cmd ? 0 : 1;
  }
  const limit = values.limit ? Number(values.limit) : undefined;
  const fromDate = values.from ?? localDatePlus(0);
  const toDate = values.to ?? localDatePlus(Number(values.days ?? 30));

  if (cmd === 'fetch') {
    const key = rest[0];
    if (!key) throw new Error('fetch needs a source key');
    const adapter = getAdapter(key);
    const st = adapter.enabled(process.env);
    if (!st.ok) log.warn(`adapter "${key}" reports disabled: ${st.reason} (running anyway for a dry run)`);
    const ctx: FetchContext = { env: process.env, log: log.child(key), fromDate, toDate, limit };
    const t0 = Date.now();
    const res = await adapter.fetch(ctx);
    const ms = Date.now() - t0;
    if (values.json) {
      console.log(JSON.stringify(values.raw ? res : { ...res, listings: res.listings.map(({ raw: _raw, ...l }) => l) }, null, 2));
    } else {
      for (const l of res.listings) {
        console.log(
          [
            l.night ?? l.startsAt?.slice(0, 10) ?? '????-??-??',
            (l.startsAt ?? '').slice(11, 16).padEnd(5),
            l.title.slice(0, 60).padEnd(60),
            (l.venueName ?? '').slice(0, 24).padEnd(24),
            l.priceMin === null ? '' : `$${l.priceMin}`,
            l.soldOut ? 'SOLD OUT' : '',
            l.genres.join('/'),
          ].join('  '),
        );
      }
      console.log(`\n${res.listings.length} listings from ${key} in ${ms}ms; window=${JSON.stringify(res.window)}; warnings=${res.warnings.length}`);
      for (const w of res.warnings) console.log(`  ! ${w}`);
    }
    return 0;
  }

  if (cmd === 'ingest') {
    const { runIngest } = await import('./ingest/run.js');
    const sources = rest.length && rest[0] !== 'all' ? rest : [];
    const summary = await runIngest({ sources, fromDate, toDate, limit, log: log.child('ingest') });
    console.log(JSON.stringify(summary, null, 2));
    const { closePool } = await import('./lib/db.js');
    await closePool();
    return summary.runs.some((r) => r.status === 'failed') ? 2 : 0;
  }

  if (cmd === 'tracks') {
    const { resolveArtistTracks } = await import('./enrich/artist_tracks.js');
    const summary = await resolveArtistTracks({ limit, budgetMs: 6 * 3_600_000, log: log.child('tracks') });
    console.log(JSON.stringify(summary, null, 2));
    const { closePool } = await import('./lib/db.js');
    await closePool();
    return summary.errors ? 2 : 0;
  }

  if (cmd === 'enrich') {
    const { runEnrichment } = await import('./enrich/run.js');
    const summary = await runEnrichment({ limit, force: values.force, log: log.child('enrich') });
    console.log(JSON.stringify(summary, null, 2));
    const { closePool } = await import('./lib/db.js');
    await closePool();
    return summary.errors.length ? 2 : 0;
  }

  throw new Error(`unknown command ${cmd}`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
