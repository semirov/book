import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_ORIGIN ?? 'http://127.0.0.1:8080';

/**
 * BOOK-109: the stamp `scripts/build-info.mjs` writes as `prebuild`. Read here, at config
 * time, and relative to this file — not imported: `vite.config.ts` lives under
 * `web/tsconfig.json`, and an untyped `.mjs` import would fail the typecheck. A `vite dev`
 * session (no build behind it) falls back to the same placeholder the server reports.
 */
function buildIdentity(): { commit: string; stamp: string } {
  try {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../build-info.json'), 'utf8')) as {
      commit?: unknown;
      stamp?: unknown;
    };
    const commit = typeof manifest.commit === 'string' && manifest.commit.length > 0 ? manifest.commit : 'dev';
    const stamp = typeof manifest.stamp === 'string' && manifest.stamp.length > 0 ? manifest.stamp : '00.00 00:00';
    return { commit, stamp };
  } catch {
    return { commit: 'dev', stamp: '00.00 00:00' };
  }
}

const build = buildIdentity();

export default defineConfig({
  plugins: [react()],
  // Baked in, not fetched: the colophon prints the build it was built from.
  define: {
    __BUILD_COMMIT__: JSON.stringify(build.commit),
    __BUILD_STAMP__: JSON.stringify(build.stamp),
  },
  resolve: {
    alias: {
      // Source, not dist: the SPA and the server must share one copy of the types.
      '@book/shared': resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/healthz': { target: apiTarget, changeOrigin: false },
      '/ws': { target: apiTarget, ws: true },
    },
  },
  preview: { port: 5174, host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssTarget: 'safari16',
  },
});
