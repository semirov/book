/**
 * BOOK-137 — what a wipe would remove, as counters. Read-only by construction: every query here
 * is a `SELECT`, so the same functions serve the live book, a dry run and the verification of a
 * backup copy (`backup.ts`).
 *
 * The SQL is a code constant: no caller ever supplies a table name.
 */

import type { Db } from '../db/db.ts';

/** One line of the answer: a counter, its human label, and what it counted. */
export type BookCount = { key: string; label: string; rows: number };

/** A table the reset keeps, reported so the operator sees it survived. */
export type KeptCount = { key: string; rows: number };

export type EngineState = { openSteps: number; liveLeases: number };

/** What the manuscript itself would put back: chapter files a boot scan would resurrect. */
export type ManuscriptState = { proseChapters: number };

/** Every counter, in the order the operator's table prints them. */
const COUNTERS: ReadonlyArray<{ key: string; label: string; sql: string }> = [
  {
    key: 'chapters',
    label: 'chapters (written)',
    sql: 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0',
  },
  {
    key: 'blocks',
    label: 'blocks',
    sql: 'SELECT COUNT(*) AS n FROM blocks JOIN chapters AS c ON c.n = blocks.chapter WHERE c.basis = 0',
  },
  { key: 'revisions', label: 'revisions', sql: 'SELECT COUNT(*) AS n FROM revisions' },
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
  { key: 'block_lineage', label: 'block_lineage', sql: 'SELECT COUNT(*) AS n FROM block_lineage' },
  { key: 'block_versions', label: 'block_versions', sql: 'SELECT COUNT(*) AS n FROM block_versions' },
  // BOOK-176: the ledger's own rows. Without these the wipe would look complete while a fact,
  // a mention or a literal survived it — `assertWiped` reads exactly this list.
  { key: 'facts', label: 'facts', sql: 'SELECT COUNT(*) AS n FROM facts' },
  { key: 'threads', label: 'threads', sql: 'SELECT COUNT(*) AS n FROM threads' },
  { key: 'thread_events', label: 'thread_events', sql: 'SELECT COUNT(*) AS n FROM thread_events' },
  { key: 'mentions', label: 'mentions', sql: 'SELECT COUNT(*) AS n FROM mentions' },
  { key: 'literals', label: 'literals', sql: 'SELECT COUNT(*) AS n FROM literals' },
  // ADR-044: sentences are content, not a projection of the files — a reset that kept them would
  // publish ids that name spans of blocks nobody can read any more. Like `blocks`, the count is
  // about the book: the two frame slots hold one paragraph each after a wipe, and they are not
  // content a reset removed.
  {
    key: 'sentences',
    label: 'sentences',
    sql: `SELECT COUNT(*) AS n FROM sentences s
            JOIN blocks b ON b.id = s.block_id
            JOIN chapters c ON c.n = b.chapter
           WHERE c.basis = 0`,
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

export function totalOf(tables: readonly BookCount[]): number {
  return tables.reduce((sum, entry) => sum + entry.rows, 0);
}
