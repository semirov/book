/**
 * Content-addressed snapshots (§8.3): every observed revision is kept outside git, so a
 * restore does not depend on the operating system's copy of the repository.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chapterLabel } from '@book/shared';

/** Returns the repository-relative path stored in `revisions.snapshot`. */
export function writeSnapshot(dataDir: string, n: number, sha256: string, text: string): string {
  const dir = join(dataDir, 'versions', `ch${chapterLabel(n)}`);
  const file = join(dir, `${sha256}.md`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return `versions/ch${chapterLabel(n)}/${sha256}.md`;
}

/** Returns the path stored in `front_revisions.snapshot` (§6C.2). */
export function writeFrontSnapshot(dataDir: string, sha256: string, text: string): string {
  const dir = join(dataDir, 'versions', 'front');
  const file = join(dir, `${sha256}.md`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return `versions/front/${sha256}.md`;
}

/**
 * Read a snapshot back (§6F.2): time travel and the paragraph chain read the body from the
 * store, never from the log — the log carries hashes only.
 */
export function readSnapshot(dataDir: string, relativePath: string): string | null {
  try {
    return readFileSync(join(dataDir, relativePath), 'utf8');
  } catch {
    return null;
  }
}
