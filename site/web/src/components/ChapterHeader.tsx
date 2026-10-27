import { chapterLabel, type CatalogEntry } from '@book/shared';

import { formatChars, formatTime } from '../lib/format.ts';

/**
 * BOOK-DOC-43 §6 — the chapter's header (BOOK-66).
 *
 * The slot's meta line is where the skeleton's one sentence is printed, because it is a slot
 * the surface already has: the status adds no height, so nothing below it moves when the text
 * arrives. While the wait is quiet the meta line prints what it printed before — the catalog's
 * character count and time, or «не написана» for a slot with nothing to read.
 *
 * Extracted from `ChapterArticle` to keep that file under the arch limit; the markup is the
 * same, and the ■ of «■ читаем главу 07» stays chrome: `role="status"` carries exactly the
 * sentence, never the mark.
 */
export type ChapterHeaderProps = {
  entry: CatalogEntry;
  /** The opening is printing at 18 cps: the header says so, as it always has. */
  printing: boolean;
  /** `null` while the wait is quiet; otherwise the surface's §6 sentence. */
  status: string | null;
  /** A basis slot has its frozen frame and no «не написана» label. */
  basisSentence: string | null;
};

export function ChapterHeader({ entry, printing, status, basisSentence }: ChapterHeaderProps) {
  return (
    <header className="ch-h">
      <span className="ch-id">
        <h2 className="ch-n" aria-hidden="true">
          {chapterLabel(entry.n)}
        </h2>
      </span>
      <span className="ch-meta">
        {status === null ? (
          <>
            {printing ? '■ печатается · ' : ''}
            {entry.written
              ? `${formatChars(entry.chars)} · ${formatTime(entry.updatedAt)}`
              : basisSentence === null
                ? 'не написана'
                : null}
          </>
        ) : (
          <>
            <span aria-hidden="true">■</span>{' '}
            <span role="status" aria-live="polite" aria-atomic="true">
              {status}
            </span>
          </>
        )}
      </span>
    </header>
  );
}
