import type { CommentDto } from '@book/shared';
import { useCallback, type RefObject } from 'react';

import { getComment } from '../api.ts';
import type { ComposerError } from '../lib/composer.ts';
import { hideFiling, showFiling, useOpenFiling } from '../lib/useFiling.ts';
import { hideRevision, showRevision, useOpenRevision } from '../lib/useRevision.ts';

/**
 * BOOK-111 / BOOK-128 #3852 — the page's panels, wired for one paragraph.
 *
 * A filing card, the revision object and the word's record are page slots, not this paragraph's
 * state: the stores say which one is open and only its owner draws it. This hook is the
 * paragraph's whole side of that contract — the four doors that open a panel and the two ways
 * back to the surface that asked — and it exists so `ProseParagraph` holds its prose, not its
 * bookkeeping.
 */
export function useParagraphPanels({
  blockId,
  hostRef,
}: {
  blockId: string;
  /** The paragraph, so a close can hand focus somewhere real when its own door has left. */
  hostRef: RefObject<HTMLElement | null>;
}) {
  const filing = useOpenFiling();
  const panel = filing !== null && filing.owner === blockId ? filing : null;
  const revision = useOpenRevision();

  const openRevision = useCallback((comment: CommentDto, origin: HTMLElement): void => {
    // BOOK-111: one panel at a time — the store closes the filing card (see `useRevision`).
    showRevision({ comment, origin });
  }, []);

  const closeRevision = useCallback((): void => {
    const origin = revision?.origin ?? null;
    hideRevision();
    // The trigger comes back when the object leaves; a note that was replaced has left the
    // page, and the paragraph is the next honest target (BOOK-90 §3.3).
    if (origin !== null && origin.isConnected) origin.focus();
    else hostRef.current?.focus();
  }, [hostRef, revision]);

  /** BOOK-111: one way into a filing card — the page's store, owned by this paragraph. */
  const openFiling = useCallback(
    (comment: CommentDto, origin: HTMLElement): void => {
      showFiling({
        kind: 'filing',
        owner: blockId,
        comment,
        origin,
        rect: origin.getBoundingClientRect(),
        fromSeam: origin.closest('.seam') !== null,
      });
    },
    [blockId],
  );

  /**
   * §7: the trigger comes back when the panel leaves, never nowhere. A door that lived inside
   * the body the card replaced is detached, so focus falls to the paragraph's own door.
   */
  const closePanel = useCallback((): void => {
    const origin = panel?.origin ?? null;
    hideFiling();
    if (origin !== null && origin.isConnected) origin.focus();
    else hostRef.current?.querySelector<HTMLElement>('.seam-prov')?.focus();
  }, [hostRef, panel]);

  /**
   * BOOK-111: a refusal that names the existing filing opens it. The row is the durable one —
   * the page holds a stale copy or none at all — so it is read by id, and the tap that opened
   * the panel returns to the button that asked (the form's own action).
   */
  const openDuplicate = useCallback(
    async (id: string, origin: HTMLElement): Promise<void> => {
      try {
        const comment = await getComment(id);
        if (comment !== null) openFiling(comment, origin);
      } catch {
        /* the refusal line stays: the reader still knows it was sent, even if the read failed */
      }
    },
    [openFiling],
  );

  return { panel, revision, openRevision, closeRevision, openFiling, closePanel, openDuplicate };
}

/** The refusal a rebuilt form must print again; kept beside the panels that unmount it. */
export type ParagraphRefusal = ComposerError | null;
