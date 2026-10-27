/** Types for `scripts/styles.mjs` — the BOOK-DOC-35 type-floor and adaptive-regime guard. */

export type StyleProblem = { file: string; line: number; message: string };

export type ChipTier = 'state' | 'count' | 'ref' | 'sentence';
export type ChipSelector = { selector: string; tier: ChipTier; fact: string };
export type StyleOptions = { requireChips?: boolean };

export const MIN_FONT_PX: number;
export const LADDER: Readonly<Record<string, number>>;
export const CHIP_SELECTORS: readonly ChipSelector[];

export function styleProblems(stylesDir: string, options?: StyleOptions): StyleProblem[];
