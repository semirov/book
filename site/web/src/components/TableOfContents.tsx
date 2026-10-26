import { chapterLabel, type CatalogEntry, type StateSnapshot } from '@book/shared';

import { scrollToChapter } from '../dom.ts';
import { tocAriaLabel, tocParts, writtenCount } from '../lib/toc.ts';

/**
 * Живое оглавление (ARCHITECTURE §6C.7, §11.8; BOOK-DOC-5 §4): four numbered parts, 67
 * rows, and no invented titles. A row shows its chapter's title line, or the frozen frame
 * sentence of a basis slot (ch01/ch67); an empty row is its numeral and nothing else — no
 * link, no focus ring, no scroll on tap. No leader dots, no row rules, no part ranges, no
 * repeated book title, and no marker beside the numeral: the column of numbers is the
 * structural mark (owner, 2026-10-27: no arrows and no caret dot in the TOC).
 *
 * `current` still decides whether an inert row is exposed to assistive tech — the fact stays,
 * the glyph does not.
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
                  </a>
                ) : (
                  <span className="toc-line">
                    <span className="toc-num">{chapterLabel(entry.n)}</span>
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
