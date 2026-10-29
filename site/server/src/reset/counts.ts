/**
 * BOOK-137 — what a wipe would remove, as counters. Read-only by construction: every query here
 * is a `SELECT`, so the same functions serve the live book, a dry run and the verification of a
 * backup copy (`backup.ts`).
 *
 * BOOK-202: ch01 is kept, so a counter no longer means «every row of the table» — it means
 * «every row the wipe removes». The chapter-scoped counters exclude ch01 by number and the
 * graph counters read the very predicates `reset/book.ts` deletes with (`chapter1.ts`), so the
 * dry run and the wipe cannot disagree about what is content.
 *
 * The SQL is a code constant: no caller ever supplies a table name.
 */

import type { Db } from '../db/db.ts';
import {
  BLOCK_LINEAGE_WIPED,
  BLOCK_VERSIONS_WIPED,
  CHAPTER_BLOCKS_WIPED,
  CHAPTERS_WIPED,
  EXTRACTION_RUNS_WIPED,
  FACTS_WIPED,
  FACT_DEPENDENCY_WIPED,
  LITERALS_WIPED,
  MENTIONS_WIPED,
  REVISIONS_WIPED,
  THREAD_EVENTS_WIPED,
  THREADS_WIPED,
} from './chapter1.ts';

/** One line of the answer: a counter, its human label, and what it counted. */
export type BookCount = { key: string; label: string; rows: number };

/** A table the reset keeps, reported so the operator sees it survived. */
export type KeptCount = { key: string; rows: number };

export type EngineState = { openSteps: number; liveLeases: number };

/**
 * The book's content as a dry run reports it, counted from rows (BOOK-187): the chapters the
 * wipe will remove, their characters and their paragraphs. A row is the only place the book is,
 * so this is the only place the count can come from.
 */
export type ContentState = { written: number; chars: number; blocks: number };

/** Every counter, in the order the operator's table prints them. */
const COUNTERS: ReadonlyArray<{ key: string; label: string; sql: string }> = [
  // BOOK-202: ch01 is kept. Every counter below names what the wipe removes, and the wipe
  // removes nothing of ch01 — so the dry run keeps answering «what would go».
  {
    key: 'chapters',
    label: 'chapters (written)',
    sql: `SELECT COUNT(*) AS n FROM chapters WHERE ${CHAPTERS_WIPED}`,
  },
  {
    key: 'blocks',
    label: 'blocks',
    sql: `SELECT COUNT(*) AS n FROM blocks JOIN chapters AS c ON c.n = blocks.chapter WHERE ${CHAPTER_BLOCKS_WIPED}`,
  },
  { key: 'revisions', label: 'revisions', sql: `SELECT COUNT(*) AS n FROM revisions WHERE ${REVISIONS_WIPED}` },
  { key: 'changes', label: 'changes', sql: 'SELECT COUNT(*) AS n FROM changes' },
  { key: 'change_events', label: 'change_events', sql: 'SELECT COUNT(*) AS n FROM change_events' },
  { key: 'cascades', label: 'cascades', sql: 'SELECT COUNT(*) AS n FROM cascades' },
  { key: 'steps', label: 'steps', sql: 'SELECT COUNT(*) AS n FROM steps' },
  { key: 'gate_verdicts', label: 'gate_verdicts', sql: 'SELECT COUNT(*) AS n FROM gate_verdicts' },
  { key: 'gate_dispatches', label: 'gate_dispatches', sql: 'SELECT COUNT(*) AS n FROM gate_dispatches' },
  { key: 'leases', label: 'leases', sql: 'SELECT COUNT(*) AS n FROM leases' },
  { key: 'change_impact', label: 'change_impact', sql: 'SELECT COUNT(*) AS n FROM change_impact' },
  { key: 'comments', label: 'comments', sql: 'SELECT COUNT(*) AS n FROM comments' },
  { key: 'comment_events', label: 'comment_events', sql: 'SELECT COUNT(*) AS n FROM comment_events' },
  { key: 'feedback_batches', label: 'feedback_batches', sql: 'SELECT COUNT(*) AS n FROM feedback_batches' },
  { key: 'reconciles', label: 'reconciles', sql: 'SELECT COUNT(*) AS n FROM reconciles' },
  { key: 'events', label: 'events', sql: 'SELECT COUNT(*) AS n FROM events' },
  { key: 'front_revisions', label: 'front_revisions', sql: 'SELECT COUNT(*) AS n FROM front_revisions' },
  {
    key: 'block_lineage',
    label: 'block_lineage',
    sql: `SELECT COUNT(*) AS n FROM block_lineage WHERE ${BLOCK_LINEAGE_WIPED}`,
  },
  {
    key: 'block_versions',
    label: 'block_versions',
    sql: `SELECT COUNT(*) AS n FROM block_versions WHERE ${BLOCK_VERSIONS_WIPED}`,
  },
  // BOOK-176: the ledger's own rows. Without these the wipe would look complete while a fact,
  // a mention or a literal survived it — `assertWiped` reads exactly this list. BOOK-202: each
  // predicate below is the one the wipe deletes with, so ch01's corner of the graph is not
  // counted as content.
  { key: 'facts', label: 'facts', sql: `SELECT COUNT(*) AS n FROM facts WHERE ${FACTS_WIPED}` },
  // BOOK-DOC-77: the extraction runs a fact or an edge names. A reset that kept them would leave
  // the audit of a book that no longer exists — but a run a kept ch01 row still names stays.
  {
    key: 'extraction_runs',
    label: 'extraction_runs',
    sql: `SELECT COUNT(*) AS n FROM extraction_runs WHERE ${EXTRACTION_RUNS_WIPED}`,
  },
  // BOOK-185: the edges. Retired through `superseded_by` in the book, but the launch reset is the
  // one wipe that empties them — a closure over facts that no longer exist is not history.
  {
    key: 'fact_dependency',
    label: 'fact_dependency',
    sql: `SELECT COUNT(*) AS n FROM fact_dependency WHERE ${FACT_DEPENDENCY_WIPED}`,
  },
  { key: 'threads', label: 'threads', sql: `SELECT COUNT(*) AS n FROM threads WHERE ${THREADS_WIPED}` },
  {
    key: 'thread_events',
    label: 'thread_events',
    sql: `SELECT COUNT(*) AS n FROM thread_events WHERE ${THREAD_EVENTS_WIPED}`,
  },
  { key: 'mentions', label: 'mentions', sql: `SELECT COUNT(*) AS n FROM mentions WHERE ${MENTIONS_WIPED}` },
  { key: 'literals', label: 'literals', sql: `SELECT COUNT(*) AS n FROM literals WHERE ${LITERALS_WIPED}` },
  // ADR-044: sentences are content, not a projection of the files — a reset that kept them would
  // publish ids that name spans of blocks nobody can read any more. Like `blocks`, the count is
  // about the book: the frame slot holds one paragraph after a wipe, it was not content a reset
  // removed, and neither are ch01's sentences (BOOK-202).
  {
    key: 'sentences',
    label: 'sentences',
    sql: `SELECT COUNT(*) AS n FROM sentences s
            JOIN blocks b ON b.id = s.block_id
            JOIN chapters c ON c.n = b.chapter
           WHERE c.basis = 0 AND c.n <> 1`,
  },
  { key: 'sentence_touches', label: 'sentence_touches', sql: 'SELECT COUNT(*) AS n FROM sentence_touches' },
  { key: 'overwrites', label: 'overwrites', sql: 'SELECT COUNT(*) AS n FROM overwrites' },
  { key: 'contributions', label: 'contributions', sql: 'SELECT COUNT(*) AS n FROM contributions' },
  {
    key: 'contribution_history',
    label: 'contribution_history',
    sql: 'SELECT COUNT(*) AS n FROM contribution_history',
  },
  { key: 'rate_events', label: 'rate_events', sql: 'SELECT COUNT(*) AS n FROM rate_events' },
  // `state_version` is deliberately absent: the reset keeps it and bumps it (B1), because a
  // reader's page ignores a state whose version went backwards.
  {
    key: 'meta',
    label: 'meta keys',
    sql: "SELECT COUNT(*) AS n FROM meta WHERE k = 'engine.alerts'",
  },
  { key: 'lane', label: 'lane holder', sql: 'SELECT COUNT(*) AS n FROM lane WHERE holder IS NOT NULL' },
];

