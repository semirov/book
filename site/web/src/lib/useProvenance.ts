import { useState } from 'react';

import { getAuthors, getMyTrace } from '../api.ts';
import type { ChainHistory } from './history.ts';
import { knownParagraphChain, loadParagraphChain } from './paragraphChainCache.ts';
import { provenanceView, shareFor, type ProvenanceVariant, type ProvenanceView, type TraceShare } from './provenance.ts';

/**
 * BOOK-DOC-34 §2.6, BOOK-56, BOOK-68 — everything one word's DNA panel reads from the log.
 *
 * Extracted from the paragraph so the panel's two doors — the strip's «откуда это слово» and a
 * filing card's footer — ask the log through **one** function: the same chain, the same «свой
 * след» read, the same public list, and nothing at all with `history` off. The paragraph keeps
 * only its own prose; the answer is a value it renders.
 *
 * `load` is called by the opener, never by an effect: a panel that is merely rendered must not
 * fetch, and the caller decides when the reader actually asked.
 */
export type ProvenanceState = {
  /** What the panel may print now; `null` when no word's panel is open. */
  view: ProvenanceView | null;
  /** Read every row the panel can show. Idempotent per open: the memo answers the second call. */
  load: () => Promise<void>;
};

export function useProvenance(input: {
  blockId: string;
  chapter: number;
  /** The word the open panel speaks of; `null` when no provenance panel is open. */
  word: string | null;
  /** The chapter's frame: the frozen variant says so instead of a trace. */
  frozen: boolean;
  /** BOOK-56: `state.history.live`; off means no chain, no rows and no fetch at all. */
  history: boolean;
  signedIn: boolean;
  viewerName: string | null;
}): ProvenanceState {
  const { blockId, chapter, word, frozen, history, signedIn, viewerName } = input;
  // BOOK-68: no chain yet is «still reading», never «no history» — and a 404 is an answer.
  const [chainHistory, setChainHistory] = useState<{ state: ChainHistory; chain: Awaited<ReturnType<typeof loadParagraphChain>> }>({
    state: 'loading',
    chain: null,
  });
  const [own, setOwn] = useState<{ share: number; survivedRevisions: number } | null>(null);
  const [publicShares, setPublicShares] = useState<Array<{ label: string; share: number; edits: number }>>([]);

  const load = async (): Promise<void> => {
    // BOOK-56: the chain and both share rows are history; with history off the panel keeps
    // only the word, its place and «вмешаться», so nothing is fetched for rows not rendered.
    if (!history) return;
    // BOOK-68: a chain the client already holds (a 404, or a DTO with no versions) is not
    // asked for again; a failure is not an answer, so the row says the read failed.
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
    // BOOK-33: the viewer's own curve is the one the panel may print for their own word, and
    // the authors list carries the public numbers for somebody else's. Own-only, always.
    if (signedIn && own === null) {
      try {
        const trace = await getMyTrace();
        setOwn({ share: trace.share, survivedRevisions: trace.survivedRevisions });
      } catch {
        /* a signed-out session that expired: the row falls back to the public shape */
      }
    }
    if (publicShares.length === 0) {
      try {
        const authors = await getAuthors();
        setPublicShares(authors.contributors.map((row) => ({ label: row.label, share: row.share, edits: row.edits })));
      } catch {
        /* no public list: a foreign word says «след не измерен», never a borrowed number */
      }
    }
  };

  if (word === null) return { view: null, load };

  // Who wrote this version, from the log's own vocabulary: a reader, the author, or a version
  // the log cannot assign. A chain that has not arrived yet is not a claim — it is the machine
  // default, and the panel re-renders when the chain answers.
  const chain = chainHistory.chain;
  const actorKind = chain?.versions.at(-1)?.actor?.kind;
  const variant: ProvenanceVariant = frozen
    ? 'frozen'
    : actorKind === 'reader'
      ? 'reader'
      : actorKind === undefined || actorKind === 'author' || actorKind === 'writer'
        ? 'machine'
        : 'unattributed';
  const lastActor = chain?.versions.at(-1)?.actor ?? null;
  const share: TraceShare = shareFor({
    actor: lastActor === null ? null : { kind: lastActor.kind, label: lastActor.label },
    viewerName,
    own,
    publicShares,
  });

  return {
    view: provenanceView({
      word,
      chapter,
      variant,
      share,
      chain,
      history: chainHistory.state,
      at: chain?.versions.at(-1)?.at ?? null,
      frozenOf: 'frame',
      live: history,
    }),
    load,
  };
}
