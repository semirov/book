import { chapterLabel, type CatalogEntry, type StateSnapshot } from '@book/shared';

import { scrollToChapter } from '../dom.ts';
import { tocAriaLabel, tocParts, writtenCount } from '../lib/toc.ts';

/**
 * Живое оглавление (ARCHITECTURE §6C.7, §11.8; BOOK-DOC-5 §4): four numbered parts, 67
 * rows, and no invented titles. A row shows its chapter's title line, or the frozen frame
 * sentence of a basis slot (ch01/ch67); an empty row is its numeral and nothing else — no
 * link, no focus ring, no scroll on tap. No leader dots, no row rules, no part ranges, no
 * repeated book title: the column of numbers is the structural mark.
 *
 * The caret dot is a live fact, so it is drawn on an inert row too (a chapter the writer is
 * in before its first line lands) and that row is not hidden from assistive tech.
 */
export function TableOfContents({
  catalog,
  state,
  currentChapter,
}: {
  catalog: readonly CatalogEntry[];
  state: StateSnapshot;
  currentChapter: number | null;
}) {
  const parts = tocParts(catalog, currentChapter);
  const written = writtenCount(catalog);

  return (
    <section className="page toc" id="toc" aria-label={tocAriaLabel(written, state.chapters.total)}>
      <p className="toc-label">оглавление</p>

      {parts.map((part) => (
        <div className="toc-part" key={part.part}>
          <p className="toc-part-h">часть {part.numeral}</p>
          <ul className="slots">
            {part.entries.map((entry) => (
              <li
                className={`toc-row${entry.link ? '' : ' toc-row-empty'}${entry.current ? ' current' : ''}`}
                key={entry.n}
                aria-hidden={entry.link || entry.current ? undefined : true}
              >
                {entry.link ? (
                  <a
                    className="toc-link"
                    href={entry.href}
                    onClick={(event) => {
                      event.preventDefault();
                      scrollToChapter(entry.n);
                    }}
                  >
                    <span className="toc-num">{chapterLabel(entry.n)}</span>
                    {entry.text === null ? null : <span className="toc-text">{entry.text}</span>}
                    {entry.current ? <i className="toc-dot" aria-label="пишется сейчас" /> : null}
                  </a>
                ) : (
                  <span className="toc-line">
                    <span className="toc-num">{chapterLabel(entry.n)}</span>
                    {entry.current ? <i className="toc-dot" aria-label="пишется сейчас" /> : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
