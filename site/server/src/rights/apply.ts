/**
 * Gate B at the filing boundary (BOOK-61, BOOK-DOC-42 §1, §3).
 *
 * One helper for the two places a filing is scanned — posting (`comments/service.ts`) and the
 * batch boundary (`feedback/batches.ts`) — so the two cannot drift: the same fields in the same
 * order (`body ‖ proposed ‖ quote`), the same vocabulary of the book, the same writer.
 *
 * The scan itself is pure (`scan.ts`). This module is where the answer becomes a row:
 * a clean scan records `CLEAR` with `rights_source='scan'`, a refusing rule records `REFUSED`
 * and the reader's fixed sentence, and a flag records no verdict at all — the row stays
 * undecided until `feedback.mjs rights`, and an undecided row is never accepted.
 *
 * The scan is exported separately from the write because posting asks it **before** the rate
 * slots (a refused filing spends no budget) and writes the answer after the insert: one scan,
 * one answer, and the budget and the row agree.
 */

import type { Db } from '../db/db.ts';
import { chapterVocabulary } from '../feedback/vocabulary.ts';
import { flagRights, recordRights } from './record.ts';
import { scanRights, type RightsInput, type RightsScan } from './scan.ts';

/** The scan, with the chapter's own words as the vocabulary of "a name the book has used". */
export function scanFiling(db: Db, chapter: number, input: RightsInput): RightsScan {
  return scanRights(input, { knownNames: chapterVocabulary(db, chapter) });
}

/**
 * Scan one filing and write the answer on its row — the one call both boundaries make. The
 * row must exist: the verdict is a column, not a field of the request. It returns the scan's
 * verdict so the batch boundary can leave a refused row out of the file. `scan` may be handed
 * in when the caller has already asked (posting does, before spending a slot).
 */
export function applyRights(
  db: Db,
  commentId: string,
  chapter: number,
  input: RightsInput,
  at: string,
  scan?: RightsScan,
): RightsScan['verdict'] {
  const answer = scan ?? scanFiling(db, chapter, input);
  if (answer.verdict === 'clear') {
    recordRights(db, { commentId, verdict: 'CLEAR', rule: null, source: 'scan', by: null, at });
    return 'clear';
  }
  if (answer.verdict === 'refused') {
    recordRights(db, { commentId, verdict: 'REFUSED', rule: answer.rule, source: 'scan', by: null, at });
    return 'refused';
  }
  flagRights(db, { commentId, detail: answer.detail, at });
  return 'flag';
}
