/**
 * bin/lib/entry.mjs — «am I the script the operator ran?», answered through symlinks (BOOK-236).
 *
 * The deploy root is a symlink: `~/book-deploy` → `/Users/filipp/srv/book` (BOOK-DOC-46). Node
 * resolves `import.meta.url` to the **real** path, while `process.argv[1]` keeps the path the
 * operator typed — so `import.meta.url === pathToFileURL(process.argv[1]).href` was never true
 * through the symlink, the entry block never ran, and `admin.sh admin doctor` printed nothing and
 * exited 0 (measured on prod after the deploy). The same class covers `bin/backup.mjs`: a nightly
 * backup that silently backs nothing up.
 *
 * Two answers, and one refusal:
 *   * `entry`     — the real paths agree: run `main`;
 *   * `imported`  — a test or another module imported this file: do nothing;
 *   * `unknown`   — the operator typed this file's own name and the real path could not be read
 *     (a broken link, a vanished mount). A CLI that cannot tell whether it is the entry must not
 *     report success, so the callers exit 2 with one line naming the path.
 */

import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `entryState(process.argv[1], import.meta.url)` — 'entry' | 'imported' | 'unknown'.
 * A missing `argv[1]` (a plain `import`) is 'imported': there is nothing to run.
 */
export function entryState(argv1, moduleUrl) {
  if (typeof argv1 !== 'string' || argv1.length === 0) return 'imported';
  let selfReal;
  let argumentReal;
  try {
    selfReal = realpathSync.native(fileURLToPath(moduleUrl));
    argumentReal = realpathSync.native(resolve(argv1));
  } catch {
    // The operator named this same file and we cannot prove it: unknown, never «imported».
    return basename(argv1) === basename(fileURLToPath(moduleUrl)) ? 'unknown' : 'imported';
  }
  return selfReal === argumentReal ? 'entry' : 'imported';
}
