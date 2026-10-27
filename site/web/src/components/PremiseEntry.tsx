import type { CatalogEntry, ChangeSummaryDto, CommentDto, ComposerInfo, ViewerDto } from '@book/shared';

import { attemptsOf, earlierAttempts } from '../lib/filings.ts';
import { premiseAction, premiseFiling, premiseRow } from '../lib/premise.ts';
import { hideFiling, showFiling, useOpenFiling } from '../lib/useFiling.ts';
import { closeSeam, openSeam, useOpenSeam } from '../lib/useSeam.ts';
import { FilingPanel } from './FilingPanel.tsx';
import { PremiseRow } from './PremiseRow.tsx';
import { Seam } from './Seam.tsx';

/**
 * BOOK-90 A + BOOK-137 — the premise filing's one entry: the row, its strip, its card.
 *
 * **The chapter's row is the home of a premise filing.** The reader's thread never renders a
 * premise (`threadFilings`), so this is the only surface it appears on — while the chapter is
 * empty and after it is written. The row carries the filing's quote, one state word and one
 * number; the card carries the body, the derived premise reading and the earlier attempts.
 *
 * **Children only.** The `<article>` is `ChapterArticle`'s and stays the same DOM node across
 * the empty → written swap, so the chapter's lazy-load observer keeps watching the live slot
 * (a `chapter:created` frame must still fetch the new chapter's filings).
 *
 * The one explanation sentence is the page's: the row no longer prints it — the row is a
 * chapter number and a field, and the reading surface prints the book, not the interface
 * (BOOK-112). The strip carries it only when it is the first empty chapter's own strip, and
 * only while it is open. A written chapter has no strip: there is nothing left to file.
 */
export function PremiseEntry({
  entry,
  comments,
  changes = [],
  composer,
  viewer,
  firstEmpty,
  form = false,
  onPosted,
}: {
  entry: CatalogEntry;
  comments: readonly CommentDto[];
  /** The thread's changes: the attempts folded into this filing, never rows of their own. */
  changes?: readonly ChangeSummaryDto[];
  composer: ComposerInfo;
  viewer: ViewerDto;
  /** The first empty chapter in the flow: it owns the page's one explanation sentence. */
  firstEmpty: boolean;
  /** The chapter can still take a premise, so a tap on an empty row opens the form. */
  form?: boolean;
  /** BOOK-111: the posted DTO reaches the page, which shows the row without a reload. */
  onPosted?: (comment: CommentDto) => void;
}) {
  const seam = useOpenSeam();
  /** BOOK-111: the page's one panel; this chapter's premise owns only its own slot in it. */
  const filing = useOpenFiling();
  const owner = `ch${entry.n}:premise`;
  const panel =
    filing !== null && filing.kind === 'filing' && filing.owner === owner && filing.comment !== null
      ? { comment: filing.comment, rect: filing.rect }
      : null;
  const premise = premiseFiling(comments, entry.n);
  const row = premiseRow(entry, premise, changes);
  const open = seam !== null && seam.chapter === entry.n && seam.blockId === null;
  /** BOOK-137: the attempts before the latest one live inside the card, not beside it. */
  const earlier = premise === null ? [] : earlierAttempts(premise, changes);
  const intent = premise === null ? null : (attemptsOf(changes, premise.id).at(-1)?.intent ?? null);

  /**
   * BOOK-111: one way into a filing that already exists. The premise row, and the strip's
   * rows — including the one a duplicate refusal points at — open the same card, anchored on
   * the element that was tapped, so closing it returns the reader there. `fromSeam` is read
   * off the element, exactly as the paragraph does it: a row inside the strip turns into the
   * strip's one line, anything else closes the strip it would have stood beside.
   */
  const openFiling = (comment: CommentDto, origin: HTMLElement): void => {
    showFiling({
      kind: 'filing',
      owner,
      comment,
      origin,
      rect: origin.getBoundingClientRect(),
      fromSeam: origin.closest('.seam') !== null,
    });
  };

  return (
    <>
      {row === null ? null : (
        <PremiseRow
          row={row}
          onOpen={(origin) => {
            // BOOK-33: a slot that already holds a premise opens THAT premise's card — a
            // second form would be refused by the server («у главы уже есть замысел»). A
            // written chapter holds no form at all: its premise is history.
            if (premiseAction(premise).kind === 'card') {
              if (premise !== null) openFiling(premise, origin);
              return;
            }
            if (!form) return;
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
      {form && open ? (
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
          onClosePanel={hideFiling}
          onProvenance={() => undefined}
          onOpenFiling={openFiling}
          premiseHint={firstEmpty && open}
        />
      ) : null}
      {panel === null ? null : (
        <FilingPanel
          comment={panel.comment}
          anchor={panel.rect}
          earlierAttempts={earlier}
          premiseIntent={intent}
          onClose={hideFiling}
        />
      )}
    </>
  );
}
