/**
 * The integrity panel's one query (ARCHITECTURE.md §13.4 point 5, §17).
 *
 * The site never blocks publication: it runs the cheap rule subset over the text it serves
 * (F001, F002, F005–F007, F009, F020–F022, F029), reads the legal denylist, and reports what it
 * found. The panel is an operator tool, and every field here answers a question an operator
 * would otherwise ask the database by hand:
 *
 * - is the text legal and well-formed right now (`validator`, `legal`)?
 * - does the denylist have teeth (`legal`)?
 * - is anything on the page uncredited (`attribution`, F015)?
 * - is any chapter sitting on a restore that never ran the gates (`ungated`, §13.3)?
 *
 * BOOK-187: the text is read from **rows** (`chapters`, `blocks`, `front_matter`) with
 * `scanRows`, never from a manuscript directory. The rules and their messages are the same
 * ones the commit gate uses — the validator is a pure function of `(files, denylist, imprint)`,
 * and the projection is what builds `files`. A slot with no row is an empty slot, not a broken
 * file: a missing directory stopped being a finding when the directory stopped being a source.
 *
 * Nothing here is cached: an integrity answer that lags the text would be a worse answer
 * than a slow one, and the route is called by an operator, not by a reader.
 */

import { FRONT_FILE, type Imprint, type LegalDenylist, type ValidatorFinding } from '@book/shared';
import { CHAPTER_CHARS, TOTAL_CHAPTERS, chapterLabel, runValidation, type ValidateResult } from '@book/shared';

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { loadDenylist } from './config.ts';
import { readChapterRows, readFrontRows } from '../engine/text.ts';
import {
  listReconciles,
  listUngated,
  restoredRevOf,
  type ReconcileRow,
  type UngatedChapter,
} from './ungated.ts';

/** `F007` says a chapter under the band is thin; the panel reads the band, never its own copy. */
const THIN_LIMIT = CHAPTER_CHARS.min;
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
  denylistPath: string;
  imprint: Imprint;
  /** Injected in tests; the route uses the clock. */
  nowMs?: number;
  /** Injected in tests; the route reads the file once per call. */
  denylist?: LegalDenylist | null;
};

type CountRow = { n: number };

/**
 * The book's text as the validator's `files` input, read from rows (BOOK-187).
 *
 * The projection is the same one the applier writes: `chNN.md` with the title line, a blank
 * line and the paragraphs joined by a blank line; `00-front.md` with the published title and
 * annotation. Names are the manuscript's own, so every rule's message, line number and lexeme
 * are exactly what they were when the same text sat on disk.
 *
 * A slot without a row is simply absent from the list — an empty slot, not a missing file.
 */
export function scanRows(db: Db): Array<{ name: string; text: string }> {
  const files: Array<{ name: string; text: string }> = [];
  for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
    const chapter = readChapterRows(db, n);
    if (!chapter.exists) continue;
    files.push({ name: `ch${chapterLabel(n)}.md`, text: chapter.raw });
  }
  const front = readFrontRows(db);
  if (front.exists) files.push({ name: FRONT_FILE, text: front.raw });
  return files;
}

function validate(db: Db, options: IntegrityOptions, denylist: LegalDenylist | null): ValidateResult {
  return runValidation({ files: scanRows(db), denylist, imprint: options.imprint });
}

export function readIntegrity(db: Db, options: IntegrityOptions): IntegrityReport {
  const nowMs = options.nowMs ?? Date.now();
  const at = toIso(nowMs);
  const loaded =
    options.denylist === undefined ? loadDenylist(options.denylistPath) : { denylist: options.denylist, problems: [] };
  const denylist = loaded.denylist;
  const result = validate(db, options, denylist);

  // A slot is written when it has prose: a basis-only or zero-block row is an empty slot (BOOK-6).
  // BOOK-155 — the aggregate is about the book, so a row left from the 67-chapter book (chapter 65,
  // which the `chapters` CHECK keeps as storage) is not counted: it would report a chapter and
  // characters the reader can never see.
  const written = db
    .prepare('SELECT COUNT(*) AS n FROM chapters WHERE n BETWEEN 1 AND ? AND block_count > 0 AND basis = 0')
    .get(TOTAL_CHAPTERS) as CountRow;
  const totalChars = db
    .prepare('SELECT COALESCE(SUM(chars), 0) AS n FROM chapters WHERE n BETWEEN 1 AND ?')
    .get(TOTAL_CHAPTERS) as CountRow;
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
