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
 * The second rule is the same boundary seen from the boot: **only `ingest/reconcile.ts` may read
 * a manuscript directory**, so (a) no module outside `server/src/ingest/` may import
 * `scanManuscript`, and (b) the boot may not import the import or the watcher — a restart has
 * nothing to rescan, and an import is an operator's act.
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

/** The boot: it serves rows, so it may not attach a filesystem reader. */
export const BOOT_FILE = 'server/src/index.ts';

/** The import and the watcher: the two modules a boot may never reach. */
export const BOOT_REFUSED = ['./ingest/reconcile.ts', './ingest/watcher.ts'];

/** The directory the one-shot import lives in; only it may name `scanManuscript`. */
export const IMPORT_DIR = 'server/src/ingest';

/** `import { a, b } from '…text.ts'` — the shape every module uses; no other alias is accepted. */
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gu;
/** Any import at all, for the boot's specifier check. */
const ANY_IMPORT = /from\s+'([^']+)'/gu;


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
  return [...problems, ...scanImportProblems(root), ...bootProblems(root)];
}

/** Only the one-shot import may name the scanner; every other module reads rows. */
function scanImportProblems(root) {
  const problems = [];
  for (const file of walk(join(root, 'server', 'src'))) {
    const rel = relative(root, file);
    if (rel === join(IMPORT_DIR, 'reconcile.ts')) continue;
    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(ANY_IMPORT)].map((match) => match[1] ?? '');
    if (!specifiers.some((specifier) => /(^|\/)scanManuscript\.ts$/u.test(specifier))) continue;
    problems.push({
      file: rel,
      message: `imports scanManuscript — only ingest/reconcile.ts (the one-shot import) may read a manuscript directory (BOOK-187 AC2)`,
    });
  }
  return problems;
}

/** The boot serves rows: it may not reach the import or the watcher. */
function bootProblems(root) {
  const file = join(root, BOOT_FILE);
  if (!existsSync(file)) return [];
  const problems = [];
  for (const match of readFileSync(file, 'utf8').matchAll(ANY_IMPORT)) {
    const specifier = match[1] ?? '';
    if (!BOOT_REFUSED.includes(specifier)) continue;
    problems.push({
      file: BOOT_FILE,
      message: `imports ${specifier} — a boot reads rows; the import is an operator's act and the watcher is not attached (BOOK-187 AC2)`,
    });
  }
  return problems;
}
