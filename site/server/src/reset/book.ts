/**
 * BOOK-137 — the launch reset: one command that empties the book and keeps its people.
 *
 * What a launch needs is not «drop the database»: the site keeps identities, sessions, the
 * front matter (the canon, not written prose) and every secret and static file. What has to go
 * is the book's *content and progress*: the projection of every written chapter, the whole
 * engine ledger, the log, the readers' filings and the rate state. After the reset the book must
 * be indistinguishable from one that was never written — ch01 and ch42 still hold their frozen
 * frame sentence as one readable paragraph each, and that is a `basis` slot, not a written
 * chapter.
 *
 * Rules this module keeps:
 *
 *   * a backup is taken before anything is deleted and is *verified* (`backup.ts`): mode
 *     `0600`, `PRAGMA integrity_check` = `ok`, and the same counts the pre-reset book reports.
 *     A target that already exists is refused, never overwritten and never unlinked;
 *   * BOOK-187: **the guard asks rows, not files.** The two frame slots must be `basis` rows
 *     (`chapters.basis`, `chapters.chars`, `blocks`); a frame slot rewritten into prose refuses
 *     the whole operation, because the wipe would freeze the wrong text as the canon. The frame
 *     is re-seeded from `book_frame` (the volume's own copy of the canon, seeded by migration
 *     v28) — never from a chapter file, of which there is none any more;
 *   * a live engine (an open step or an unreleased lease) refuses the wipe: deleting the rows
 *     a running step is writing into corrupts the book instead of resetting it;
 *   * the wipe is one transaction. Counts are asserted inside it, and `foreign_key_check` must
 *     come back empty, or the transaction rolls back and nothing changed;
 *   * the snapshot counter (`meta.state_version`) is **bumped, never reset**: a reader's page
 *     ignores a state whose version is lower than the one it holds, so a reset that restarted
 *     at 1 would leave every open page on the pre-launch book;
 *   * the answer carries counts only — never a row, a text, a token or a hash.
 *
 * The counters live in `counts.ts` and the copy in `backup.ts`; this file is the rule and its
 * refusals. No Fastify here: the route in `http/routes/admin.ts` is transport.
 */

import { TOTAL_CHAPTERS } from '@book/shared';

import type { Db } from '../db/db.ts';
import { getChapterRow, listBlocks } from '../db/repo/chapters.ts';
import { frameOf } from '../db/repo/frame.ts';
import { getNumber, setMeta } from '../db/repo/meta.ts';
import { REQUIRED_TRIGGERS } from '../db/schema.ts';
import { EVENTS_TRIGGER_NAMES, EVENTS_TRIGGERS_SQL } from '../db/tables.ts';
import { LEDGER_TABLES_SQL } from '../db/ledgerTables.ts';
import { applyChapterFile } from '../ingest/applyChapter.ts';
import { type BackupFact, BackupFailedError, backupPath, writeBackup } from './backup.ts';
import {
  type BookCount,
  type ContentState,
  type EngineState,
  type KeptCount,
  countBook,
  countContent,
  countEngine,
  countKept,
  totalOf,
} from './counts.ts';

export { BackupFailedError } from './backup.ts';
export { countBook, countContent, countEngine, countKept, totalOf } from './counts.ts';
export type { BookCount, ContentState, EngineState, KeptCount } from './counts.ts';

export type ResetReport = {
  dryRun: boolean;
  /** The counts the book had when the command looked at it — the rows this run removed. */
  tables: BookCount[];
  total: number;
  kept: KeptCount[];
  frame: [number, number];
  engine: EngineState;
  /** What the wipe removes, from the projection (rows): written chapters, characters, blocks. */
  content: ContentState;
  backup: BackupFact | null;
  backupSkipped: string | null;
  warning?: string;
};

export type ResetOptions = {
  dataDir: string;
  now: Date;
  /** `true` (or absent) counts only; the wipe happens only on an explicit `false` from the caller. */
  dryRun: boolean;
  /** BOOK-137: the operator's «I know there is no backup» — the wipe proceeds without one. */
  backupOk?: boolean;
  /** Test seam: where the backup goes. The default is a timestamped file inside `dataDir`. */
  backupFile?: string;
};

