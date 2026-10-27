import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@book/shared': resolve(import.meta.dirname, 'shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
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
