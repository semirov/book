/**
 * `FACT_NOT_ESTABLISHED` (BOOK-185, ADR-043 L3; widened by BOOK-DOC-77 §5).
 *
 * A `use` mention says «the text relies on a fact the book already holds». Two ways that claim can
 * be a lie, and both are refused here rather than written:
 *
 *   · the fact it names is first asserted in the same chapter or in a later one — chapter 4
 *     cannot consume what chapter 6 establishes;
 *   · the fact it names was **retired by an extraction run** (`superseded_by_extraction`) — a
 *     forced re-run of chapter 2 that drops a fact must not leave chapter 5's use of it standing
 *     over a row that is no longer the graph. The mention is not rewritten: the run that would
 *     orphan it is the one that rolls back.
 *
 * The check is a query, not a convention: it runs at the end of the extraction, inside the
 * transaction, so the rows it would condemn are still uncommitted and can be rolled back.
 */

import type { Db } from '../db/db.ts';

export type UnestablishedUse = {
  mentionId: number;
  chapter: number;
  factId: string;
  factChapter: number;
  witness: string;
  /** The fact was retired by an extraction run — the second way a `use` stops being true. */
  retired: number;
};

/** Every `use` mention whose fact is established at the mention's chapter or later, or is retired. */
export function usesBeforeEstablishment(db: Db): UnestablishedUse[] {
  return db
    .prepare(
      `SELECT m.id AS mentionId, m.chapter AS chapter, m.fact_id AS factId,
              f.chapter AS factChapter, m.witness AS witness,
              CASE WHEN f.superseded_by_extraction IS NULL THEN 0 ELSE 1 END AS retired
         FROM mentions m
         JOIN facts f ON f.id = m.fact_id
        WHERE m.kind = 'fact' AND m.role = 'use'
          AND (f.chapter >= m.chapter OR f.superseded_by_extraction IS NOT NULL)
        ORDER BY m.chapter, m.id`,
    )
    .all() as UnestablishedUse[];
}

export class FactNotEstablishedError extends Error {
  readonly code = 'FACT_NOT_ESTABLISHED';
  constructor(readonly rows: UnestablishedUse[]) {
    // The reason is a chapter number and a quote — never the row's own history.
    const first = rows[0];
    super(
      `FACT_NOT_ESTABLISHED: ${String(rows.length)} use mention(s) name a fact the book does not hold` +
        (first === undefined
          ? ''
          : ` (first: chapter ${String(first.chapter)}, "${first.witness}", ` +
            (first.retired === 1
              ? 'fact retired by an extraction run)'
              : `fact of chapter ${String(first.factChapter)})`)),
    );
    this.name = 'FactNotEstablishedError';
  }
}

/** Throw when the graph reads backwards. A clean graph returns nothing and writes nothing. */
export function assertFactsEstablished(db: Db): void {
  const rows = usesBeforeEstablishment(db);
  if (rows.length > 0) throw new FactNotEstablishedError(rows);
}
