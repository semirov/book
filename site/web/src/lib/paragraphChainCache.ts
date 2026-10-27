import type { ParagraphChainDto } from '@book/shared';

import { getHistoryParagraph } from '../api.ts';

/**
 * BOOK-68 — a paragraph the client already knows has no history is never asked about again.
 *
 * A chain answer is final for the session: the server answers 404 for a block it never
 * recorded, and a DTO with `versions: []` is the same fact in another shape. Both are kept,
 * so re-opening the panel for that block is a local read — reopening is not a new question.
 * A failure is **not** kept: a 5xx is not an answer, and the reader's «повторить» must reach
 * the server.
 */
const answers = new Map<string, ParagraphChainDto | null>();
const inflight = new Map<string, Promise<ParagraphChainDto | null>>();

export type KnownChain = { known: false } | { known: true; chain: ParagraphChainDto | null };

/** What the client already knows about a block, without a request. */
export function knownParagraphChain(blockId: string): KnownChain {
  if (!answers.has(blockId)) return { known: false };
  return { known: true, chain: answers.get(blockId) ?? null };
}

/** The block's chain: the memo when it holds an answer, one shared request otherwise. */
export function loadParagraphChain(blockId: string): Promise<ParagraphChainDto | null> {
  const memo = knownParagraphChain(blockId);
  if (memo.known) return Promise.resolve(memo.chain);
  const pending = inflight.get(blockId);
  if (pending !== undefined) return pending;
  const request = getHistoryParagraph(blockId)
    .then((chain) => {
      answers.set(blockId, chain);
      return chain;
    })
    .finally(() => {
      inflight.delete(blockId);
    });
  inflight.set(blockId, request);
  return request;
}

/** Tests only: the memo is per module lifetime, and a fresh case wants a fresh client. */
export function resetParagraphChainCache(): void {
  answers.clear();
  inflight.clear();
}
