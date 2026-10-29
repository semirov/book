/**
 * BOOK-137 — the launch reset: one command that empties the book and keeps its people.
 *
 * What a launch needs is not «drop the database»: the site keeps identities, sessions, the
 * front matter (the canon, not written prose) and every secret and static file. What has to go
 * is the book's *content and progress*: the projection of every written chapter, the whole
 * engine ledger, the log, the readers' filings and the rate state. After the reset the book is
 * the frame and one chapter — ch42 still holds its frozen sentence as one readable paragraph
 * (a `basis` slot, not a written chapter), and **ch01 is kept whole** (BOOK-202, owner
 * 2026-10-29): its rows, its prose and its corner of the graph are read before the wipe and
 * asserted identical after it.
 *
 * Rules this module keeps:
 *
 *   * a backup is taken before anything is deleted and is *verified* (`backup.ts`): mode
 *     `0600`, `PRAGMA integrity_check` = `ok`, and the same counts the pre-reset book reports.
 *     A target that already exists is refused, never overwritten and never unlinked;
 *   * BOOK-187: **the guard asks rows, not files.** The finale slot must be a `basis` row
 *     (`chapters.basis`, `chapters.chars`, `blocks`); a finale rewritten into prose refuses the
 *     whole operation, because the wipe would freeze the wrong text as the canon. The finale is
 *     re-seeded from `book_frame` (the volume's own copy of the canon, seeded by migration v28)
 *     — never from a chapter file, of which there is none any more. BOOK-202: ch01 is not a slot
 *     to guard any more — a written ch01 is kept, and an absent one is seeded the same way;
 *   * a live engine (an open step or an unreleased lease) refuses the wipe: deleting the rows
 *     a running step is writing into corrupts the book instead of resetting it;
 *   * the wipe is one transaction. Counts are asserted inside it, ch01's snapshot and digest are
 *     compared inside it, and `foreign_key_check` must come back empty, or the transaction rolls
 *     back and nothing changed;
 *   * the snapshot counter (`meta.state_version`) is **bumped, never reset**: a reader's page
 *     ignores a state whose version is lower than the one it holds, so a reset that restarted
 *     at 1 would leave every open page on the pre-launch book;
 *   * the answer carries counts and ch01's digest — never a row, a text or a token.
 *
 * The counters live in `counts.ts`, ch01's keep rules and snapshot in `chapter1.ts`, and the
 * copy in `backup.ts`; this file is the rule and its refusals. No Fastify here: the route in
 * `http/routes/admin.ts` is transport.
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
  BLOCK_LINEAGE_WIPED,
  BLOCK_VERSIONS_WIPED,
  BLOCKS_WIPED,
  type Chapter1Snapshot,
  EXTRACTION_RUNS_WIPED,
  FACTS_WIPED,
  FACT_DEPENDENCY_KEPT,
  FACT_DEPENDENCY_WIPED,
  KEPT_CHAPTER,
  type KeptChapter,
  LITERALS_WIPED,
  MENTIONS_WIPED,
  REVISIONS_WIPED,
  SENTENCES_WIPED,
  THREAD_EVENTS_KEPT,
  THREAD_EVENTS_WIPED,
  THREADS_WIPED,
  assertChapter1Kept,
  chapter1KeepsHseq,
  readChapter1,
} from './chapter1.ts';
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
export { type KeptChapter, readChapter1 } from './chapter1.ts';

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
  /** BOOK-202: chapter 1 survives — its counts, its characters and its digest before/after. */
  chapter1: KeptChapter;
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

/** The finale slot: the frozen frame (§BOOK-6), re-seeded after the wipe. ch01 is kept. */
const FRAME_SLOTS: readonly [number, number] = [KEPT_CHAPTER, TOTAL_CHAPTERS];

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
 * references point *forward* in the list (`change_impact` → `changes`), so the reset defers
 * enforcement to the commit (`PRAGMA defer_foreign_keys`) — and asserts `foreign_key_check`
 * inside the transaction before it commits.
 *
 * BOOK-202: the tables whose rows are all content stay here; the chapter-scoped ones
 * (`blocks`, `revisions`, the histories, `sentences`) and the graph are deleted selectively
 * below, so ch01's rows survive.
 */
