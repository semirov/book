import type { ChangeSummaryDto, CommentDto } from '@book/shared';

import type { AnchorRect } from '../lib/popover.ts';
import { SeamPanel } from './SeamPanel.tsx';

/**
 * BOOK-DOC-34 §2.7 — one filing, opened from its mark or from its row in the strip.
 *
 * BOOK-111 (owner, 2026-10-27) — the card is a context of the page's one panel, not a second
 * popover: the `<aside>` is `SeamPanel`'s, and this file is the surface's name and its class,
 * nothing else. No placement, focus or `Escape` here, so the page can never hold two.
 *
 * BOOK-137 — the card is where a filing keeps what its one entry does not print: the earlier
 * attempts (`earlierAttempts`, without numbers or links — the entry above the card owns the
 * one number and the one change door) and, for a premise, the change's own intent as the derived
 * reading of what was accepted into the basis.
 *
 * `filing-panel ym-hide-content` is the masked root the Webvisor guard (BOOK-77) reads here,
 * and the very string the shell is told to wear: one literal, no copy to drift.
 */
export const FILING_PANEL_CLASS = 'filing-panel ym-hide-content';

export function FilingPanel({
  comment,
  anchor,
  onClose,
  earlierAttempts = [],
  premiseIntent = null,
  placeNote = null,
  nowMs,
  onRevise,
}: {
  comment: CommentDto;
  anchor: AnchorRect | null;
  onClose: () => void;
  /** BOOK-137: earlier attempts, oldest first — inside the entry, never rows of their own. */
  earlierAttempts?: readonly ChangeSummaryDto[];
  /** BOOK-137: the premise's derived reading, from its change's intent. */
  premiseIntent?: string | null;
  /**
   * BOOK-168: the one line a card owes when its landing fell back to the chapter — the
   * filing's paragraph is gone (`lib/place.ts`, `PLACE_NOTE`), never a guessed neighbour.
   */
  placeNote?: string | null;
  /** BOOK-158: the page's revise clock, so the card's cooldown line counts down. */
  nowMs?: number;
  /** BOOK-158: the card's way back from a refusal, owned by the surface that opened it. */
  onRevise?: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  return (
    <SeamPanel
      rootClass={FILING_PANEL_CLASS}
      comment={comment}
      anchor={anchor}
      onClose={onClose}
      earlierAttempts={earlierAttempts}
      premiseIntent={premiseIntent}
      placeNote={placeNote}
      nowMs={nowMs}
      {...(onRevise === undefined ? {} : { onRevise })}
    />
  );
}
