import type { BookCostDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { compareModels, costKey } from '../../cost/book.ts';
import { getFrontRow } from '../../db/repo/front.ts';
import { sha256Hex } from '../../util/hash.ts';
import type { RouteDeps } from '../deps.ts';

/**
 * The unpriced names as a short digest. The body names the models that blanked the price, so two
 * books that differ only in **which** model is unpriced are two representations; the tag folds
 * the sorted list into eight hex characters rather than spelling names of unknown length, and an
 * empty list hashes to a constant of its own.
 */
function unpricedDigest(cost: BookCostDto): string {
  return sha256Hex(JSON.stringify([...cost.unpriced].sort(compareModels))).slice(0, 8);
}

/**
 * The totals are the validator: the line prints them and nothing else, so a log (or a client
 * comparing two answers) can tell one outlay from another. Cents, not the float, or two
 * roundings of one total would fight over the same ETag.
 */
function costEtag(cost: BookCostDto): string {
  const usd = cost.usd === null ? 'u' : cost.usd.toFixed(2);
  return `"cost-${cost.tokensIn}-${cost.tokensOut}-${usd}-${unpricedDigest(cost)}-${cost.steps}"`;
}

/**
 * `GET /api/cost` — the book's outlay, the last line of the colophon (BOOK-114).
 *
 * The aggregate is a whole-book read of `steps`, so the answer is measured **once per book
 * state** and remembered under `costKey`; a repeated page view pays for the transfer and no scan
 * of the step table. Every answer is a `200` with the full body — BOOK-109 removed the `304`
 * from every `/api/` surface, and here it would be worse than elsewhere: a client holding the
 * previous total would print a number the book has already spent past. The ETag stays and still
 * carries the totals: it is the validator a proxy log or a test compares, not a licence to reuse.
 * The reader is injected (`deps.bookCost`) so a test can count the scans a page costs.
 */
export function registerCostRoutes(app: FastifyInstance, deps: RouteDeps): void {
  let memo: { key: string; cost: BookCostDto } | null = null;

  app.get('/api/cost', async (_request, reply) => {
    const rev = getFrontRow(deps.db)?.rev ?? 0;
    const key = costKey(deps.db, rev);

    // A representation is being built: measure once per book state, and keep it.
    const remembered = memo !== null && memo.key === key ? memo.cost : null;
    const cost = remembered ?? deps.bookCost();
    if (remembered === null) memo = { key, cost };
    reply.header('etag', costEtag(cost));

    return reply.send(cost);
  });
}