/**
 * A refusal the route maps to a status: kept as classes so the message and the code travel
 * together and a test can assert on either.
 *
 * BOOK-187: the refusal names the missing **row**, never a file. A volume whose canon was never
 * seeded (no `book_frame` row and no basis row) cannot be reset to a canon it does not hold.
 */
export class FrameMissingError extends Error {
  readonly code = 'FRAME_MISSING';
  constructor(readonly row: string, reason: string) {
    super(`the frame is missing from the volume (${row}): ${reason}`);
    this.name = 'FrameMissingError';
  }
}

export class EngineBusyError extends Error {
  readonly code = 'ENGINE_BUSY';
  constructor(readonly engine: EngineState) {
    super(
      `the engine is writing (open steps ${String(engine.openSteps)}, live leases ${String(engine.liveLeases)}): ` +
        'stop the engine and run the reset again',
    );
    this.name = 'EngineBusyError';
  }
}

/**
 * The frame slot is prose, not the frozen sentence: the book would lose its canon. BOOK-187: the
 * evidence is the row (`chapters.basis = 0`, `chapters.chars > 0`), and the remedy is the frame's
 * own row — a `book_frame` seed or a restore, never a file edit.
 */
export class FrameNotBasisError extends Error {
  readonly code = 'FRAME_NOT_BASIS';
  constructor(readonly slot: number, readonly chars: number) {
    super(
      `the frame slot holds prose, not the frozen sentence (chapter ${String(slot)}, ${String(chars)} characters); ` +
        'restore the frame (book_frame row or the restore route) and run the reset again',
    );
    this.name = 'FrameNotBasisError';
  }
}

/** The two slots that hold nothing but the frozen frame (§BOOK-6): re-seeded after the wipe. */
const FRAME_SLOTS: readonly [number, number] = [1, TOTAL_CHAPTERS];

/** Which end of the slot each frame row sits on, for `book_frame`. */
const FRAME_POSITION: Readonly<Record<number, 'first' | 'last'>> = {
  [FRAME_SLOTS[0]]: 'first',
  [FRAME_SLOTS[1]]: 'last',
};

/**
 * The `meta` keys the reset drops: the engine's alert cursor. `state_version` is **not** one of
 * them — it is kept and bumped, because the SPA refuses a state whose version went backwards.
 */
const META_KEYS = ['engine.alerts'] as const;

/**
 * DELETE order, child first. `foreign_keys` is ON at the connection, and a few of these
 * references point *forward* in the list (`revisions` → `steps`, `cascades`), so the reset
 * defers enforcement to the commit (`PRAGMA defer_foreign_keys`) — and asserts
 * `foreign_key_check` inside the transaction before it commits.
 */
const WIPE_BEFORE_COMMENTS = [
  'gate_verdicts',
  'gate_dispatches',
  'leases',
  'steps',
  'cascades',
  'change_events',
  'change_impact',
  'revisions',
  'blocks',
  'block_versions',
  'block_lineage',
  'overwrites',
  'reconciles',
  'events',
  'comment_events',
  // BOOK-176: the ledger, child first — a mention names a fact and a thread, an event names a
  // thread, and a fact names a change.
  'literals',
  'mentions',
  'thread_events',
  'threads',
  'facts',
  // ADR-044: a touch names a sentence, so the ledger goes before the rows it describes.
  'sentence_touches',
  'sentences',
] as const;

const WIPE_AFTER_COMMENTS = [
  'comments',
  'changes',
  'feedback_batches',
  'front_revisions',
  'chapters',
  'contributions',
  'contribution_history',
  'rate_events',
] as const;

/**
 * The ids a fresh book must restart at 1: `changes.seq` is THE fifo order (§6A) and `hseq` is
 * the log's clock (§6F.1), so a reset that kept the counters would publish a first record
 * numbered 4 812.
 */
