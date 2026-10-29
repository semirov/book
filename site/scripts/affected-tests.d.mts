/**
 * Types for `scripts/affected-tests.mjs` (BOOK-198) — the PR test selection, imported by
 * `server/test/affectedTests.test.ts`. Only the surface the test and the CLI use is declared.
 */

export type TestSelection = {
  mode: 'full' | 'affected';
  /** Patterns relative to `site/`, in a stable order. Empty in `full` mode. */
  files: string[];
};

export function classify(changedPaths: readonly string[]): TestSelection;

export function braceExpand(pattern: string): string[];

export function globToRegExp(pattern: string): RegExp;

export function expand(patterns: readonly string[], root?: string): string[];
