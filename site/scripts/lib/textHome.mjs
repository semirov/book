/**
 * BOOK-187 — the prose's home is the database, and the file path must not creep back.
 *
 * The engine and the writer used to read `bookRoot/manuscript/*.md`; they read `chapters`,
 * `blocks` and `front_matter` now (ADR-043 §3 row 4). The file readers in `engine/text.ts` stay
 * for the one-shot import only, and the way a second source reappears is one innocent import in
 * one module — so the boundary is a gate, not a promise: a module under `server/src/engine/**` or
 * `server/src/writer/**` may not import `readChapter`, `readFront`, `isWritten`,
 * `writtenChapters` or `chapterPath` from a `text.ts` module.
 *
 * `scripts/arch.mjs` prints these problems and exits 1; the test builds a synthetic tree so the
 * refusal path is proven without editing the repository.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The directories whose modules may not read a manuscript file at runtime. */
export const GUARDED_ROOTS = ['server/src/engine', 'server/src/writer'];

/** The five file readers of `engine/text.ts` (the row readers are `*Rows`/`*Of` and are fine). */
export const MANUSCRIPT_READERS = ['readChapter', 'readFront', 'isWritten', 'writtenChapters', 'chapterPath'];

/** `import { a, b } from '…text.ts'` — the shape every module uses; no other alias is accepted. */
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gu;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|mts)$/u.test(path)) out.push(path);
  }
  return out;
}

/**
 * The import problems of one repository root. A message names the file, the symbol and the
 * module, so an author can read the fix out of the failure.
 */
export function textHomeProblems(root) {
  const problems = [];
  for (const guarded of GUARDED_ROOTS) {
    for (const file of walk(join(root, guarded))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT)) {
        const names = (match[1] ?? '')
          .split(',')
          .map((part) => part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]?.trim() ?? '')
          .filter((name) => name.length > 0);
        const specifier = match[2] ?? '';
        if (!/(^|\/)text\.ts$/u.test(specifier)) continue;
        for (const name of names) {
          if (!MANUSCRIPT_READERS.includes(name)) continue;
          problems.push({
            file: relative(root, file),
            message: `imports ${name} from ${specifier} — the engine and the writer read the book's text from rows (ADR-043 §3 row 4, BOOK-187)`,
          });
        }
      }
    }
  }
  return problems;
}
