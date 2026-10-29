/**
 * `graph audit` (BOOK-185, BOOK-DOC-77 §6): does the witness of a live fact still prove its key?
 *
 * Extraction asks this question once, when an answer is written (`supportProblem`). A row can stop
 * passing later: an extraction rule grows stricter, a fact is written by a path that never asked,
 * or an operator hand-fixes a witness. This command asks the same question of every live fact's
 * own `assert` mention and prints what no longer holds.
 *
 * **Read-only.** It writes nothing, calls no model and repairs nothing: a witness that does not
 * support its value is a finding an operator reads, and the run that fixes it is the extraction's.
 * The exit code is the gate: 0 when every witness holds, 1 when at least one does not.
 */

import type { Db } from '../db/db.ts';
import { supportProblem } from './quote.ts';
import { isFactKind } from './schema.ts';

/** One live fact whose witness does not prove its key. */
export type AuditFailure = {
  /** The fact's own chapter — where the value was established. */
  chapter: number;
  key: string;
  /** The witness as the mention stores it, so a reader sees what the quote says. */
  quote: string;
  reason: string;
};

export type AuditReport = {
  /** Facts whose witness was checked. */
  checked: number;
  failed: number;
  /** Live facts with no `assert` mention or no kind this file can judge: nothing to ask. */
  skipped: number;
  failures: AuditFailure[];
};

type Row = { id: string; chapter: number; kind: string; key: string; witness: string | null };

/**
 * Every live fact of the chapter (or of the book), judged by the first `assert` mention it owns —
 * the earliest one in reading order, which is the sentence that established it. A fact with no
 * such mention has no witness to audit, and is counted, not guessed at.
 */
export function auditFacts(db: Db, options: { chapter?: number } = {}): AuditReport {
  const chapter = options.chapter ?? null;
  const rows = db
    .prepare(
      `SELECT f.id AS id, f.chapter AS chapter, f.kind AS kind, f.key AS key, m.witness AS witness
         FROM facts f
         LEFT JOIN mentions m
           ON m.fact_id = f.id AND m.kind = 'fact' AND m.role = 'assert'
        WHERE f.invalidated_at IS NULL AND f.superseded_by_extraction IS NULL AND f.key <> ''
          AND (? IS NULL OR f.chapter = ?)
        ORDER BY f.chapter, f.key, m.start, m.id`,
    )
    .all(chapter, chapter) as Row[];

  const seen = new Set<string>();
  const failures: AuditFailure[] = [];
  let checked = 0;
  let skipped = 0;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.witness === null || !isFactKind(row.kind)) {
      skipped += 1;
      continue;
    }
    checked += 1;
    const reason = supportProblem(row.kind, row.key, row.witness);
    if (reason !== null) failures.push({ chapter: row.chapter, key: row.key, quote: row.witness, reason });
  }
  return { checked, failed: failures.length, skipped, failures };
}

/** The report as lines a terminal reads: one finding each, then the summary. */
export function renderAudit(report: AuditReport): string[] {
  const lines = report.failures.map(
    (failure) => `ch${String(failure.chapter)} ${failure.key} — ${failure.reason} · «${failure.quote}»`,
  );
  lines.push(
    `audit: ${String(report.checked)} live facts checked, ${String(report.failed)} unsupported` +
      (report.skipped === 0 ? '' : `, ${String(report.skipped)} without a witness`),
  );
  return lines;
}