/** The tables the reset keeps, so the operator sees a book with its readers still in it. */
const KEPT = [
  { key: 'identities', sql: 'SELECT COUNT(*) AS n FROM identities' },
  { key: 'sessions', sql: 'SELECT COUNT(*) AS n FROM sessions' },
  { key: 'front_matter', sql: 'SELECT COUNT(*) AS n FROM front_matter' },
] as const;

function count(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { n: number };
  return row.n;
}

/** The content counts, in the printed order. A read-only connection answers the same way. */
export function countBook(db: Db): BookCount[] {
  return COUNTERS.map(({ key, label, sql }) => ({ key, label, rows: count(db, sql) }));
}

export function countKept(db: Db): KeptCount[] {
  return KEPT.map(({ key, sql }) => ({ key, rows: count(db, sql) }));
}

/** What a wipe would interrupt: an open step, or a lease nobody released. */
export function countEngine(db: Db): EngineState {
  return {
    openSteps: count(db, 'SELECT COUNT(*) AS n FROM steps WHERE outcome IS NULL'),
    liveLeases: count(db, 'SELECT COUNT(*) AS n FROM leases WHERE released_at IS NULL'),
  };
}

/**
 * The content a wipe removes, from the projection: written chapters, their characters and
 * paragraphs. BOOK-202: ch01 is kept, so it is not content — the dry run's «what the wipe
 * removes» excludes it by number, exactly as the counters do.
 */
export function countContent(db: Db): ContentState {
  return {
    written: count(db, `SELECT COUNT(*) AS n FROM chapters WHERE ${CHAPTERS_WIPED} AND block_count > 0`),
    chars: count(db, 'SELECT COALESCE(SUM(chars), 0) AS n FROM chapters WHERE basis = 0 AND n <> 1'),
    blocks: count(db, 'SELECT COUNT(*) AS n FROM blocks WHERE chapter <> 1'),
  };
}

export function totalOf(tables: readonly BookCount[]): number {
  return tables.reduce((sum, entry) => sum + entry.rows, 0);
}