const AUTOINCREMENT_TABLES = [
  'events',
  'changes',
  'change_events',
  'comment_events',
  'front_revisions',
  'overwrites',
  'reconciles',
  // BOOK-176: the ledger's own counters, so a fresh book numbers its first mention 1.
  'thread_events',
  'mentions',
  'literals',
  'sentence_touches',
] as const;

type FrameSlot = { n: number; raw: string };

/**
 * The two frame slots as the volume holds them, read before anything is deleted (BOOK-187).
 *
 * The text comes from the rows: a `basis` chapter row is reprojected from its own title and
 * paragraph, so ch01 keeps its heading («Замечаний нет») and nothing is re-parsed from a file.
 * A slot without a chapter row is not a broken mount any more — the canon is a `book_frame`
 * row, seeded by migration v28, and that row is what re-seeds an empty slot. Only a volume that
 * holds neither refuses.
 */
function frameSlots(db: Db): FrameSlot[] {
  return FRAME_SLOTS.map((n) => {
    const position = FRAME_POSITION[n] ?? 'first';
    const sentence = frameOf(db, n, position);
    const row = getChapterRow(db, n);
    if (row === undefined) {
      if (sentence === null) {
        throw new FrameMissingError(`book_frame ${String(n)}/${position}`, 'no frame row and no chapter row');
      }
      return { n, raw: sentence };
    }
    // A frame slot rewritten into prose is a book whose canon moved: the reset would freeze the
    // wrong text, so it refuses. `chars` is the row's own measure of the prose, `basis` the flag
    // the projection publishes.
    if (row.basis !== 1 || row.chars > 0) throw new FrameNotBasisError(n, row.chars);
    const blocks = listBlocks(db, n);
    const body = blocks.map((block) => block.text).join('\n\n');
    return { n, raw: row.title === null ? body : `${row.title}\n\n${body}` };
  });
}

function dropEventTriggers(db: Db): void {
  // BOOK-176: a fact is never deleted — which is exactly what a launch reset has to do, so its
  // guard is lifted here with the log's own and put back below. The full-text triggers stay:
  // they are what keeps the mirror empty when the blocks go.
  for (const trigger of [...EVENTS_TRIGGER_NAMES, 'facts_no_delete']) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
}

function createEventTriggers(db: Db): void {
  db.exec(EVENTS_TRIGGERS_SQL);
  db.exec(LEDGER_TABLES_SQL);
}

function wipe(db: Db): void {
  for (const table of WIPE_BEFORE_COMMENTS) db.exec(`DELETE FROM ${table}`);
  // `changes.source_comment` is the one reference *into* comments (§6F.4 reader changes):
  // null it first, or the comment rows cannot go.
  db.exec('UPDATE changes SET source_comment = NULL');
  for (const table of WIPE_AFTER_COMMENTS) db.exec(`DELETE FROM ${table}`);
  db.prepare(`DELETE FROM meta WHERE k IN (${META_KEYS.map(() => '?').join(', ')})`).run(...META_KEYS);
  // ADR-044: the sentence bookkeeping describes this book — its version, its import and the
  // filings it re-anchored — so it goes with it, the drift lines included.
  db.exec(`DELETE FROM meta WHERE k LIKE 'sentences.%'`);
  // The lane row is the fifo mutex and must exist exactly once (§6A.3): clear it, keep it.
  db.exec('UPDATE lane SET holder = NULL, heartbeat_at = NULL');
  db.prepare(
    `DELETE FROM sqlite_sequence WHERE name IN (${AUTOINCREMENT_TABLES.map(() => '?').join(', ')})`,
  ).run(...AUTOINCREMENT_TABLES);
}

/**
 * The wipe, and the assertions that make it a fact rather than an intention: two basis
 * slots, zero content counts, a bumped snapshot counter, no dangling reference and both
 * append-only triggers back.
 */
