/**
 * Clearing one identity's budgets (BOOK-113): the operator's "see the effect at once" action.
 *
 * It deletes rows from `rate_events`, never by hand and never by enumerating addresses: the
 * network keys are found through the identity's own comments (`comments.ip_hash` is the salted
 * digest that `edit:ip:` is built from, `policy.ts`). One transaction, so a reader's two
 * counters cannot be half-cleared; the caller reports counts only — a key or a hash in the
 * response would hand out the network identity the §14 store deliberately hides.
 *
 * `cmt:id:` is cleared with the edit keys: an operator resetting their own budget is testing
 * the product, and the comment line is part of what the composer shows.
 */

import type { Db } from '../db/db.ts';
import { commentIdentityKey, editIdentityKey, editIpKeyFromHash } from './policy.ts';

export type BudgetResetCounts = {
  editId: number;
  editIp: number;
  commentId: number;
};

export function resetIdentityBudget(db: Db, identityId: string): BudgetResetCounts {
  const run = db.transaction((): BudgetResetCounts => {
    const hashes = db
      .prepare('SELECT DISTINCT ip_hash FROM comments WHERE identity_id = ? AND ip_hash IS NOT NULL')
      .all(identityId) as Array<{ ip_hash: string }>;
    const drop = db.prepare('DELETE FROM rate_events WHERE key = ?');
    const editId = drop.run(editIdentityKey(identityId)).changes;
    const commentId = drop.run(commentIdentityKey(identityId)).changes;
    let editIp = 0;
    for (const row of hashes) editIp += drop.run(editIpKeyFromHash(row.ip_hash)).changes;
    return { editId, editIp, commentId };
  });
  return run();
}
