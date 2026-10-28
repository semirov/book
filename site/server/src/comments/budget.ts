/**
 * The budget line the composer shows (§14) — split out of `comments/service.ts` so the
 * posting path stays within the arch line limit (BOOK-113).
 *
 * The edit budget is two counters (BOOK-DOC-4 rule 5), so the reader is shown the tighter
 * one: the network may already be spent while their own day is not (`min`), and the reset is
 * the later of the two.
 *
 * BOOK-113: an exempt identity (the owner testing a change) is shown no daily counter at all —
 * `editsExempt` says so and the full budget is reported, because a refused-looking «0 из 1»
 * line would describe a limit that does not apply to them. The hourly comment line is the same
 * for everyone: the exemption is about edits only.
 */

import type { CommentBudget } from '@book/shared';

import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { readIdentity } from '../db/repo/identities.ts';
import type { IpHasher } from '../rate/policy.ts';
import { commentIdentityKey, editIdentityKey, editIpKey } from '../rate/policy.ts';
import type { RateLimiter } from '../rate/limiter.ts';
import { laterReset } from './dailyLimit.ts';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type BudgetDeps = {
  db: Db;
  config: Config;
  limiter: RateLimiter;
  ipHash: IpHasher;
};

export function readBudget(deps: BudgetDeps, identityId: string, ipKey: string): CommentBudget {
  const comments = deps.limiter.check({
    key: commentIdentityKey(identityId),
    limit: deps.config.commentsPerHourIdentity,
    windowMs: HOUR_MS,
  });
  const base = {
    perHour: comments.limit,
    remaining: comments.remaining,
    resetAt: comments.resetAtMs === null ? null : new Date(comments.resetAtMs).toISOString(),
  } as const;
  if (isEditExempt(deps.db, identityId)) {
    return {
      ...base,
      editsPerDay: deps.config.editSubmissionsPerDay,
      editsRemaining: deps.config.editSubmissionsPerDay,
      editsResetAt: null,
      editsExempt: true,
    };
  }
  const edits = deps.limiter.check({
    key: editIdentityKey(identityId),
    limit: deps.config.editSubmissionsPerDay,
    windowMs: DAY_MS,
  });
  const editsByNetwork = deps.limiter.check({
    key: editIpKey(deps.ipHash, ipKey),
    limit: deps.config.editSubmissionsPerDay,
    windowMs: DAY_MS,
  });
  const editResetAtMs = laterReset(edits.resetAtMs, editsByNetwork.resetAtMs);
  return {
    ...base,
    editsPerDay: edits.limit,
    editsRemaining: Math.min(edits.remaining, editsByNetwork.remaining),
    editsResetAt: editResetAtMs === null ? null : new Date(editResetAtMs).toISOString(),
  };
}

/**
 * BOOK-113: the flag is read from the store, not from the caller's snapshot, so an idempotent
 * replay — which has only the row's `identity_id` — reports the same budget as a fresh post.
 * BOOK-158: the triage CLI spends the day's edit on an accepted filing and must skip an exempt
 * identity, so the one predicate is exported rather than copied.
 */
export function isEditExempt(db: Db, identityId: string): boolean {
  const identity = readIdentity(db, identityId);
  // Fail closed: only an explicit `1` is an exemption. `!== 0` read a missing or unknown
  // value as the owner's exemption — the one direction a flag like this must never take.
  return identity !== undefined && identity.edit_exempt === 1;
}
