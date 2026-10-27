import type { CommentDto } from '@book/shared';

import type { AnchorRect } from '../lib/popover.ts';
import { SeamPanel } from './SeamPanel.tsx';

/**
 * BOOK-DOC-34 §2.7 — one filing, opened from its mark or from its row in the strip.
 *
 * BOOK-111 (owner, 2026-10-27) — the card is a context of the page's one panel, not a second
 * popover: the `<aside>` is `SeamPanel`'s, and this file is the surface's name and its class,
 * nothing else. No placement, focus or `Escape` here, so the page can never hold two.
 *
 * `filing-panel ym-hide-content` is the masked root the Webvisor guard (BOOK-77) reads here,
 * and the very string the shell is told to wear: one literal, no copy to drift.
 */
export const FILING_PANEL_CLASS = 'filing-panel ym-hide-content';

export function FilingPanel({
  comment,
  anchor,
  onClose,
  onProvenance,
}: {
  comment: CommentDto;
  anchor: AnchorRect | null;
  onClose: () => void;
  /** The provenance of the filing's sentence, in the same box (§2.7, amended). */
  onProvenance?: () => void;
}) {
  return (
    <SeamPanel
      context="filing"
      rootClass={FILING_PANEL_CLASS}
      comment={comment}
      anchor={anchor}
      onClose={onClose}
      onProvenance={onProvenance}
    />
  );
}
