import { ageDayIn } from '@book/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * BOOK-225 — the one refusal behind every surface that carries the book's prose.
 *
 * The gate is a property of the text, not of one route: `/api/chapters/:n` sends a chapter,
 * `/api/history/chapters/:n` sends a chapter as it was, and `/book.fb2` sends the whole book.
 * Each of them asks this function **first**, before any row, snapshot, tag or export build, so
 * no second public door can hand out what the first one refuses — and there is one message
 * string, not three that drift.
 *
 * What it does *not* cover is on purpose: the catalogue, the front, the state and the comments
 * carry no prose (the book must stay discoverable and discussable while gated), and the
 * history's `diff` and `paragraphs` answers are hashes and lineage, not sentences.
 *
 * `now` is the app's one clock seam (`deps.now()`), so a test pins the day and the bound is the
 * same one `shared/src/age.ts` reads.
 */
export const AGE_GATE_MESSAGE = 'книга 18+ — сначала подтвердите, что вам есть 18';

/** `403 AGE_GATE` when the reader has not answered the rating; `null` when they have. */
export function ageGateRefusal(
  request: FastifyRequest,
  reply: FastifyReply,
  now: () => Date,
): FastifyReply | null {
  if (ageDayIn(request.headers.cookie, now()) !== null) return null;
  // `no-store` belongs to the refusal, not to the route's policy: the answer is about *this*
  // request's cookie, and `/book.fb2` is outside the `/api/` rule — a proxy that stored this
  // `403` would refuse a reader who had already answered.
  return reply.code(403).header('cache-control', 'no-store').send({ code: 'AGE_GATE', message: AGE_GATE_MESSAGE });
}
