import { chapterLabel, type CatalogEntry } from '@book/shared';

import { formatChars, formatTime } from '../lib/format.ts';

/**
 * The chapter's header: BOOK-DOC-43 §6 (BOOK-66) and the chip rules of BOOK-70.
 *
 * The header is two things on two lines: the numeral, then the apparatus line `.ch-meta` —
 * the catalog's character count and time as data in `.ch-data`, and the printing chip
 * `.ch-print` while the opening is still being typed. The wait sentence is not apparatus: it is
 * the surface's own sentence about this slot, so it takes its own block line `.ch-status`
 * (mono 12, BOOK-199 m5) instead of living in `.ch-meta`, and it drops the `■` glyph the chip
 * carried — a sentence is not a chip. A slot with nothing to read prints nothing: «не написана»
 * is gone (BOOK-70, editor's table), and the basis slot explains its own silence through
 * `basisSentence` instead.
 *
 * Extracted from `ChapterArticle` to keep that file under the arch limit; the ■ of
 * «■ читаем главу 07» was chrome and is retired with the status line: `role="status"` carries
 * exactly the sentence, and the sentence is the whole line.
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
  // The apparatus line exists only when it has a fact: a printing chip, the chapter's data, or
  // both. An empty `.ch-meta` is a line that says nothing.
  const apparatus = printing || entry.written;
  return (
    <header className="ch-h">
      <span className="ch-id">
        <h2 className="ch-n" aria-hidden="true">
          {chapterLabel(entry.n)}
        </h2>
      </span>
      {apparatus ? (
        <span className="ch-meta">
          {printing ? (
            <span className="ch-print">
              <span aria-hidden="true">■ </span>печатается
            </span>
          ) : null}
          {printing && entry.written ? ' · ' : ''}
          {entry.written ? (
            <span className="ch-data">{`${formatChars(entry.chars)} · ${formatTime(entry.updatedAt)}`}</span>
          ) : null}
        </span>
      ) : null}
      {status === null ? null : (
        <p className="ch-status" role="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
      )}
    </header>
  );
}
