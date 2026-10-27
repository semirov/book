import { chapterLabel, type CatalogEntry, type StateSnapshot } from '@book/shared';

import { scrollToChapter } from '../dom.ts';
import { tocAriaLabel, tocParts, writtenCount } from '../lib/toc.ts';

/**
 * Живое оглавление (ARCHITECTURE §6C.7, §11.8; BOOK-DOC-5 §4): four numbered parts, 67
 * rows, and no invented titles. A row shows its chapter's title line, the frozen frame
 * sentence of a basis slot (ch01/ch67), the word «написана» for a written chapter that has no
 * title line (BOOK-137), or — for a slot that holds no prose at all — nothing: a number and
 * its page. A row that says no text is still exposed, and the page it opens is spoken as
 * `страница N`. No invented state word («замысел» was BOOK-89's and is gone), no leader
 * glyphs, no row rules, no part ranges, no repeated book title, and no marker beside the
 * numeral: the column of numbers is the structural mark (owner, 2026-10-27: no arrows and no
 * caret dot in the TOC).
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
    <section className="page sheet toc" id="toc" aria-label={tocAriaLabel(written, state.chapters.total)}>
      <p className="toc-label">оглавление</p>

      {parts.map((part) => (
        <div className="toc-part" key={part.part}>
          <p className="toc-part-h">часть {part.numeral}</p>
          <ul className="slots">
            {part.entries.map((entry) => {
              // BOOK-89: the page is spoken after the row's own text and never enters its
              // visible reading: the numeral, the text (if any) and `страница N` are separate.
              const page = (
                <span className="toc-page">
                  {/* The digit is drawn, not spoken: «страница N» below is the only page text,
                      so a row's accessible name carries the number once, not twice. */}
                  <span aria-hidden="true">{entry.page}</span>
                  <span className="sr-only">страница {entry.page}</span>
                </span>
              );
              const text =
                entry.text === null ? null : <span className="toc-text">{entry.text}</span>;
              return (
                <li
                  className={`toc-row${entry.link ? '' : ' toc-row-empty'}${entry.current ? ' current' : ''}`}
                  key={entry.n}
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
                      {text}
                      {page}
                    </a>
                  ) : (
                    <span className="toc-line">
                      <span className="toc-num">{chapterLabel(entry.n)}</span>
                      {text}
                      {page}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
