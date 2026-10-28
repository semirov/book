/**
 * BOOK-137 — the launch reset: one command that empties the book and keeps its people.
 *
 * What a launch needs is not «drop the database»: the site keeps identities, sessions, the
 * front matter (the canon of `00-front.md`, not written prose) and every secret and static
 * file. What has to go is the book's *content and progress*: the projection of every written
 * chapter, the whole engine ledger, the log, the readers' filings and the rate state. After
 * the reset the book must be indistinguishable from one that was never written — ch01 and
 * ch42 still hold their frozen frame sentence as one readable paragraph each, and that is a
 * `basis` slot, not a written chapter.
 *
 * Rules this module keeps:
 *
 *   * a backup is taken before anything is deleted and is *verified* (`backup.ts`): mode
 *     `0600`, `PRAGMA integrity_check` = `ok`, and the same counts the pre-reset book reports.
 *     A target that already exists is refused, never overwritten and never unlinked;
 *   * a chapter file the manuscript still holds refuses the wipe: a boot scan re-reads
 *     `manuscript/chNN.md`, so a reset over a written manuscript would be undone by the next
 *     restart. Removing the files is the operator's act, never this module's (the site does not
 *     write to the repository), and the refusal says how: engine-written chapters are untracked
 *     working-tree files (`git clean -fd manuscript/`), a committed chapter is `git rm`;
 *   * the frame is re-read from the manuscript **before** the wipe, and a missing file — or a
 *     frame slot that holds prose instead of the frozen sentence — refuses the whole operation:
 *     an unreadable frame is a broken mount, never a reason to delete;
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

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { chapterLabel, TOTAL_CHAPTERS } from '@book/shared';

import type { Db } from '../db/db.ts';
import { getNumber, setMeta } from '../db/repo/meta.ts';
import { REQUIRED_TRIGGERS } from '../db/schema.ts';
import { EVENTS_TRIGGERS_SQL } from '../db/tables.ts';
import { applyChapterFile } from '../ingest/applyChapter.ts';
import { parseChapter } from '../ingest/parseChapter.ts';
import { scanManuscript } from '../ingest/scanManuscript.ts';
import { type BackupFact, BackupFailedError, backupPath, writeBackup } from './backup.ts';
import {
  type BookCount,
  countBook,
  countEngine,
  countKept,
  type EngineState,
  type KeptCount,
  type ManuscriptState,
  totalOf,
} from './counts.ts';

export { BackupFailedError } from './backup.ts';
export { countBook, countEngine, countKept, totalOf } from './counts.ts';
export type { BookCount, EngineState, KeptCount, ManuscriptState } from './counts.ts';

export type ResetReport = {
  dryRun: boolean;
  /** The counts the book had when the command looked at it — the rows this run removed. */
  tables: BookCount[];
  total: number;
  kept: KeptCount[];
  frame: [number, number];
  engine: EngineState;
  manuscript: ManuscriptState;
  backup: BackupFact | null;
  backupSkipped: string | null;
  warning?: string;
};

