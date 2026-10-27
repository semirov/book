/** Types for `scripts/styles.mjs` — the BOOK-DOC-35 type-floor and adaptive-regime guard. */

export type StyleProblem = { file: string; line: number; message: string };

export const MIN_FONT_PX: number;
export const LADDER: Readonly<Record<string, number>>;

export function styleProblems(stylesDir: string): StyleProblem[];
