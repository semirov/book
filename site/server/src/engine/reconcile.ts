/**
 * `reconcile <chapter>` — the operator's mark on a restore (ARCHITECTURE.md §13.3).
 *
 * A restore is published without the gates, so the panel keeps asking about it. The operator
 * answers once: `reconcile` re-runs the cheap validator over the book as it stands now,
 * records who did it, when, and why, and the chapter stops being `ungated`. The mark does not
 * make the text blessed — a failing gate is recorded as `passed:false` and reported — and it
 * does not create a change, a step or a lease: a restore is still not a change.
 *
 * The next step that touches the chapter replaces the restore as the latest revision, and
 * then the chapter is gated by that step's two verdicts and nothing here matters any more.
 */

import { TOTAL_CHAPTERS, type ValidatorFinding } from '@book/shared';

import type { Db } from '../db/db.ts';
import { readIntegrity } from '../integrity/service.ts';
import { recordReconcile, ungatedOf, type ReconcileValidation } from '../integrity/ungated.ts';
import { recordOperatorRestore } from '../history/restore.ts';
import { loadImprint } from '../imprint.ts';
import { refuse, type EngineDeps } from './types.ts';

const BECAUSE_MAX_CHARS = 200;

export type RestoreReconcileInput = {
  chapter: number;
  because: string;
  actor?: string;
  now?: number;
};

export type RestoreReconcileResult = {
  chapter: number;
  rev: number;
  restoredRev: number | null;
  at: string;
  actor: string;
  because: string;
  validation: ReconcileValidation;
  findings: ValidatorFinding[];
};

/** The imprint is a legal statement; a drifting one is reported by F020, not fatal here. */
function imprintOrNull(deps: EngineDeps) {
  try {
    return loadImprint(deps.config.imprintPath);
  } catch {
    return null;
  }
}

export function reconcileRestore(deps: EngineDeps, input: RestoreReconcileInput): RestoreReconcileResult {
  const db: Db = deps.db;
  const now = input.now ?? deps.clock.now();
  const chapter = input.chapter;
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) {
    refuse('INVALID_CHAPTER', 422, `chapter must be an integer between 1 and ${String(TOTAL_CHAPTERS)}`);
  }
  const because = input.because.trim().slice(0, BECAUSE_MAX_CHARS);
  if (because.length === 0) refuse('INVALID_REASON', 422, 'reconcile needs --because: the operator’s own words');

  const ungated = ungatedOf(db, chapter);
  if (ungated === null) {
    refuse('NOT_UNGATED', 409, `глава ${chapter} не ждёт сверки: последняя ревизия — не восстановление`, {
      chapter,
    });
  }

  const report = readIntegrity(db, {
    denylistPath: deps.config.denylistPath,
    imprint: imprintOrNull(deps) ?? { author: '', copyright: '', publisher: null, year: 'auto' },
    nowMs: now,
  });
  const rules = [...new Set(report.validator.findings.map((finding) => finding.rule))].sort();
  const validation: ReconcileValidation = {
    errors: report.validator.errors,
    warnings: report.validator.warnings,
    passed: report.validator.errors === 0,
    rules,
  };

  // One act, two records, one transaction: the operator's log entry and the panel's mark.
  // The text fact (`chapter.restored`) was written by the ingest, not here.
  const run = db.transaction(() => {
    const { hseq } = recordOperatorRestore(db, {
      chapter,
      sourceRev: ungated.restoredRev ?? ungated.rev,
      newRev: ungated.rev,
      because,
      nowMs: now,
    });
    return recordReconcile(db, {
      chapter,
      rev: ungated.rev,
      actor: input.actor ?? 'operator',
      because,
      validation,
      hseq,
      nowMs: now,
    });
  });
  const row = run();

  return {
    chapter,
    rev: row.rev,
    restoredRev: ungated.restoredRev,
    at: row.at,
    actor: row.actor,
    because: row.because,
    validation: row.validation,
    findings: report.validator.findings.slice(0, 20),
  };
}
