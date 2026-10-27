/**
 * Types for `bin/admin.mjs` (BOOK-113), so the CLI test can call the exported helpers and a
 * reader of the tool finds its two entry points where the tests do.
 */

export type ParsedBudget =
  | { kind: 'help' }
  | { kind: 'reset'; identity: string; url?: string }
  | { kind: 'exempt'; identity: string; exempt: boolean; url?: string };

export function parseBudgetArgs(argv: string[]): ParsedBudget;
export function assertLocalTarget(raw: string): URL;
export function localAddresses(): Set<string>;
export function resolveAdminToken(env?: NodeJS.ProcessEnv): string;
