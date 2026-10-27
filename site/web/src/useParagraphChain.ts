import type { ParagraphChainDto } from '@book/shared';
import { useCallback, useRef, useState } from 'react';

import { knownParagraphChain, loadParagraphChain } from './lib/paragraphChainCache.ts';
import type { AnchorRect } from './lib/popover.ts';

/**
 * «⋯ откуда эта фраза» (§11.10): the one request, its anchor and its close.
 *
 * The anchor is captured at the click in viewport coordinates, so the panel's placement
 * survives a re-render and does not depend on the button staying mounted. A late answer is
 * dropped when the panel has been closed or reopened meanwhile — a stale resolution must
 * neither reopen a closed chain nor replace a newer one.
 *
 * BOOK-DOC-43 §6, §10, §4 (BOOK-66): a failed read is a failure, not an absence, and it may
 * be retried for the same paragraph. `active` is true from `open` until `close`, so the panel
 * stays mounted through the loading, the failure and the chain — dropping it on a failure
 * would take the retry away with it. The generation guard is bumped by `open`, `retry` and
 * `close`, so a retry is a fresh request (never dropped) and the previous attempt's late
 * answer can neither reopen nor replace it.
 *
 * BOOK-68: a 404 is an answer — `chain` stays `null` and `failed` stays false, and the panel
 * says «у этой строки нет истории». A block whose history the client already knows (a 404, or
 * a DTO with no versions) is not asked about twice: the memo lives in `paragraphChainCache.ts`
 * and is shared by the book and the chronicle, so a re-open there is a local read. A failure
 * is never memoised, so «повторить» always reaches the server.
 */
export type ParagraphChainMode = {
  chain: ParagraphChainDto | null;
  loading: boolean;
  /** The request failed: the panel prints its failure row instead of claiming an absence. */
  failed: boolean;
  /** The panel is open (loading, failed, or the chain itself): it stays mounted. */
  active: boolean;
  anchor: AnchorRect | null;
  open: (blockId: string, anchor: AnchorRect) => void;
  retry: () => void;
  close: () => void;
};

export function useParagraphChain(): ParagraphChainMode {
  const [chain, setChain] = useState<ParagraphChainDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const generation = useRef(0);
  const requested = useRef<string | null>(null);

  /** One attempt: a new generation token, so anything older is stale by definition. */
  const load = useCallback((blockId: string) => {
    const token = (generation.current += 1);
    setChain(null);
    setFailed(false);
    // BOOK-68: a block the client already knows has no history is not asked about again —
    // reopening it is not a new question. A failure never got here, so `повторить` asks.
    const memo = knownParagraphChain(blockId);
    if (memo.known) {
      setLoading(false);
      setChain(memo.chain);
      return;
    }
    setLoading(true);
    void loadParagraphChain(blockId)
      .then((loaded) => {
        if (generation.current === token) setChain(loaded);
      })
      .catch(() => {
        if (generation.current === token) {
          setChain(null);
          setFailed(true);
        }
      })
      .finally(() => {
        if (generation.current === token) setLoading(false);
      });
  }, []);

  const open = useCallback(
    (blockId: string, rect: AnchorRect) => {
      requested.current = blockId;
      setAnchor(rect);
      load(blockId);
    },
    [load],
  );

  /** The same paragraph again: a failure is retryable, and an empty answer is not a failure. */
  const retry = useCallback(() => {
    const blockId = requested.current;
    if (blockId !== null) load(blockId);
  }, [load]);

  const close = useCallback(() => {
    generation.current += 1;
    requested.current = null;
    setChain(null);
    setAnchor(null);
    setLoading(false);
    setFailed(false);
  }, []);

  return { chain, loading, failed, active: anchor !== null, anchor, open, retry, close };
}
