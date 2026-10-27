import type {
  BlockRevisingPayload,
  CatalogEntry,
  ChapterRevisionPayload,
  ComposerInfo,
  ViewerDto,
} from '@book/shared';
import type { ChapterFeed } from '../useReaderFeed.ts';

import type { SpineMarkers } from '../lib/spine.ts';
import { canTakePremise } from '../lib/premise.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-90 A.5 — the chapter list, and the one row that carries the page's one hint.
 *
 * The renderer that knows the order decides which empty slot is the **first**: its number is
 * passed down as `firstEmpty`, so the explanation sentence is printed once and moves to the
 * next empty chapter the day the first one is written. No global flag, no timer.
 */
export function ChapterList({
  catalog,
  revisions,
  revising,
  markers,
  fresh,
  chapterFeed,
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
  chapterFeed: Record<number, ChapterFeed>;
  onRead: (chapter: number) => void;
  onPosted: (chapter: number) => void;
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
            firstEmpty={firstEmpty === entry.n}
            onProvenance={onProvenance}
            comments={chapterFeed[entry.n]?.items ?? []}
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
