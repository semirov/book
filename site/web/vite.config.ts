import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { stampBuildTokens } from './src/lib/buildTokens.ts';

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

/** Every `<script …>` open tag in the shell. */
const SCRIPT_TAG = /<script\b[^>]*>/gu;

/**
 * BOOK-119 — mark the app's entry script, the one failure the guard reports at once.
 *
 * `data-critical` is authored in `index.html`, but `vite build` rebuilds the entry's tag from
 * `src`/`type`/`crossorigin` alone and drops every other attribute, so the marker is re-applied
 * to the final HTML. `order: 'post'` is what makes the transform see Vite's own output; the one
 * module script Vite injects (`/@vite/client`, dev only) is not the app and is left alone.
 */
function markEntry(html: string): string {
  return html.replace(SCRIPT_TAG, (tag) => {
    if (!/\bsrc=/u.test(tag)) return tag; // an inline script (the guard, dev's refresh preamble) is not the entry
    if (!/type="module"/u.test(tag) || tag.includes('data-critical') || /src="\/@vite\//u.test(tag)) return tag;
    return tag.replace(/>$/u, ' data-critical>');
  });
}

/**
 * The plugin form: builds the shell's tokens, then marks the entry. Runs for `vite build` and
 * for `vite dev` alike, so a dev page never shows a literal token either.
 */
function shellBuild(identity: { commit: string; stamp: string }): Plugin {
  return {
    name: 'book-build-tokens',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => markEntry(stampBuildTokens(html, identity)),
    },
  };
}

const build = buildIdentity();

export default defineConfig({
  plugins: [react(), shellBuild(build)],
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
    // BOOK-119: a build lands in `dist/staging` and `scripts/release.mjs` publishes it as
    // `dist/releases/<id>`, so publishing never rewrites a shell a reader may still hold.
    outDir: 'dist/staging',
    emptyOutDir: true,
    target: 'es2022',
    cssTarget: 'safari16',
  },
});
