/**
 * The build the running process is (BOOK-109).
 *
 * The owner saw a phone serve the *old* frame while this host served the canon: the site could
 * not say which build it was, so "a stale client" and "another host" looked the same. The
 * stamp `scripts/build-info.mjs` writes is read here, once at boot, and travels into
 * `/healthz` — no git call, no child process, nothing that can hang or fail a boot.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SITE_ROOT } from './config.ts';

/**
 * Where `npm run build` leaves the stamp (`prebuild` runs the CLI; the Dockerfile copies the
 * file into the runtime stage). Exported so a test can point the reader at a temp file.
 */
export const BUILD_INFO_FILE = resolve(SITE_ROOT, 'build-info.json');

/**
 * The commit the build was made from, or `'dev'`.
 *
 * A missing or corrupt manifest is "no build identity" — the same word a local `vite dev`
 * session reports — never a boot failure: the site's job is to serve the book, and an
 * unreadable stamp is a diagnostic detail, not a reason to be down.
 */
export function readBuildCommit(file: string = BUILD_INFO_FILE): string {
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { commit?: unknown };
    const commit = manifest.commit;
    return typeof commit === 'string' && commit.length > 0 ? commit : 'dev';
  } catch {
    return 'dev';
  }
}
