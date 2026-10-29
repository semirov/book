import type { Envelope, ServerEventType } from '@book/shared';

import { commentFrameChapter } from './commentFrames.ts';
import { landingOf } from './filings.ts';
import type { ReaderRecordEvent } from './ownDecisions.ts';

/**
 * One `comment:decision` frame, applied in one place (BOOK-174, BOOK-219).
 *
 * A decision frame is a broadcast: the viewer's own record reloads only when the frame names one
 * of their filings (`noteRecord` decides that from the durable own-only set), the row on screen
 * takes the reading it carries (`noteDecision`), and the chapter it names re-reads its filings.
 *
 * BOOK-219 — a **landing** frame (`status: 'applied'` with the receipt) also rewrote a chapter's
 * text, so the page reads the text again on the path every text frame takes: the catalog is
 * re-read — a chapter's `rev` is what makes its slot fetch the prose — and the edition line
 * follows the text. Without it the record moved and the prose did not, until a reload.
 */
export type DecisionFrameDeps = {
  noteRecord: (event: ReaderRecordEvent) => void;
  noteDecision: (data: unknown) => void;
  refreshComments: (chapter?: number) => void;
  /** The catalog read (the same one a `state:updated` resync uses). */
  refreshCatalog: () => void;
  /** The edition line, on the same debounce as `chapter:revision`/`front:updated`. */
  noteRevision: () => void;
};

export function decisionFrameHandler(
  deps: DecisionFrameDeps,
): (frame: Envelope<ServerEventType, unknown>) => void {
  return (frame) => {
    deps.noteRecord({ kind: 'frame', type: frame.type, data: frame.data });
    deps.noteDecision(frame.data);
    deps.refreshComments(commentFrameChapter(frame.data) ?? undefined);
    // Only a landing names a chapter whose text the frame itself moved. A triage accept or a
    // refusal names none: it moves the record and leaves the prose where it stands.
    if (landingOf(frame.data) !== null) {
      deps.refreshCatalog();
      deps.noteRevision();
    }
  };
}
