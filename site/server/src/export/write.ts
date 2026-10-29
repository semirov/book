/**
 * BOOK-187 AC11 — the one place an export touches the filesystem.
 *
 * `writeFileSync` to the caller's path and nothing else: **no directory is created implicitly**.
 * A typo in `--out` then fails with the system's own `ENOENT` naming the path, instead of
 * leaving a tree somebody has to find later; and nothing generated is ever committed, because
 * nothing is ever written to a path the caller did not name.
 */

import { writeFileSync } from 'node:fs';

/** Write the body to `out`; the byte count is what the CLI prints (UTF-8, not characters). */
export function writeExport(out: string, body: string): { path: string; bytes: number } {
  writeFileSync(out, body, 'utf8');
  return { path: out, bytes: Buffer.byteLength(body, 'utf8') };
}
