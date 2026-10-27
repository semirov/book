/**
 * BOOK-109 — the build this page is, baked into the bundle at build time.
 *
 * `scripts/build-info.mjs` writes `build-info.json` as `prebuild`; `vite.config.ts` reads it and
 * replaces the two identifiers below, so the bundle carries the commit and the Moscow stamp and
 * nothing has to ask the server for them. `vitest.config.ts` supplies fixed values, and the
 * `typeof` guards cover the one case a define can be missing from: a module loaded without the
 * build (a hand-built bundle, a test run outside the config), which must print a placeholder
 * rather than throw on an undefined identifier.
 */

declare const __BUILD_COMMIT__: string;
declare const __BUILD_STAMP__: string;

export type BuildId = { commit: string; stamp: string };

/** The stamped values, and the placeholder a build without a stamp reports. */
const FALLBACK: BuildId = { commit: 'dev', stamp: '00.00 00:00' };

/** `typeof` on an identifier that was never defined is `'undefined'`, not a ReferenceError. */
function bakedCommit(): string {
  return typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '';
}

function bakedStamp(): string {
  return typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '';
}

/** The values the bundler baked in; empty strings when the define was absent. */
export const BUILD: BuildId = { commit: bakedCommit(), stamp: bakedStamp() };

/**
 * `сборка 5558449 · 27.10 20:52` — the reader's line, composed in one place. The default is the
 * build this bundle is, which is what the colophon prints.
 */
export function composeBuildStamp(build: BuildId = BUILD): string {
  const commit = build.commit.length > 0 ? build.commit : FALLBACK.commit;
  const stamp = build.stamp.length > 0 ? build.stamp : FALLBACK.stamp;
  return `сборка ${commit} · ${stamp}`;
}
