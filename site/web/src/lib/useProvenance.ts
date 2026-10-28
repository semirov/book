import { useState } from 'react';

import { getAuthors, getMyTrace } from '../api.ts';
import type { ChainHistory } from './history.ts';
import { knownParagraphChain, loadParagraphChain } from './paragraphChainCache.ts';
import {
  shareFor,
  variantOf,
  wordFacts,
  type TraceShare,
  type WordFacts,
  type WordFiling,
} from './provenance.ts';

/**
 * BOOK-128 comment #3815 — everything one word's margin reads from the log.
 *
 * The strip's door is the only door: the facts are read when the reader asks, never by a
 * render. `view` is `null` while the log has not answered — the block does not exist yet, and
 * nothing is guessed in the meantime. `failed` prints one line instead of three facts.
 *
 * Both layers read the same chain (`paragraphChainCache`), so the word and the phrase beside it
 * are answers to one question, not two.
 */
export type ProvenanceState = {
  /** What the margin may print now; `null` until the log answers. */
  view: WordFacts | null;
  /** The read failed: one line, no facts, no invented trace. */
  failed: boolean;
  /** Read every fact the block can show. Idempotent per open: the memo answers a second call. */
  load: () => Promise<void>;
};

export function useProvenance(input: {
  blockId: string;
  /** The word the open block speaks of; `null` when the strip's body is closed. */
  word: string | null;
  /** The paragraph's frozen surface: `frame` (canon sentence) or `basis` (page 2). */
  frozenOf: 'frame' | 'basis' | null;
  /** BOOK-56: `state.history.live`; off means no chain, no facts and no fetch at all. */
  history: boolean;
  signedIn: boolean;
  viewerName: string | null;
  /** The filing standing on this word, when the strip's sentence holds one. */
  filing: WordFiling | null;
}): ProvenanceState {
  const { blockId, word, frozenOf, history, signedIn, viewerName, filing } = input;
  // BOOK-68: no chain yet is «still reading», never «no history» — and a 404 is an answer.
  const [chainHistory, setChainHistory] = useState<{
    state: ChainHistory;
    chain: Awaited<ReturnType<typeof loadParagraphChain>>;
  }>({ state: 'loading', chain: null });
  const [own, setOwn] = useState<{ share: number; survivedRevisions: number } | null>(null);
  const [publicShares, setPublicShares] = useState<Array<{ label: string; share: number; edits: number }>>([]);

  const load = async (): Promise<void> => {
    // BOOK-56: the chain and both share rows are history; with history off the door is not
    // rendered at all, so nothing is fetched for facts nobody will print.
    if (!history) return;
    // BOOK-68: a chain the client already holds (a 404, or a DTO with no versions) is not
    // asked for again; a failure is not an answer, so the read failed and says so.
    const memo = knownParagraphChain(blockId);
    if (memo.known) {
      setChainHistory({ state: memo.chain === null ? 'none' : 'ready', chain: memo.chain });
    } else {
      setChainHistory({ state: 'loading', chain: null });
      try {
        const loaded = await loadParagraphChain(blockId);
        setChainHistory({ state: loaded === null ? 'none' : 'ready', chain: loaded });
      } catch {
        setChainHistory({ state: 'failed', chain: null });
      }
    }
    // BOOK-33: the viewer's own curve is the one the block may print for their own word, and
    // the authors list carries the public numbers for somebody else's. Own-only, always.
    if (signedIn && own === null) {
      try {
        const trace = await getMyTrace();
        setOwn({ share: trace.share, survivedRevisions: trace.survivedRevisions });
      } catch {
        /* a signed-out session that expired: the line falls back to the public shape */
      }
    }
    if (publicShares.length === 0) {
      try {
        const authors = await getAuthors();
        setPublicShares(
          authors.contributors.map((row) => ({ label: row.label, share: row.share, edits: row.edits })),
        );
      } catch {
        /* no public list: a foreign word says «след не измерен», never a borrowed number */
      }
    }
  };

  if (word === null || !history) return { view: null, failed: false, load };

  // Who wrote this version, from the log's own vocabulary: a reader, the pass, or a version
  // the log cannot assign. A chain that has not arrived yet is not a claim — the block waits.
  const chain = chainHistory.chain;
  // A malformed or empty answer is not a chain: `versions` is read defensively because the
  // block prints whatever the log holds and never a crash instead of a line.
  const versions = Array.isArray(chain?.versions) ? chain.versions : [];
  const last = versions.at(-1) ?? null;
  const variant = variantOf({ frozen: frozenOf !== null, actorKind: last?.actor?.kind });
  const share: TraceShare = shareFor({
    actor: last?.actor == null ? null : { kind: last.actor.kind, label: last.actor.label },
    viewerName,
    own,
    publicShares,
  });

  if (chainHistory.state === 'failed') return { view: null, failed: true, load };
  // The answer is not in yet: no block, no guess, no `…`.
  if (chainHistory.state === 'loading') return { view: null, failed: false, load };

  return {
    view: wordFacts({
      variant,
      actor: last?.actor?.label ?? null,
      ...(frozenOf === null ? {} : { frozenOf }),
      at: last?.at ?? null,
      share,
      filing,
    }),
    failed: false,
    load,
  };
}
