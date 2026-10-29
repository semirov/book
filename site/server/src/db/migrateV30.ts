/**
 * Migration v30 (BOOK-206, ADR-045) — the filing's own ledger becomes the triage queue, and no
 * filing waits for a person any more.
 *
 * Two things happen here.
 *
 * **The columns.** `comment_attempts` gains what a claim needs (`claim_by`, `claim_until`,
 * `tries`), what a backoff needs (`next_at`) and what one read of the book owes the ladder
 * (`verdict`, `verdict_at`), plus the `comment_attempts_due (outcome, next_at)` index. They are
 * `ADD COLUMN`s from the same constant a fresh install builds (`tables.ts`), appended in the same
 * order, so a migrated install equals a fresh one column for column.
 *
 * **The legacy set operation.** A row that once ended as `escalated` is a row the ladder never
 * placed: it is re-opened to `new` with the chain and the decision cleared, `audit_*` kept (gate
 * C's answer is never rewritten), one `comment_events('reopened')` per changed row, and a
 * `submitted` attempt — because the trigger a model is claimed by is an attempt row, and a row
 * re-opened by a migration has to be as due as a row posted a second ago.
 *
 * **Idempotent to the statement.** The re-open's `WHERE` no longer matches after it runs, and
 * every column is guarded by `table_info`, so a second run changes nothing — which is what
 * `migrate` promises for every step.
 */

import type { Db } from './db.ts';
import { anchorSha } from '../comments/attempts.ts';

/** The columns v30 appends, in the order a fresh install declares them. */
export const V30_ATTEMPT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['claim_by', 'TEXT'],
  ['claim_until', 'TEXT'],
  ['tries', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_at', 'TEXT'],
  ['verdict', 'TEXT'],
  ['verdict_at', 'TEXT'],
];

function columnNames(db: Db, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}

/** The one `comment_events` row a re-opened filing gets: the fact, never the reader's words. */
function reopenEvent(db: Db, commentId: string, at: string): void {
  db.prepare('INSERT INTO comment_events (comment_id, at, type, meta) VALUES (?, ?, ?, ?)').run(
    commentId,
    at,
    'reopened',
    JSON.stringify({ reason: 'v30' }),
  );
}

type ReopenRow = {
  id: string;
  chapter: number;
  block_id: string | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  body_sha: string;
};

/** The attempt a re-opened filing is claimed by: `n = max+1`, `submitted`, now. */
function armAttempt(db: Db, row: ReopenRow, at: string): void {
  const submitted = db
    .prepare(`SELECT 1 AS one FROM comment_attempts WHERE comment_id = ? AND outcome = 'submitted' LIMIT 1`)
    .get(row.id);
  if (submitted !== undefined) return;
  const next = (
    db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM comment_attempts WHERE comment_id = ?').get(row.id) as {
      n: number;
    }
  ).n;
  db.prepare(
    `INSERT INTO comment_attempts (comment_id, n, at, day, body_sha, anchor_sha, quote, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`,
  ).run(row.id, next, at, at.slice(0, 10), row.body_sha, anchorSha(row), row.quote);
}

/**
 * Re-open every filing the ladder could not place (ADR-045 §6). Returns the ids it changed, so a
 * caller — a test — can tell a rewrite from a no-op.
 */
export function reopenEscalated(db: Db, at: string): string[] {
  const rows = db
    .prepare(
      `SELECT id, chapter, block_id, quote, prefix, suffix, body_sha FROM comments
        WHERE status = 'escalated' OR disposition = 'escalated'
        ORDER BY created_at, id`,
    )
    .all() as ReopenRow[];
  for (const row of rows) {
    // The chain and the decision go; `audit_*` is gate C's own answer and stays. The link to a
    // change and the receipt go too: an escalated row starts the new path with **no** link, so
    // `acceptComment` cannot no-op over a change the old door never placed, and the new change
    // is the only one this filing will ever name.
    db.prepare(
      `UPDATE comments
          SET status = 'new', disposition = NULL, lock = NULL, carrier_kind = NULL, quote_kept = NULL,
              decided_at = NULL, reason = NULL, change_id = NULL, applied_chapter = NULL, applied_rev = NULL
        WHERE id = ?`,
    ).run(row.id);
    reopenEvent(db, row.id, at);
    armAttempt(db, row, at);
  }
  return rows.map((row) => row.id);
}

/**
 * The v30 step. `run` is a transaction in `migrate`, so a failure leaves neither a half-added
 * column nor a re-opened row without its attempt.
 */
export function migrateV30(db: Db): void {
  const columns = columnNames(db, 'comment_attempts');
  for (const [name, definition] of V30_ATTEMPT_COLUMNS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE comment_attempts ADD COLUMN ${name} ${definition}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS comment_attempts_due ON comment_attempts(outcome, next_at)');
  reopenEscalated(db, new Date().toISOString());
}
