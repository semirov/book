/**
 * The build stamp as the server reads it (BOOK-187, ADR-043 G8).
 *
 * `scripts/build-info.mjs` bakes `build-info.json` into the image: the commit, the moment, the
 * Moscow stamp, and — since v23 — two digests that a git-less host cannot re-derive: the prompt
 * bundle's sha and the image's own digest. Reading it is the *only* way the process learns which
 * rules it carries, so it never asks git, never spawns anything and never fails a boot: a missing
 * or corrupt file is "no stamp" (a dev checkout, a unit test), which the boot writes as empty
 * stamps and the health answer prints as `null`.
 */

import { readFileSync } from 'node:fs';

import { BUILD_INFO_FILE } from './build.ts';

export type BuildStamp = {
  /** The commit the build is from; `'dev'` when nothing named it. */
  commit: string;
  /** ISO moment of the build, null when unknown. */
  builtAt: string | null;
  /** `27.10 20:52` (Moscow), null when unknown. */
  stamp: string | null;
  /** ADR-043 G3: sha256 over the ordered prompt/canon file list, null when the build had none. */
  promptBundleSha: string | null;
  /** ADR-043 G8: `BOOK_IMAGE_DIGEST` at build time, null when the build was not an image. */
  imageDigest: string | null;
};

/** What an absent stamp means: no build identity, no prompts pinned, no digest. */
export const NO_BUILD_STAMP: BuildStamp = {
  commit: 'dev',
  builtAt: null,
  stamp: null,
  promptBundleSha: null,
  imageDigest: null,
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read the stamp, with safe defaults. `file` is a seam for tests; the default is the file
 * `npm run build` leaves at the site root, which the Dockerfile copies into the runtime stage.
 */
export function readBuildStamp(file: string = BUILD_INFO_FILE): BuildStamp {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return NO_BUILD_STAMP;
  }
  if (parsed === null || typeof parsed !== 'object') return NO_BUILD_STAMP;
  const manifest = parsed as Record<string, unknown>;
  return {
    commit: text(manifest.commit) ?? NO_BUILD_STAMP.commit,
    builtAt: text(manifest.builtAt),
    stamp: text(manifest.stamp),
    promptBundleSha: text(manifest.promptBundleSha),
    imageDigest: text(manifest.imageDigest),
  };
}
