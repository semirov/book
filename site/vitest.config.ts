import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // BOOK-109: the values a build bakes in, fixed here so a unit test can pin the printed text.
  define: {
    __BUILD_COMMIT__: JSON.stringify('test'),
    __BUILD_STAMP__: JSON.stringify('01.01 00:00'),
  },
  resolve: {
    alias: {
      '@book/shared': resolve(import.meta.dirname, 'shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // BOOK-81: threads, not the default forks. A killed `vitest run` (an agent timeout sends
    // `kill -9`) left its forked workers with parent 1 — 18 counted at 36–760 MB each — and no
    // teardown hook runs on SIGKILL, so the pool itself has to be the guarantee: a thread dies
    // with its process. Measured on this suite: 6 orphans on forks, 0 on threads; 323 files /
    // 3162 tests green on both (real better-sqlite3 connections included), 26.7s → 21.6s. After
    // a run: `npm run check:orphans`.
    pool: 'threads',
    // The suite's environment, in one place (BOOK-107): a fresh temp DATA_DIR per test file,
    // and a before/after snapshot of the dev and production data dirs, so a test that writes
    // to either one turns the run red.
    globalSetup: [resolve(import.meta.dirname, 'test/globalSetup.ts')],
    setupFiles: [resolve(import.meta.dirname, 'test/setup.ts')],
    // Stylesheets are read as text (`styles/*.css?raw`): the prose measure is an invariant
    // the page-2 test checks, and Vitest stubs CSS imports to '' without this.
    css: true,
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['shared/src/**/*.ts', 'server/src/**/*.ts', 'web/src/lib/**/*.ts', 'web/src/api.ts'],
      exclude: ['shared/src/protocol.ts', 'server/src/index.ts', 'server/src/engine.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
});
