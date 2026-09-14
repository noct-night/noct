/**
 * Postgres access. One code path for local dev, tests and Vercel: node-postgres against DATABASE_URL.
 * On Vercel, DATABASE_URL must be the Supabase Supavisor *transaction* pooler (IPv4, port 6543).
 * Transaction mode means: no session state, no prepared statements — keep every unit of work in withTx().
 */
import pg from 'pg';
import { requireEnv } from './env.js';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const url = requireEnv('DATABASE_URL');
  const local = /@(localhost|127\.0\.0\.1)[:/]|^postgres(?:ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url) || !/@/.test(url);
  pool = new pg.Pool({
    connectionString: url,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Supabase poolers terminate TLS with a certificate chain Node may not have; the connection is still encrypted.
    ssl: local ? undefined : { rejectUnauthorized: false },
    application_name: 'noct',
  });
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
