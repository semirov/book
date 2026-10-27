/**
 * The integrity panel's one query (ARCHITECTURE.md §13.4 point 5, §17).
 *
 * The site never blocks publication: it runs the cheap rule subset over the files it can
 * see (F001, F002, F005–F007, F009, F020–F022, F029), reads the legal denylist, and reports
 * it found. The panel is an operator tool, and every field here answers a question an
 * operator would otherwise ask the database by hand:
 *
 * - is the text legal and well-formed right now (`validator`, `legal`)?
 * - does the denylist have teeth (`legal`)?
 * - is anything on the page uncredited (`attribution`, F015)?
 * - is any chapter sitting on a restore that never ran the gates (`ungated`, §13.3)?
 *
 * Nothing here is cached: an integrity answer that lags the text would be a worse answer
 * than a slow one, and the route is called by an operator, not by a reader.
 */

import type { Imprint, LegalDenylist, ValidatorFinding } from '@book/shared';
import { runValidation, type ValidateResult } from '@book/shared';

import type { Db } from '../db/db.ts';
import { scanManuscript } from '../ingest/scanManuscript.ts';
import { toIso } from '../util/time.ts';
import { loadDenylist } from './config.ts';
import {
  listReconciles,
  listUngated,
  restoredRevOf,
  type ReconcileRow,
  type UngatedChapter,
} from './ungated.ts';

/** `F007` says a chapter under the band is thin; the panel counts, it does not judge. */
const THIN_LIMIT = 20_000;
const FINDING_LIMIT = 50;

export type IntegrityAttributionRow = {
  chapter: number;
  rev: number;
  at: string;
  kind: string;
};

export type IntegrityRestoreRow = {
  chapter: number;
  rev: number;
  at: string;
  restoredRev: number | null;
};

export type IntegrityReport = {
  at: string;
  chapters: {
    written: number;
    total: number;
    totalChars: number;
    thin: number[];
  };
  legal: {
    denylistVersion: number | null;
    persons: number;
    characters: number;
    organisations: number;
    patterns: number;
    /** A denylist or pattern that cannot be used: the legal gate is not running. */
    problems: string[];
  };
  validator: {
    errors: number;
    warnings: number;
    passed: boolean;
    findings: ValidatorFinding[];
    /** Findings beyond the first `FINDING_LIMIT`; the counts above are complete. */
    truncated: number;
  };
  attribution: {
    /** F015: revisions with no lease behind them (§17 lease integrity). */
    unattributed: number;
    recent: IntegrityAttributionRow[];
  };
  ungated: UngatedChapter[];
  restores: {
    total: number;
    recent: IntegrityRestoreRow[];
  };
  reconciles: ReconcileRow[];
};

export type IntegrityOptions = {
  bookRoot: string;
  denylistPath: string;
  imprint: Imprint;
  /** Injected in tests; the route uses the clock. */
  nowMs?: number;
  /** Injected in tests; the route reads the file once per call. */
  denylist?: LegalDenylist | null;
};

type CountRow = { n: number };

function validate(options: IntegrityOptions, denylist: LegalDenylist | null): ValidateResult {
  const scan = scanManuscript(options.bookRoot);
  const files = [
    ...scan.chapters.map((chapter) => ({ name: chapter.fileName, text: chapter.raw })),
    ...(scan.front === null ? [] : [{ name: scan.front.fileName, text: scan.front.raw }]),
  ];
  return runValidation({ files, denylist, imprint: options.imprint });
}

export function readIntegrity(db: Db, options: IntegrityOptions): IntegrityReport {
  const nowMs = options.nowMs ?? Date.now();
  const at = toIso(nowMs);
  const loaded =
    options.denylist === undefined ? loadDenylist(options.denylistPath) : { denylist: options.denylist, problems: [] };
  const denylist = loaded.denylist;
  const result = validate(options, denylist);

  // A slot is written when it has prose: a basis-only or zero-block row is an empty slot (BOOK-6).
  const written = db
    .prepare('SELECT COUNT(*) AS n FROM chapters WHERE block_count > 0 AND basis = 0')
    .get() as CountRow;
  const totalChars = db.prepare('SELECT COALESCE(SUM(chars), 0) AS n FROM chapters').get() as CountRow;
  const thin = result.chapters.filter((chapter) => chapter.chars < THIN_LIMIT).map((chapter) => chapter.n);

  const unattributed = db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE attributed = 0').get() as CountRow;
  const recentUnattributed = db
    .prepare('SELECT chapter, rev, at, kind FROM revisions WHERE attributed = 0 ORDER BY at DESC, chapter, rev LIMIT 10')
    .all() as IntegrityAttributionRow[];

  const restores = db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE cause_kind = 'restore'`).get() as CountRow;
  const recentRestores = db
    .prepare(
      `SELECT chapter, rev, at, log_note FROM revisions
        WHERE cause_kind = 'restore' ORDER BY at DESC, chapter, rev LIMIT 10`,
    )
    .all() as Array<{ chapter: number; rev: number; at: string; log_note: string | null }>;

  const legalProblems = [...loaded.problems];
  if (denylist !== null && (denylist.persons.length === 0 && denylist.characters.length === 0)) {
    // Not an error — the list is curated by a human and reviewed at M9 (§13.4) — but an
    // empty legal gate is a fact the operator must see, not a green check.
    legalProblems.push('denylist holds no persons and no characters: the legal gate cannot catch a real name');
  }

  return {
    at,
    chapters: {
      written: written.n,
      total: result.totalChapters,
      totalChars: totalChars.n,
      thin,
    },
    legal: {
      denylistVersion: denylist?.version ?? null,
      persons: denylist?.persons.length ?? 0,
      characters: denylist?.characters.length ?? 0,
      organisations: denylist?.organisations.length ?? 0,
      patterns: denylist?.patterns.length ?? 0,
      problems: legalProblems,
    },
    validator: {
      errors: result.errors,
      warnings: result.warnings,
      passed: result.errors === 0,
      findings: result.findings.slice(0, FINDING_LIMIT),
      truncated: Math.max(0, result.findings.length - FINDING_LIMIT),
    },
    attribution: { unattributed: unattributed.n, recent: recentUnattributed },
    ungated: listUngated(db),
    restores: {
      total: restores.n,
      recent: recentRestores.map((row) => ({
        chapter: row.chapter,
        rev: row.rev,
        at: row.at,
        restoredRev: restoredRevOf(row.log_note),
      })),
    },
    reconciles: listReconciles(db),
  };
}
