/**
 * BOOK-119 — the shell's two build tokens.
 *
 * `index.html` carries `%BUILD_COMMIT%` / `%BUILD_STAMP%` inside the inline boot guard, so the
 * page that could not boot is also the page that names its build. `vite.config.ts` fills them
 * in `transformIndexHtml` (for `vite build` and `vite dev` both).
 *
 * The replacement lives here rather than in the config because the boot-guard test reads the
 * real shell and has to see the same bytes a browser gets: importing `vite.config.ts` from a
 * jsdom test drags `vite` (and with it `esbuild`) into a realm where `instanceof Uint8Array`
 * is already false, which aborts the suite before a single test runs.
 */

/** The placeholders, one each — the shell carries no other `%…%` token. */
export const BUILD_TOKENS = { commit: '%BUILD_COMMIT%', stamp: '%BUILD_STAMP%' } as const;

/** A value safe to splice into a JavaScript string literal: no quote, no backslash, no `$`. */
const SAFE_VALUE = /^[A-Za-z0-9._: -]+$/u;

/** The guard names the build in seven characters — git's own abbreviation. */
export const GUARD_COMMIT_LENGTH = 7;

/**
 * Fill the shell's tokens from the build identity (`scripts/build-info.mjs`).
 *
 * The pass is deterministic and depends on nothing but the identity: the server hashes the
 * guard's served bytes into `script-src`, so a hash that moved between responses would break
 * the page it exists to save.
 *
 * The commit is cut to seven characters here, always. `BOOK_BUILD_COMMIT` (a Docker `ARG`, a
 * compose override) is allowed to carry a full 40-character sha, and 33 extra bytes is exactly
 * the guard's ≤1024 B budget: `web/src/lib/bootGuard.test.tsx` passes a full sha and asserts the
 * rendered bytes. The stamp the colophon prints is unaffected — `vite.config.ts` hands the full
 * commit to `__BUILD_COMMIT__` separately.
 *
 * A value that is not obviously a token is refused in favour of the documented fallback —
 * `dev` / `00.00 00:00`, what a dev page without a build behind it shows. It lands inside a
 * script, and one stray quote there breaks the shell itself.
 */
export function stampBuildTokens(html: string, identity: { commit: string; stamp: string }): string {
  const safe = (value: string, fallback: string): string => (SAFE_VALUE.test(value) ? value : fallback);
  return html
    .replaceAll(BUILD_TOKENS.commit, safe(identity.commit, 'dev').slice(0, GUARD_COMMIT_LENGTH))
    .replaceAll(BUILD_TOKENS.stamp, safe(identity.stamp, '00.00 00:00'));
}
