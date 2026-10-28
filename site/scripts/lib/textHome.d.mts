/**
 * Types for `scripts/lib/textHome.mjs` (BOOK-187) — the arch rule that keeps the manuscript file
 * reader out of the engine and the writer, imported by `scripts/arch.mjs` and
 * `server/test/textHome.test.ts`. Only the surface those two use is declared.
 */

export type TextHomeProblem = { file: string; message: string };

export const GUARDED_ROOTS: readonly string[];

export const MANUSCRIPT_READERS: readonly string[];

export function textHomeProblems(root: string): TextHomeProblem[];
