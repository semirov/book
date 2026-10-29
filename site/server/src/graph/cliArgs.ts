/**
 * The flag parser and the connection every `bin/graph.mjs` command shares (BOOK-185).
 *
 * One parser, because the CLI is one tool: a flag the tool accepts is accepted by every command,
 * and a command that does not use a flag it was given ignores it rather than growing a second
 * vocabulary. Unknown flags are collected, not refused here — the command that owns the run is
 * the one that knows which flags exist, and it returns the usage code.
 *
 * A counted flag is parsed as a number only when it *is* one: `--changed-chars abc` is collected
 * in `invalid` rather than becoming `NaN`, because `NaN` loses every comparison it is put in and a
 * budget that cannot be exceeded is not a budget.
 */

import { databaseFile, openDatabase, type Db } from '../db/db.ts';
import { migrate } from '../db/migrate.ts';

export type GraphFlags = {
  dataDir: string | null;
  chapters: string | null;
  all: boolean;
  pending: boolean;
  force: boolean;
  dryRun: boolean;
  noRecall: boolean;
  json: boolean;
  limit: number | null;
  /** `graph closure --fact`: one seed fact id. */
  fact: string | null;
  /** `graph closure --chapter`: the chapter a quote is looked up in. */
  chapter: string | null;
  /** `graph closure --quote`: the text to resolve to facts. */
  quote: string | null;
  /** `graph closure --changed-chars`: the patch's size, counted against the budget. */
  changedChars: number | null;
  /**
   * `graph extract --max-output`: the request's own `max_tokens` for the extract call, overriding
   * the pin for one run — a diagnostic knob, not a config edit. The range is the command's to
   * check (1024–131072), because `counted` only knows «is a non-negative number».
   */
  maxOutput: number | null;
  /** `graph closure --apply`: the chapters the plan executes, `all` (the default) or a list. */
  apply: string | null;
  /** Numeric flags whose argument was not a finite, non-negative number, as they were written. */
  invalid: string[];
  unknown: string[];
};

/**
 * `graph extract --max-output` bounds: under 1024 the answer is cut before a chapter's JSON can
 * close, and above the provider's own ceiling the request is a lie. Both are usage errors, not a
 * quiet clamp — a cap nobody meant is a chapter nobody can explain.
 */
export const MIN_MAX_OUTPUT = 1024;
export const MAX_MAX_OUTPUT = 131_072;

/** The `--max-output` usage error, or null when the flag is absent or inside the range. */
export function maxOutputProblem(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < MIN_MAX_OUTPUT || value > MAX_MAX_OUTPUT) {
    return `graph: --max-output must be an integer between ${String(MIN_MAX_OUTPUT)} and ${String(MAX_MAX_OUTPUT)}`;
  }
  return null;
}

export function parseFlags(argv: readonly string[]): GraphFlags {
  const flags: GraphFlags = {
    dataDir: null,
    chapters: null,
    all: false,
    pending: false,
    force: false,
    dryRun: false,
    noRecall: false,
    json: false,
    limit: null,
    fact: null,
    chapter: null,
    quote: null,
    changedChars: null,
    maxOutput: null,
    apply: null,
    invalid: [],
    unknown: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return null;
      index += 1;
      return next;
    };
    const numeric = (): number | null => {
      const raw = value();
      return raw === null ? null : Number(raw);
    };
    /**
     * A counted flag: `Number('abc')` is `NaN`, and `NaN` is not a small number — it silently
     * disables every cap it is compared with (`NaN > 4000` is false). So it is refused here, as a
     * usage error the command reports with exit 2, instead of reaching the budget as `null`.
     */
    const counted = (flag: string): number | null => {
      const raw = value();
      if (raw === null) {
        flags.invalid.push(`${flag} needs a number`);
        return null;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        flags.invalid.push(`${flag} "${raw}" is not a non-negative number`);
        return null;
      }
      return parsed;
    };
    if (name === '--data-dir') flags.dataDir = value();
    else if (name === '--chapters') flags.chapters = value();
    else if (name === '--limit') flags.limit = numeric();
    else if (name === '--fact') flags.fact = value();
    else if (name === '--chapter') flags.chapter = value();
    else if (name === '--quote') flags.quote = value();
    else if (name === '--changed-chars') flags.changedChars = counted('--changed-chars');
    else if (name === '--max-output') flags.maxOutput = counted('--max-output');
    else if (name === '--apply') flags.apply = value();
    else if (name === '--all') flags.all = true;
    else if (name === '--pending') flags.pending = true;
    else if (name === '--force') flags.force = true;
    else if (name === '--dry-run') flags.dryRun = true;
    else if (name === '--no-recall') flags.noRecall = true;
    else if (name === '--json') flags.json = true;
    else flags.unknown.push(arg);
  }
  return flags;
}

/** Open and migrate the projection in a data directory — the only way the CLI touches a file. */
export function openGraphDb(dataDir: string): Db {
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);
  return db;
}
