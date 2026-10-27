/**
 * Types for `bin/admin.mjs` (BOOK-113, BOOK-137), so the CLI tests can call the exported
 * helpers and a reader of the tool finds its entry points where the tests do.
 */

export type ParsedBudget =
  | { kind: 'help' }
  | { kind: 'reset'; identity: string; url?: string }
  | { kind: 'exempt'; identity: string; exempt: boolean; url?: string };

/** BOOK-137: `reset book` — `dryRun` is the default and `--yes` is the only way to write. */
export type ParsedReset = {
  kind: 'reset-book';
  dryRun: boolean;
  backupOk: boolean;
  url?: string;
};

export type ParsedCommand = ParsedBudget | ParsedReset;

export function parseBudgetArgs(argv: string[]): ParsedBudget;
export function parseResetArgs(argv: string[]): ParsedReset | { kind: 'help' };
export function parseCommand(argv: string[]): ParsedCommand;
export function assertLocalTarget(raw: string): URL;
export function localAddresses(): Set<string>;
export function resolveAdminToken(env?: NodeJS.ProcessEnv): string;
