/**
 * Content-addressed snapshots (§8.3): every observed revision is kept outside git, so a
 * restore does not depend on the operating system's copy of the repository.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
