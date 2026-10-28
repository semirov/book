/**
 * Types for `scripts/lib/textHome.mjs` (BOOK-187) — the arch rule that keeps the manuscript file
 * reader out of the engine and the writer, imported by `scripts/arch.mjs` and
 * `server/test/textHome.test.ts`. Only the surface those two use is declared.
 */

export type TextHomeProblem = { file: string; message: string };

export const GUARDED_ROOTS: readonly string[];

export const MANUSCRIPT_READERS: readonly string[];

/** The boot: it serves rows, so it may not attach a filesystem reader. */
export const BOOT_FILE: string;

/** The import and the watcher: the two modules a boot may never reach. */
export const BOOT_REFUSED: readonly string[];

/** The directory the one-shot import lives in; only it may name `scanManuscript`. */
export const IMPORT_DIR: string;

export function textHomeProblems(root: string): TextHomeProblem[];
