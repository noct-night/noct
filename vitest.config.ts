import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    env: { TZ: 'UTC' },
    // DB-backed test files share one database (DATABASE_URL). Run files one at a time in that case so the
    // enrichment/ingest tests cannot mutate rows another file is asserting on. Offline runs stay parallel.
    // Live network tests are opt-in: NOCT_LIVE=1 npm test
    fileParallelism: !process.env.DATABASE_URL,
  },
});
