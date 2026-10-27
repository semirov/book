/** Types for `scripts/chips.mjs` — the BOOK-70 chip-copy guard, used by `arch.mjs` and its test. */

export type ChipProblem = { file: string; line: number; message: string };
export type ForbiddenPhrase = { phrase: string; why: string; pattern?: RegExp };

export const FORBIDDEN: readonly ForbiddenPhrase[];

export function copyProblems(webSrcDir: string): ChipProblem[];
