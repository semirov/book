/**
 * The world's statements and their lifetime (BOOK-176, BOOK-DOC-69).
 *
 * A fact is what the book says is true — a document exists, a decision was taken, a testimony
 * was given, an erasure happened, a state holds — and it is **never deleted**: a statement that
 * stops being true is invalidated by the change that made it false, and the row stays so a
 * reader can ask «what did the book believe in chapter 9?». `facts_no_delete` is the database's
 * own promise of that.
 *
 * `factAsOf` is the question the ledger exists to answer. The validity test is the chapter in
 * which the *invalidating change* was filed, not the wall clock: a change filed at chapter 10
 * makes the old statement false from chapter 10 on, and a change still in the queue (chapter
 * 99, say) never reaches a chapter that is already published.
 */

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { ulid } from '../util/ulid.ts';

export type FactKind = 'document' | 'decision' | 'testimony' | 'erasure' | 'state';

export type FactRow = {
  id: string;
  chapter: number;
  kind: FactKind;
  statement: string;
  term: string | null;
  /** ADR-044 — the sentence that carries the statement; null for a row written before v25. */
  sentence_id: string | null;
  valid_from_chapter: number;
  invalidated_at: string | null;
  invalidated_by_change: string | null;
  created_at: string;
};

export type AssertFactInput = {
  chapter: number;
  kind: FactKind;
  statement: string;
  /** The canonical surface form a mention binds to; null = the fact is never mentioned. */
  term?: string | null;
  /**
   * ADR-044 — the sentence the statement is told in (a `snt_` id from `sentences`). Optional:
   * a fact with no live sentence is still a fact, it just cannot be quoted from the text.
   */
  sentenceId?: string | null;
  /** Defaults to `chapter`: a fact is true from the chapter that states it. */
  validFromChapter?: number;
  id?: string;
  at?: string;
};

/**
 * The facts true as of a chapter. `LEFT JOIN changes` keeps a fact whose invalidating change
 * row is gone (it cannot be, `changes` is the ledger too, but a join that dropped it would make
 * a fact silently valid forever). Ordered by arrival, so a reader sees the world build up.
 */
export function factAsOf(db: Db, chapter: number): FactRow[] {
  return db
    .prepare(
      `SELECT f.* FROM facts f LEFT JOIN changes c ON c.id = f.invalidated_by_change
        WHERE f.valid_from_chapter <= ?
          AND (f.invalidated_by_change IS NULL OR c.chapter > ?)
        ORDER BY f.valid_from_chapter, f.id`,
    )
    .all(chapter, chapter) as FactRow[];
}

/** Insert one statement and return its id. The row is the book's belief from now on. */
export function assertFact(db: Db, input: AssertFactInput): string {
  const id = input.id ?? `fct_${ulid()}`;
  db.prepare(
    `INSERT INTO facts
       (id, chapter, kind, statement, term, sentence_id, valid_from_chapter, invalidated_at,
        invalidated_by_change, created_at)
     VALUES (@id, @chapter, @kind, @statement, @term, @sentenceId, @validFrom, NULL, NULL, @createdAt)`,
  ).run({
    id,
    chapter: input.chapter,
    kind: input.kind,
    statement: input.statement,
    term: input.term ?? null,
    sentenceId: input.sentenceId ?? null,
    validFrom: input.validFromChapter ?? input.chapter,
    createdAt: input.at ?? toIso(Date.now()),
  });
  return id;
}

/**
 * Mark a statement false from the change that made it false. Not an update of the statement:
 * the old row keeps its text, its chapter and its own history.
 */
export function invalidateFact(
  db: Db,
  input: { id: string; changeId: string | null; at?: string },
): void {
  const result = db
    .prepare(
      `UPDATE facts SET invalidated_at = ?, invalidated_by_change = ?
        WHERE id = ? AND invalidated_at IS NULL`,
    )
    .run(input.at ?? toIso(Date.now()), input.changeId, input.id);
  // A second invalidation is not a second fact: the first one is the record. A missing row is a
  // caller's bug and is reported, not swallowed.
  if (result.changes === 0) {
    const exists = db.prepare('SELECT id FROM facts WHERE id = ?').get(input.id);
    if (exists === undefined) throw new Error(`unknown fact ${input.id}`);
  }
}