function assertWiped(db: Db, expectedVersion: number): void {
  // The two frame slots, by number: 1 and `TOTAL_CHAPTERS` (BOOK-155 moved the finale to 42).
  const slots = (
    db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE n IN (?, ?) AND basis = 1')
      .get(FRAME_SLOTS[0], FRAME_SLOTS[1]) as { n: number }
  ).n;
  if (slots !== FRAME_SLOTS.length) {
    throw new Error(`reset: the frame slots are not basis rows (${String(slots)} of 2)`);
  }
  // ADR-044: the sentence tables are content, so `countBook` covers them; a surviving row is the
  // same defect as a surviving fact.
  const left = countBook(db).filter((entry) => entry.rows !== 0);
  if (left.length > 0) {
    const names = left.map((entry) => entry.key).join(', ');
    throw new Error(`reset: ${String(left.length)} counter(s) are not zero after the wipe (${names})`);
  }
  // B1: a state version that went backwards makes every open page ignore the new book.
  const version = getNumber(db, 'state_version', 0);
  if (version !== expectedVersion) {
    throw new Error(`reset: state_version is ${String(version)}, expected ${String(expectedVersion)}`);
  }
  const dangling = db.pragma('foreign_key_check') as unknown[];
  if (dangling.length > 0) throw new Error(`reset: ${String(dangling.length)} dangling reference(s) after the wipe`);
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!present.has(trigger)) throw new Error(`reset: the append-only trigger ${trigger} is missing after the wipe`);
  }
}

/**
 * Count, and — when `dryRun` is false — back up and wipe. Throws a typed refusal for the
 * answers a caller must distinguish: a busy engine (`409`), a rewritten frame (`409`, read from
 * its rows), a frame no row holds (`409`) and a backup that could not be verified (`500`, or a
 * warning with `backupOk`).
 */
export function resetBook(db: Db, options: ResetOptions): ResetReport {
  const tables = countBook(db);
  const total = totalOf(tables);
  const kept = countKept(db);
  const engine = countEngine(db);
  const frame: [number, number] = [FRAME_SLOTS[0], FRAME_SLOTS[1]];
  const report: ResetReport = {
    dryRun: options.dryRun,
    tables,
    total,
    kept,
    frame,
    engine,
    content: countContent(db),
    backup: null,
    backupSkipped: null,
  };
  // A dry run reports what a wipe would do and refuses nothing: the counts are the answer.
  if (options.dryRun) return report;

  if (engine.openSteps > 0 || engine.liveLeases > 0) throw new EngineBusyError(engine);
  // The frame is read before anything is deleted: a slot rewritten into prose refuses the whole
  // operation (no backup, no wipe), because the reset would otherwise freeze the wrong canon.
  const slots = frameSlots(db);

  let warning: string | undefined;
  if (total === 0) {
    report.backupSkipped = 'nothing to remove';
  } else {
    try {
      report.backup = writeBackup(db, backupPath(options.dataDir, options.now, options.backupFile), tables);
    } catch (error) {
      if (!(error instanceof BackupFailedError)) throw error;
      if (options.backupOk !== true) throw error;
      warning = 'no backup: backupOk was given';
    }
  }

  const nowMs = options.now.getTime();
  const run = db.transaction(() => {
    // B1 — the counter is read and written in the same transaction as the wipe. It moves when
    // this run removed content (a reader's cached state is now wrong) or when the book never
    // published a snapshot at all (0 → 1). A reset with nothing to remove keeps the version it
    // found: nothing a reader holds became wrong, and a needless bump is a needless reload.
    const preVersion = getNumber(db, 'state_version', 0);
    const nextVersion = preVersion === 0 ? 1 : total > 0 ? preVersion + 1 : preVersion;
    // The DELETE order is child-first but not strictly a topological sort (`revisions` names
    // `steps` and `cascades`), so the check is deferred to the commit and verified inside.
    db.pragma('defer_foreign_keys = ON');
    dropEventTriggers(db);
    wipe(db);
    createEventTriggers(db);
    // The canon comes back from the rows read above (`book_frame` or the slot's own basis row),
    // through the same publisher a landing uses: the two frame slots are rows again.
    for (const slot of slots) {
      applyChapterFile({ db, dataDir: options.dataDir, n: slot.n, raw: slot.raw, mtimeMs: nowMs, nowMs });
    }
    setMeta(db, 'state_version', String(nextVersion));
    assertWiped(db, nextVersion);
  });
  run();

  if (warning !== undefined) report.warning = warning;
  return report;
}
