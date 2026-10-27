import type { ParagraphChainDto } from '@book/shared';
import { useCallback, useRef, useState } from 'react';

import { getHistoryParagraph } from './api.ts';
import type { AnchorRect } from './lib/popover.ts';

/**
 * «⋯ откуда эта фраза» (§11.10): the one request, its anchor and its close.
 *
 * The anchor is captured at the click in viewport coordinates, so the panel's placement
 * survives a re-render and does not depend on the button staying mounted. A late answer is
 * dropped when the panel has been closed or reopened meanwhile — a stale resolution must
 * neither reopen a closed chain nor replace a newer one.
 */
export type ParagraphChainMode = {
  chain: ParagraphChainDto | null;
  loading: boolean;
  anchor: AnchorRect | null;
  open: (blockId: string, anchor: AnchorRect) => void;
  close: () => void;
};

export function useParagraphChain(): ParagraphChainMode {
  const [chain, setChain] = useState<ParagraphChainDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const generation = useRef(0);

  const open = useCallback((blockId: string, rect: AnchorRect) => {
    const token = (generation.current += 1);
    setAnchor(rect);
    setLoading(true);
    void getHistoryParagraph(blockId)
      .then((loaded) => {
        if (generation.current === token) setChain(loaded);
      })
      .catch(() => {
        if (generation.current === token) setChain(null);
      })
      .finally(() => {
        if (generation.current === token) setLoading(false);
      });
  }, []);

  const close = useCallback(() => {
    generation.current += 1;
    setChain(null);
    setAnchor(null);
    setLoading(false);
  }, []);

  return { chain, loading, anchor, open, close };
}
