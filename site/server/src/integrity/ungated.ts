/**
 * `ungated` and `reconcile` (ARCHITECTURE.md §13.3).
 *
 * A restore is a human overriding the process: it does not queue and does not cascade, so it
 * never runs the two gates. The chapter therefore carries `ungated: true` — «this text was
 * put back without a gate» — until the next step touches it (a new revision replaces the
 * restore as the latest one) or an operator runs `reconcile`, which re-runs the validator
 * over the text and records who did it and why.
 *
 * The mark is a row, never a flag: the panel derives `ungated` from the latest revision and
 * the absence of a `reconciles` row, so the same database always gives the same answer.
 */

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';

export type UngatedChapter = {
  chapter: number;
  /** The restore revision that is still the latest word on this chapter. */
  rev: number;
  at: string;
  /** The revision the operator rolled back to, when the log note carries it. */
  restoredRev: number | null;
};

export type ReconcileRow = {
  id: number;
  chapter: number;
  rev: number;
  at: string;
  actor: string;
  because: string;
  validation: ReconcileValidation;
  /** The `operator.restore` entry the mark wrote; null for a pre-M7 row. */
  hseq: number | null;
};

export type ReconcileValidation = {
  errors: number;
  warnings: number;
  passed: boolean;
  /** Rule ids only: the panel is an operator tool, not a second finding store. */
  rules: string[];
};

type UngatedRow = { chapter: number; rev: number; at: string; log_note: string | null };

export function restoredRevOf(note: string | null): number | null {
  const match = note === null ? null : /restore of rev (\d+)/u.exec(note);
  return match === null ? null : Number.parseInt(match[1] ?? '', 10);
}

/** Every chapter whose latest revision is a restore that no `reconcile` has marked yet. */
export function listUngated(db: Db): UngatedChapter[] {
  const rows = db
    .prepare(
      `SELECT r.chapter, r.rev, r.at, r.log_note FROM revisions r
         JOIN (SELECT chapter, MAX(rev) AS rev FROM revisions GROUP BY chapter) last
           ON last.chapter = r.chapter AND last.rev = r.rev
         LEFT JOIN reconciles k ON k.chapter = r.chapter AND k.rev = r.rev
        WHERE r.cause_kind = 'restore' AND k.id IS NULL
        ORDER BY r.chapter`,
    )
    .all() as UngatedRow[];
  return rows.map((row) => ({
    chapter: row.chapter,
    rev: row.rev,
    at: row.at,
    restoredRev: restoredRevOf(row.log_note),
  }));
}

/** One chapter's ungated fact, or null when its latest revision is not a restore. */
export function ungatedOf(db: Db, chapter: number): UngatedChapter | null {
  return listUngated(db).find((row) => row.chapter === chapter) ?? null;
}

export function listReconciles(db: Db, limit = 20): ReconcileRow[] {
  const rows = db
    .prepare(
      `SELECT id, chapter, rev, at, actor, because, validation, hseq FROM reconciles
        ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(200, limit))) as Array<Omit<ReconcileRow, 'validation'> & { validation: string }>;
  return rows.map((row) => ({
    ...row,
    validation: safeValidation(row.validation),
  }));
}

function safeValidation(raw: string): ReconcileValidation {
  try {
    const parsed = JSON.parse(raw) as Partial<ReconcileValidation>;
    return {
      errors: typeof parsed.errors === 'number' ? parsed.errors : 0,
      warnings: typeof parsed.warnings === 'number' ? parsed.warnings : 0,
      passed: parsed.passed === true,
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter((rule) => typeof rule === 'string') : [],
    };
  } catch {
    return { errors: 0, warnings: 0, passed: false, rules: [] };
  }
}

export type RecordReconcileInput = {
  chapter: number;
  rev: number;
  actor: string;
  because: string;
  validation: ReconcileValidation;
  /** The `operator.restore` entry written with the mark. */
  hseq?: number | null;
  nowMs?: number;
};

/** Insert the mark; a second reconcile of the same restore updates nothing and is a no-op. */
export function recordReconcile(db: Db, input: RecordReconcileInput): ReconcileRow {
  const at = toIso(input.nowMs ?? Date.now());
  const because = input.because.trim().slice(0, 200) || 'restore';
  db.prepare(
    `INSERT INTO reconciles (chapter, rev, at, actor, because, validation, hseq)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chapter, rev) DO UPDATE SET at = excluded.at, actor = excluded.actor,
       because = excluded.because, validation = excluded.validation, hseq = excluded.hseq`,
  ).run(
    input.chapter,
    input.rev,
    at,
    input.actor.trim().slice(0, 40) || 'operator',
    because,
    JSON.stringify(input.validation),
    input.hseq ?? null,
  );
  const row = db
    .prepare(
      'SELECT id, chapter, rev, at, actor, because, validation, hseq FROM reconciles WHERE chapter = ? AND rev = ?',
    )
    .get(input.chapter, input.rev) as Omit<ReconcileRow, 'validation'> & { validation: string };
  return { ...row, validation: safeValidation(row.validation) };
}
