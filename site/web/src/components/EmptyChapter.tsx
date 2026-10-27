import type { CatalogEntry, CommentDto, ComposerInfo, ViewerDto } from '@book/shared';
import { useState } from 'react';

import { existingPremise, premiseAction, premiseRow } from '../lib/premise.ts';
import { closeSeam, openSeam, useOpenSeam } from '../lib/useSeam.ts';
import { FilingPanel } from './FilingPanel.tsx';
import { PremiseRow } from './PremiseRow.tsx';
import { Seam } from './Seam.tsx';

/**
 * BOOK-90 A — an empty chapter's contents: the one row, and the premise strip when opened.
 *
 * **Children only.** The `<article>` is `ChapterArticle`'s and stays the same DOM node across
 * the empty → written swap, so the chapter's lazy-load observer keeps watching the live slot
 * (a `chapter:created` frame must still fetch the new chapter's filings).
 *
 * The one explanation sentence is the page's: the row no longer prints it — the row is a
 * chapter number and a field, and the reading surface prints the book, not the interface
 * (BOOK-112). The strip carries it only when it is the first empty chapter's own strip, and
 * only while it is open.
 */
export function EmptyChapter({
  entry,
  comments,
  composer,
  viewer,
  firstEmpty,
  onPosted,
}: {
  entry: CatalogEntry;
  comments: readonly CommentDto[];
  composer: ComposerInfo;
  viewer: ViewerDto;
  /** The first empty chapter in the flow: it owns the page's one explanation sentence. */
  firstEmpty: boolean;
  /** BOOK-111: the posted DTO reaches the page, which shows the row without a reload. */
  onPosted?: (comment: CommentDto) => void;
}) {
  const seam = useOpenSeam();
  const [premiseCard, setPremiseCard] = useState<{ comment: CommentDto; rect: DOMRect } | null>(null);
  const premise = existingPremise(comments, entry.n);
  const row = premiseRow(entry, premise);
  const open = seam !== null && seam.chapter === entry.n && seam.blockId === null;

  /**
   * BOOK-111: one way into a filing that already exists. The premise row, and the strip's
   * rows — including the one a duplicate refusal points at — open the same card, anchored on
   * the element that was tapped, so closing it returns the reader there.
   */
  const openFiling = (comment: CommentDto, origin: HTMLElement): void => {
    setPremiseCard({ comment, rect: origin.getBoundingClientRect() });
  };

  return (
    <>
      {row === null ? null : (
        <PremiseRow
          row={row}
          onOpen={(origin) => {
            // BOOK-33: a slot that already holds a premise opens THAT premise's card — a
            // second form would be refused by the server («у главы уже есть замысел»).
            if (premiseAction(premise).kind === 'card') {
              if (premise !== null) openFiling(premise, origin);
              return;
            }
            openSeam({
              chapter: entry.n,
              blockId: null,
              key: `ch${entry.n}:premise`,
              anchor: null,
              origin,
            });
          }}
        />
      )}
      {open ? (
        <Seam
          entry={entry}
          draftKey={`ch${entry.n}:premise`}
          anchor={null}
          frozen={false}
          filings={null}
          existingPremise={premise}
          composer={composer}
          viewer={viewer}
          onPosted={(comment) => onPosted?.(comment)}
          onClose={closeSeam}
          onProvenance={() => undefined}
          onOpenFiling={openFiling}
          premiseHint={firstEmpty && open}
        />
      ) : null}
      {premiseCard === null ? null : (
        <FilingPanel comment={premiseCard.comment} anchor={premiseCard.rect} onClose={() => setPremiseCard(null)} />
      )}
    </>
  );
}
