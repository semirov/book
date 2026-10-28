/**
 * BOOK-58 §10 — the moment a landed variant is entered into the book («внесено»).
 *
 * The submission record (`terms_version`, `terms_sha`) says what a reader accepted when they
 * filed. The **acceptance** record is a second fact, and it is written here, once: a variant
 * that actually entered the book has an `accepted_at` and the version that moment accepted.
 * A rejected, dropped or superseded variant stays the reader's — no acceptance row, and no
 * `applied` event, because nothing was entered.
 *
 * Three rules shape this module:
 *   - **a landing only.** The row must be a reader's change (`source_comment` is not null),
 *     `done`, and `applied`/`adapted` — the outcomes a landing is closed with. Every other
 *     value is silence, not a default;
 *   - **something to assign.** The filing must carry an intervention kind. A **note** — a
 *     filing with no kind — transfers nothing («Замечание без типа ничего не передаёт»,
 *     `RIGHTS_RETAINED` in `shared/src/terms.ts`), so it has nothing to accept and is excluded
 *     here exactly as the page promises;
 *   - **once.** The write is a conditional UPDATE (`accepted_at IS NULL`), and the event is
 *     appended only when that UPDATE actually changed a row — a second close, a replay or a
 *     race appends nothing. The moment is never rewritten.
 *
 * A row stored before the versioned terms (v19) has no `terms_version`: the moment is still
 * recorded, and `accepted_terms_version` stays null — «the filing predates the versioned terms;
 * the terms it accepted are unknown — never guessed».
 *
 * The record carries no text, no body and no identity: the change id, its outcome and the terms
 * it accepted are the whole row, and the hash was taken at posting from the same shared copy
 * the page printed.
 */

import type { Db } from '../db/db.ts';
import { appendCommentEvent } from './repo.ts';

/** The outcomes a landed change is closed with; anything else is not a landing. */
const LANDED_OUTCOMES = new Set(['applied', 'adapted']);

type AcceptanceFacts = {
  source_comment: string | null;
  intervention_kind: string | null;
  outcome: string | null;
  status: string;
  terms_version: string | null;
  terms_sha: string | null;
};

/**
 * Record that the reader's variant entered the book. Called by the two landing paths — the
 * ordinary close (`engine/close.ts`) and a settled premise (`engine/premise.ts`) — after the
 * change row itself is final, so this function reads the outcome it records and never decides
 * one.
 */
export function recordAcceptance(db: Db, changeId: string, at: string): void {
  const facts = db
    .prepare(
      `SELECT c.source_comment, c.outcome, c.status, m.intervention_kind, m.terms_version, m.terms_sha
         FROM changes c
         LEFT JOIN comments m ON m.id = c.source_comment
        WHERE c.id = ?`,
    )
    .get(changeId) as AcceptanceFacts | undefined;
  // A change the site made for itself (an operator edit, a continuity fix) has no reader row:
  // there is no terms promise to close and nothing to accept on their behalf.
  if (facts === undefined || facts.source_comment === null) return;
  // A note transfers nothing, so a landing note accepts nothing: the right never moved.
  if (facts.intervention_kind === null) return;
  if (facts.status !== 'done' || facts.outcome === null || !LANDED_OUTCOMES.has(facts.outcome)) return;
  const commentId = facts.source_comment;

  // The row must say what happened, not just remember the terms: `applied` with the chapter and
  // revision it entered (BOOK-183). The reason is written with the landing, in this transaction.
  const landed = db
    .prepare(
      `SELECT c.chapter AS chapter, COALESCE(ch.rev, 0) AS rev
         FROM changes c LEFT JOIN chapters ch ON ch.n = c.chapter
        WHERE c.id = ?`,
    )
    .get(changeId) as { chapter: number; rev: number } | undefined;
  const appliedReason =
    landed === undefined ? 'вошло в книгу' : `вошло в редакцию главы ${String(landed.chapter)} (ред. ${String(landed.rev)})`;

  db.transaction(() => {
    db.prepare(`UPDATE comments SET status = 'applied', reason = ? WHERE id = ? AND status NOT IN ('applied','rejected','superseded','hidden')`).run(
      appliedReason,
      commentId,
    );
    const written = db
      .prepare(
        `UPDATE comments SET accepted_at = ?, accepted_terms_version = terms_version
          WHERE id = ? AND accepted_at IS NULL`,
      )
      .run(at, commentId).changes;
    // No confirmation, no side effect: the second close of a landing is a silent no-op here.
    if (written !== 1) return;
    appendCommentEvent(db, commentId, 'applied', at, {
      changeId,
      outcome: facts.outcome,
      termsVersion: facts.terms_version,
      termsSha: facts.terms_sha,
    });
  })();
}
