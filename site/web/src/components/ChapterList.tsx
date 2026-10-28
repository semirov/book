import type {
  BlockRevisingPayload,
  CatalogEntry,
  ChangeSummaryDto,
  ChapterRevisionPayload,
  CommentDto,
  ComposerInfo,
  ViewerDto,
} from '@book/shared';
import type { ChapterFeed } from '../useReaderFeed.ts';

import type { SpineMarkers } from '../lib/spine.ts';
import type { Stages } from '../lib/useStages.ts';
import { canTakePremise } from '../lib/premise.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-90 A.5 — the chapter list, and the one row that carries the page's one hint.
 *
 * The renderer that knows the order decides which empty slot is the **first**: its number is
 * passed down as `firstEmpty`, so the explanation sentence is printed once and moves to the
 * next empty chapter the day the first one is written. No global flag, no timer.
 *
 * BOOK-167 — the page's stage log (`useStages`) arrives as one prop: each slot reads the
 * passes in flight for its own chapter and the events the strip under it prints.
 */
export function ChapterList({
  catalog,
  revisions,
  revising,
  markers,
  fresh,
  stages,
  chapterFeed,
  changes,
  nowMs,
  onRead,
  onPosted,
  onProvenance,
  composer,
  viewer,
  history,
}: {
  catalog: readonly CatalogEntry[];
  revisions: Record<number, ChapterRevisionPayload>;
  revising: Record<number, BlockRevisingPayload>;
  markers: SpineMarkers;
  fresh: number | null;
  /** The page's one stage log: the passes in flight and the events behind each strip. */
  stages?: Stages;
  chapterFeed: Record<number, ChapterFeed>;
  /** BOOK-137: the thread's changes, folded into their filing's entry — never a row. */
  changes: readonly ChangeSummaryDto[];
  /** BOOK-158: the page's revise clock, so a cooldown line counts down (`useReviseTick`). */
  nowMs?: number;
  onRead: (chapter: number) => void;
  onPosted: (comment: CommentDto) => void;
  onProvenance: (blockId: string, anchor: HTMLElement) => void;
  composer: ComposerInfo;
  viewer: ViewerDto;
  /** BOOK-56: `state.history.live` — off drops the chain door and the DNA rows, not the text. */
  history: boolean;
}) {
  const firstEmpty = catalog.find((entry) => canTakePremise(entry))?.n ?? null;
  return (
    <main>
      {catalog.map((entry) => {
        const forwardCaret = markers.carets.forward === entry.n;
        const backwardCaret = markers.carets.backward === entry.n;
        const show = forwardCaret || backwardCaret;
        const live = (forwardCaret && markers.live.forward) || (backwardCaret && markers.live.backward);
        return (
          <ChapterArticle
            key={entry.n}
            entry={entry}
            revision={revisions[entry.n] ?? null}
            revising={revising[entry.n] ?? null}
            caret={show ? { show, live } : null}
            fresh={fresh === entry.n}
            passActive={stages?.passes[entry.n] !== undefined}
            stages={stages?.log[entry.n]}
            firstEmpty={firstEmpty === entry.n}
            onProvenance={onProvenance}
            comments={chapterFeed[entry.n]?.items ?? []}
            changes={changes}
            nowMs={nowMs}
            onRead={onRead}
            onPosted={onPosted}
            composer={composer}
            viewer={viewer}
            history={history}
          />
        );
      })}
    </main>
  );
}
