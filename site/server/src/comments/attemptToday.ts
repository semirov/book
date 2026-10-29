/**
 * BOOK-DOC-84 #17 — the two counters a filing's own row prints, from the ledger alone: every
 * attempt this filing ever got, and the tries left in the current UTC day. One query, because
 * `filing:update` and `live.filings` must never disagree about the same row.
 *
 * It lives apart from `comments/attempts.ts` because that file is at its arch bound and the
 * counter reads nothing of the attempt ladder — only the ledger and the day's start.
 */

import { ATTEMPTS_PER_FILING_DAY, utcDayStart } from './attempts.ts';
import type { Db } from '../db/db.ts';

export function attemptCounts(
  db: Db,
  commentId: string,
  nowMs: number,
): { attempts: number; attemptsLeft: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS today
         FROM comment_attempts WHERE comment_id = ?`,
    )
    .get(new Date(utcDayStart(nowMs)).toISOString(), commentId) as { total: number; today: number | null };
  const today = row.today ?? 0;
  return { attempts: row.total, attemptsLeft: Math.max(0, ATTEMPTS_PER_FILING_DAY - today) };
}