const WIPE_TABLES = [
  'gate_verdicts',
  'gate_dispatches',
  'leases',
  'steps',
  'cascades',
  'change_events',
  'change_impact',
  'overwrites',
  'reconciles',
  'events',
  'comment_events',
  // ADR-044: a touch names a sentence, so the ledger goes before the rows it describes.
  'sentence_touches',
  'comments',
  'changes',
  'feedback_batches',
  'front_revisions',
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

/** The slot's canon as a seed, from its own row or from the volume's `book_frame` row. */
function frameRaw(db: Db, n: number, position: 'first' | 'last'): string {
  const sentence = frameOf(db, n, position);
  const row = getChapterRow(db, n);
  if (row === undefined) {
    if (sentence === null) {
      throw new FrameMissingError(`book_frame ${String(n)}/${position}`, 'no frame row and no chapter row');
    }
    return sentence;
  }
  // A basis row is reprojected from its own title and paragraph, so ch42 keeps its heading
  // («Замечаний нет» if the canon carries one) and nothing is re-parsed from a file.
  const blocks = listBlocks(db, n);
  const body = blocks.map((block) => block.text).join('\n\n');
  return row.title === null ? body : `${row.title}\n\n${body}`;
}

/**
 * The slots the wipe re-seeds, read before anything is deleted.
 *
 * BOOK-202: only ch42 is a slot. It is re-seeded from `book_frame` or its own basis row, and a
 * finale rewritten into prose is a book whose canon moved, so it refuses (`FRAME_NOT_BASIS`) —
 * the wipe would otherwise freeze the wrong text. ch01 is a chapter now: when the volume holds
 * its row it is left untouched, and only an absent ch01 is seeded from `book_frame`
 * (`chapter=1, position='first'`).
 */
function slotsToSeed(db: Db): FrameSlot[] {
  const last = FRAME_SLOTS[1];
  const row = getChapterRow(db, last);
  // `chars` is the row's own measure of the prose, `basis` the flag the projection publishes.
  if (row !== undefined && (row.basis !== 1 || row.chars > 0)) throw new FrameNotBasisError(last, row.chars);
  const slots: FrameSlot[] = [{ n: last, raw: frameRaw(db, last, FRAME_POSITION[last] ?? 'last') }];
  if (getChapterRow(db, KEPT_CHAPTER) === undefined) {
    slots.unshift({ n: KEPT_CHAPTER, raw: frameRaw(db, KEPT_CHAPTER, FRAME_POSITION[KEPT_CHAPTER] ?? 'first') });
  }
  return slots;
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
  // `changes.source_comment` is the one reference *into* comments (§6F.4 reader changes):
  // null it first, or the comment rows cannot go.
  db.exec('UPDATE changes SET source_comment = NULL');
  // BOOK-202: a kept ch01 row may name a row the wipe deletes — the revision its landing wrote,
  // the change that invalidated a fact, the event that told a thread. The row stays; the pointer
  // does not, or the deferred foreign-key check would fail on a book that is perfectly valid.
  db.exec(
    `UPDATE revisions SET change_id = NULL, cascade_id = NULL, step_id = NULL WHERE chapter = ${String(KEPT_CHAPTER)}`,
  );
  db.exec(
    `UPDATE facts SET invalidated_by_change = NULL
      WHERE chapter = ${String(KEPT_CHAPTER)} AND invalidated_by_change IS NOT NULL`,
  );
  db.exec(
    `UPDATE thread_events SET fact_id = NULL
      WHERE ${THREAD_EVENTS_KEPT} AND fact_id IS NOT NULL
        AND fact_id NOT IN (SELECT id FROM facts WHERE chapter = ${String(KEPT_CHAPTER)})`,
  );
  db.exec(
    `UPDATE fact_dependency SET superseded_by = NULL
      WHERE ${FACT_DEPENDENCY_KEPT} AND superseded_by IS NOT NULL
        AND superseded_by NOT IN (SELECT id FROM fact_dependency WHERE ${FACT_DEPENDENCY_KEPT})`,
  );
  // BOOK-176: the ledger, child first — a mention names a fact and a thread, an event names a
  // thread, and a fact names a change. BOOK-202: each delete keeps ch01's corner of the graph.
  db.exec(`DELETE FROM mentions WHERE ${MENTIONS_WIPED}`);
  db.exec(`DELETE FROM literals WHERE ${LITERALS_WIPED}`);
  db.exec(`DELETE FROM thread_events WHERE ${THREAD_EVENTS_WIPED}`);
  // A kept thread closed in a wiped chapter has no closing chapter any more: the row survives,
  // the pointer goes, and a thread that was `closed` there is back to `advanced` — its closing
  // event is gone, so leaving it `closed` would be a state without the record that made it.
  db.exec(
    `UPDATE threads SET closed_at_chapter = NULL,
                        state = CASE WHEN state = 'closed' THEN 'advanced' ELSE state END
      WHERE opened_at_chapter = ${String(KEPT_CHAPTER)}
        AND closed_at_chapter > ${String(KEPT_CHAPTER)}`,
  );
  db.exec(`DELETE FROM threads WHERE ${THREADS_WIPED}`);
  // BOOK-185: an edge names two facts, so it goes before them; BOOK-DOC-77: a fact and an edge
  // name the extraction run that wrote or retired them, so `extraction_runs` goes after both.
  db.exec(`DELETE FROM fact_dependency WHERE ${FACT_DEPENDENCY_WIPED}`);
  db.exec(`DELETE FROM facts WHERE ${FACTS_WIPED}`);
  db.exec(`DELETE FROM extraction_runs WHERE ${EXTRACTION_RUNS_WIPED}`);
  for (const table of WIPE_TABLES) db.exec(`DELETE FROM ${table}`);
  // Chapter-scoped rows: ch01's survive (BOOK-202), the finale is re-seeded below.
  db.exec(`DELETE FROM sentences WHERE ${SENTENCES_WIPED}`);
  db.exec(`DELETE FROM blocks WHERE ${BLOCKS_WIPED}`);
  db.exec(`DELETE FROM block_versions WHERE ${BLOCK_VERSIONS_WIPED}`);
  db.exec(`DELETE FROM block_lineage WHERE ${BLOCK_LINEAGE_WIPED}`);
  db.exec(`DELETE FROM revisions WHERE ${REVISIONS_WIPED}`);
  db.exec(`DELETE FROM chapters WHERE n <> ${String(KEPT_CHAPTER)}`);
  db.prepare(`DELETE FROM meta WHERE k IN (${META_KEYS.map(() => '?').join(', ')})`).run(...META_KEYS);
  // ADR-044: the sentence bookkeeping describes this book — its version, its import and the
  // filings it re-anchored — so it goes with it, the drift lines included.
  db.exec(`DELETE FROM meta WHERE k LIKE 'sentences.%'`);
  // The lane row is the fifo mutex and must exist exactly once (§6A.3): clear it, keep it.
  db.exec('UPDATE lane SET holder = NULL, heartbeat_at = NULL');
  // BOOK-202: the counters restart at 1 like a fresh book — except `events`, whose numbers ch01's
  // kept `hseq` pointers still address. Restarting it would hand the next event a number a kept
  // revision/version/lineage row already names, and the provenance would resolve to a stranger.
  const sequence = chapter1KeepsHseq(db)
    ? AUTOINCREMENT_TABLES.filter((table) => table !== 'events')
    : AUTOINCREMENT_TABLES;
  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${sequence.map(() => '?').join(', ')})`).run(...sequence);
}

/**
 * The wipe, and the assertions that make it a fact rather than an intention: the finale is a
 * basis slot, zero content counts, **ch01 unchanged**, a bumped snapshot counter, no dangling
 * reference and both append-only triggers back.
 */
function assertWiped(db: Db, expectedVersion: number, chapter1: Chapter1Snapshot): void {
  // The finale, by number (`TOTAL_CHAPTERS` — BOOK-155 moved it to 42). BOOK-202: ch01 is a
  // chapter the book keeps, so it is not a basis slot any more and is asserted by its snapshot.
  const finale = (
    db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE n = ? AND basis = 1').get(FRAME_SLOTS[1]) as { n: number }
  ).n;
  if (finale !== 1) throw new Error('reset: the finale slot is not a basis row');
  // ADR-044: the sentence tables are content, so `countBook` covers them; a surviving row is the
  // same defect as a surviving fact.
  const left = countBook(db).filter((entry) => entry.rows !== 0);
  if (left.length > 0) {
    const names = left.map((entry) => entry.key).join(', ');
    throw new Error(`reset: ${String(left.length)} counter(s) are not zero after the wipe (${names})`);
  }
  // BOOK-202: the whole point of the reset keeping ch01 is that the wipe did not touch it. The
  // row-level snapshot and the digest are compared here, inside the transaction, so a mismatch
  // rolls the wipe back instead of publishing a rewritten chapter 1.
  assertChapter1Kept(db, chapter1);
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
  // BOOK-202: ch01's report and the snapshot the wipe is proved against are read here, in one
  // place, so the dry run and the real run answer from the same rows.
  const chapter1 = readChapter1(db);
  const report: ResetReport = {
    dryRun: options.dryRun,
    tables,
    total,
    kept,
    frame,
    engine,
    content: countContent(db),
    chapter1: chapter1.report,
    backup: null,
    backupSkipped: null,
  };
  // A dry run reports what a wipe would do and refuses nothing: the counts are the answer, and
  // nothing was written, so ch01's digest after the wipe is its digest before it.
  if (options.dryRun) return report;

  if (engine.openSteps > 0 || engine.liveLeases > 0) throw new EngineBusyError(engine);
  // The finale is read before anything is deleted: a slot rewritten into prose refuses the whole
  // operation (no backup, no wipe), because the reset would otherwise freeze the wrong canon.
  const slots = slotsToSeed(db);

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
    // The DELETE order is child-first but not strictly a topological sort (`change_impact` names
    // `changes`), so the check is deferred to the commit and verified inside.
    db.pragma('defer_foreign_keys = ON');
    dropEventTriggers(db);
    wipe(db);
    createEventTriggers(db);
    // The canon comes back from the rows read above (`book_frame` or the finale's own basis
    // row), through the same publisher a landing uses: the finale slot is a row again. ch01 is
    // not re-seeded here — it was kept — and only an absent ch01 is in `slots`.
    for (const slot of slots) {
      applyChapterFile({ db, dataDir: options.dataDir, n: slot.n, raw: slot.raw, mtimeMs: nowMs, nowMs });
    }
    setMeta(db, 'state_version', String(nextVersion));
    assertWiped(db, nextVersion, chapter1.snapshot);
  });
  run();

  // BOOK-202: the answer carries ch01's digest after the wipe. `assertWiped` has already proved
  // it equal to the one read before it (or, on a volume that never held ch01, that the slot was
  // seeded); this is the same digest, recomputed from the rows the book now holds.
  report.chapter1 = { ...chapter1.report, sha256After: readChapter1(db).report.sha256Before };
  if (warning !== undefined) report.warning = warning;
  return report;
}
