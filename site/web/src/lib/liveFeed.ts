import type {
  ChangeDecidedPayload,
  ChangeProcessingPayload,
  Envelope,
  PassStageEvent,
  ServerEventType,
} from '@book/shared';

/**
 * BOOK-206 audit B1 — the frames that move a **live record** without a decision of their own.
 *
 * The page's filings are refreshed by `comment:added`/`comment:decision` alone today, so a
 * reader whose filing was accepted and then written kept «в очереди на запись» over text that
 * already existed, until a reload. Three frames know better and each names the chapter it
 * touches:
 *
 *   - `change:processing` — the writer claimed the change; the filing that caused it is the one
 *     whose word must move from «ждёт» to «идёт» now, not on the next comment frame;
 *   - `change:decided` — the change closed; its own chapter (`chapters[0]`, the change's own,
 *     `chaptersOfChange`) holds the filing row that must stop promising a queue place;
 *   - `pass:stage` with `stage: 'landed'` — the writer published a revision the site's watcher
 *     never sees (the engine writes in its own process), so the page takes the pair a landing
 *     already takes: the chapter's filings, the catalog (a chapter's `rev` is what makes its
 *     slot fetch the prose again) and the edition line. No new fetch protocol: the same three
 *     calls `lib/decisionFrame.ts` makes for a landing.
 *
 * The stage log is written here too, so `App` has one call for the whole frame.
 */
export type LiveFeedDeps = {
  refreshComments: (chapter?: number) => void;
  /** The catalog read (the same one a `state:updated` resync uses). */
  refreshCatalog: () => void;
  /** The edition line, on the same debounce as `chapter:revision`/`front:updated`. */
  noteRevision: () => void;
  /** The page's stage log (`lib/useStages.ts`), fed every stage, not only a landing. */
  noteStage: (event: PassStageEvent) => void;
};

export function liveFeedHandler(
  deps: LiveFeedDeps,
): (frame: Envelope<ServerEventType, unknown>) => void {
  return (frame) => {
    switch (frame.type) {
      case 'pass:stage': {
        const event = frame.data as PassStageEvent;
        deps.noteStage(event);
        // Only `landed` moved prose; the other stages are the log's own story.
        if (event.stage !== 'landed') return;
        deps.refreshComments(event.chapter);
        deps.refreshCatalog();
        deps.noteRevision();
        return;
      }
      case 'change:processing': {
        deps.refreshComments((frame.data as ChangeProcessingPayload).chapter);
        return;
      }
      case 'change:decided': {
        // `chapters[0]` is the change's own chapter; a payload that names none refreshes the
        // thread alone, which is still the durable truth for the row.
        const [chapter] = (frame.data as ChangeDecidedPayload).chapters;
        deps.refreshComments(chapter);
        return;
      }
      default:
        return;
    }
  };
}
