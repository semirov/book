import { chapterLabel, type CatalogEntry } from '@book/shared';

import { formatChars, formatTime } from '../lib/format.ts';

/**
 * The chapter's header: BOOK-DOC-43 §6 (BOOK-66) and the chip rules of BOOK-70.
 *
 * The slot's meta line is where the skeleton's one sentence is printed, because it is a slot
 * the surface already has: the status adds no height, so nothing below it moves when the text
 * arrives. While the wait is quiet the meta line prints only what is provable: the printing
 * chip `.ch-print` («■ печатается») when the opening is still being typed, and the catalog's
 * character count and time as data in `.ch-data`. A slot with nothing to read prints nothing —
 * «не написана» is gone (BOOK-70, editor's table): an absent line is not a fact about a
 * request, and the basis slot explains its own silence through `basisSentence` instead.
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
  /**
   * A basis slot has its frozen frame and no absence label to print (BOOK-70). The reason is
   * the caller's, so it lives here as documentation: the meta line renders nothing for it.
   */
  basisSentence: string | null;
};

export function ChapterHeader({ entry, printing, status }: ChapterHeaderProps) {
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
            {printing ? (
              <span className="ch-print">
                <span aria-hidden="true">■ </span>печатается
              </span>
            ) : null}
            {printing && entry.written ? ' · ' : ''}
            {entry.written ? (
              <span className="ch-data">{`${formatChars(entry.chars)} · ${formatTime(entry.updatedAt)}`}</span>
            ) : null}
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