export type ResetOptions = {
  bookRoot: string;
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
 */
export class FrameMissingError extends Error {
  readonly code = 'FRAME_MISSING';
  constructor(readonly file: string, reason: string) {
    super(`the frame file is missing or unreadable (${file}): ${reason}`);
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
 * B2 — the manuscript still holds prose, so a boot scan would re-ingest it. The reset refuses
 * and names the files, and the remedy is the operator's act: engine-written chapters are
 * untracked files (`git clean -fd manuscript/`), a committed one is `git rm`. `git checkout`
 * is not the remedy for them — it never deletes an untracked file, and for a committed chapter
 * it puts the prose back.
 */
export class ManuscriptWrittenError extends Error {
  readonly code = 'MANUSCRIPT_WRITTEN';
  constructor(readonly files: string[]) {
    super(
      `the manuscript holds ${String(files.length)} chapter file(s) whose prose a boot scan would restore; ` +
        'remove them from manuscript/ (untracked engine output: git clean -fd manuscript/; ' +
        'a committed chapter: git rm) and run the reset again',
    );
    this.name = 'ManuscriptWrittenError';
  }
}

/**
 * The frame slot is prose, not the frozen sentence: the book would lose its canon. Unlike a
 * written chapter, ch01/ch42 are committed canon, so `git checkout` is the right remedy here —
 * it is the engine's output that is untracked, not the frame.
 */
export class FrameNotBasisError extends Error {
  readonly code = 'FRAME_NOT_BASIS';
  constructor(readonly file: string) {
    super(
      `the frame file holds prose, not the frozen sentence (${file}); ` +
        'clear manuscript/ (git checkout) and run the reset again',
    );
    this.name = 'FrameNotBasisError';
  }
}

/** The two slots that hold nothing but the frozen frame (§BOOK-6): re-read after the wipe. */
const FRAME_SLOTS: readonly [number, number] = [1, TOTAL_CHAPTERS];

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
] as const;

type FrameFile = { n: number; path: string; raw: string; mtimeMs: number };

/**
 * The two frame slots as the manuscript holds them. Read before anything is deleted: an
 * absent or unreadable file is a broken mount, and the reset refuses instead of leaving the
 * reader with two chapters that no longer exist anywhere.
 */
function readFrame(bookRoot: string): FrameFile[] {
  return FRAME_SLOTS.map((n) => {
    const file = join(bookRoot, 'manuscript', `ch${chapterLabel(n)}.md`);
    try {
      const raw = readFileSync(file, 'utf8');
      return { n, path: file, raw, mtimeMs: statSync(file).mtimeMs };
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? 'unreadable';
      throw new FrameMissingError(file, reason);
    }
  });
}

/**
 * A frame slot must be exactly its frozen sentence (§BOOK-6). A slot rewritten into prose is a
 * book whose canon moved: the reset would freeze the wrong text as the frame, so it refuses.
 */
function assertFrameIsBasis(files: readonly FrameFile[]): void {
  for (const file of files) {
    if (!parseChapter(file.n, file.raw).basis) throw new FrameNotBasisError(file.path);
  }
}

/**
 * Chapter files a boot scan would turn back into a written chapter (B2). The frame slots are
 * judged separately (`assertFrameIsBasis`); every other `chNN.md` holding prose is a book the
 * next restart would resurrect, so a successful reset would be undone by a boot.
 */
function scanProse(bookRoot: string): { proseChapters: number; files: string[] } {
  const scan = scanManuscript(bookRoot);
  const files: string[] = [];
  for (const chapter of scan.chapters) {
    if (chapter.n === FRAME_SLOTS[0] || chapter.n === FRAME_SLOTS[1]) continue;
    const parsed = parseChapter(chapter.n, chapter.raw);
    if (parsed.blocks.length > 0 && !parsed.basis) files.push(chapter.fileName);
  }
  return { proseChapters: files.length, files };
}

function dropEventTriggers(db: Db): void {
  for (const trigger of REQUIRED_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
}

function createEventTriggers(db: Db): void {
  db.exec(EVENTS_TRIGGERS_SQL);
}

function wipe(db: Db): void {
  for (const table of WIPE_BEFORE_COMMENTS) db.exec(`DELETE FROM ${table}`);
  // `changes.source_comment` is the one reference *into* comments (§6F.4 reader changes):
  // null it first, or the comment rows cannot go.
  db.exec('UPDATE changes SET source_comment = NULL');
  for (const table of WIPE_AFTER_COMMENTS) db.exec(`DELETE FROM ${table}`);
  db.prepare(`DELETE FROM meta WHERE k IN (${META_KEYS.map(() => '?').join(', ')})`).run(...META_KEYS);
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
 * answers a caller must distinguish: a busy engine (`409`), a manuscript that still holds prose
 * (`409`), a missing or rewritten frame (`409`) and a backup that could not be verified
 * (`500`, or a warning with `backupOk`).
 */
export function resetBook(db: Db, options: ResetOptions): ResetReport {
  const tables = countBook(db);
  const total = totalOf(tables);
  const kept = countKept(db);
  const engine = countEngine(db);
  const prose = scanProse(options.bookRoot);
  const frame: [number, number] = [FRAME_SLOTS[0], FRAME_SLOTS[1]];
  const report: ResetReport = {
    dryRun: options.dryRun,
    tables,
    total,
    kept,
    frame,
    engine,
    manuscript: { proseChapters: prose.proseChapters },
    backup: null,
    backupSkipped: null,
  };
  // A dry run reports what a wipe would do and refuses nothing: the counts are the answer.
  if (options.dryRun) return report;

  if (engine.openSteps > 0 || engine.liveLeases > 0) throw new EngineBusyError(engine);
  // B2: a chapter file the manuscript still holds would be re-ingested by the next boot scan,
  // so the reset refuses before it writes anything — no backup, no wipe.
  if (prose.proseChapters > 0) throw new ManuscriptWrittenError(prose.files);
  const frameFiles = readFrame(options.bookRoot);
  assertFrameIsBasis(frameFiles);

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
    for (const file of frameFiles) {
      applyChapterFile({ db, dataDir: options.dataDir, n: file.n, raw: file.raw, mtimeMs: file.mtimeMs, nowMs });
    }
    setMeta(db, 'state_version', String(nextVersion));
    assertWiped(db, nextVersion);
  });
  run();

  if (warning !== undefined) report.warning = warning;
  return report;
}
