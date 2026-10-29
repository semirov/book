import { chapterLabel, type CatalogEntry, type StateSnapshot } from '@book/shared';

import { jumpToChapter } from '../lib/usePosition.ts';
import { tocAriaLabel, tocFrames, tocParts, writtenCount, type TocEntryView } from '../lib/toc.ts';

/**
 * Живое оглавление (ARCHITECTURE §6C.7, §11.8; BOOK-DOC-5 §4): four numbered parts of ten
 * chapters each, and the two frames outside them — the opening (ch01) first and the finale
 * (`TOTAL_CHAPTERS`) last, so the contents prints one row per chapter and no invented titles.
 *
 * A row shows (owner, 2026-10-28) its chapter's title line; failing that, a written chapter's
 * first five words (`…` when the prose goes on); failing that, a basis slot's frozen frame
 * sentence; and for a slot that holds no prose at all, the one word «Пусто» — never a state
 * word, never a bare number («написана» was BOOK-137's and is gone). The page it opens is
 * spoken as `страница N`. No leader glyphs, no row rules, no part ranges, no repeated book
 * title, and no marker beside the numeral: the column of numbers is the structural mark
 * (owner, 2026-10-27: no arrows and no caret dot in the TOC).
 *
 * **Every row opens its chapter**, empty ones included: a row is always an anchor to `#ch-N`,
 * and the empty chapter's own `<article id="ch-N">` is in the flow, so the tap lands on the
 * place the chapter stands in.
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
  const frames = tocFrames(catalog, currentChapter);
  const written = writtenCount(catalog);

  return (
    <section className="page sheet toc" id="toc" aria-label={tocAriaLabel(written, state.chapters.total)}>
      <p className="toc-label">оглавление</p>

      {frames.opening === null ? null : <TocFrameRows entry={frames.opening} />}

      {parts.map((part) => (
        <div className="toc-part" key={part.part}>
          <p className="toc-part-h">часть {part.numeral}</p>
          <ul className="slots">
            {part.entries.map((entry) => (
              <TocRow entry={entry} key={entry.n} />
            ))}
          </ul>
        </div>
      ))}

      {frames.finale === null ? null : <TocFrameRows entry={frames.finale} />}
    </section>
  );
}

/**
 * A frame row stands outside the parts (BOOK-155): it is the same `<ul class="slots">` a part
 * uses, with no part heading above it, so chapter 1 opens the contents and the finale closes
 * it while the four parts keep their own labels.
 */
function TocFrameRows({ entry }: { entry: TocEntryView }) {
  return (
    <ul className="slots">
      <TocRow entry={entry} />
    </ul>
  );
}

function TocRow({ entry }: { entry: TocEntryView }) {
  // BOOK-89: the page is spoken after the row's own text and never enters its visible reading:
  // the numeral, the text (if any) and `страница N` are separate.
  const page = (
    <span className="toc-page">
      {/* The digit is drawn, not spoken: «страница N» below is the only page text, so a row's
          accessible name carries the number once, not twice. */}
      <span aria-hidden="true">{entry.page}</span>
      <span className="sr-only">страница {entry.page}</span>
    </span>
  );
  const text = entry.text === null ? null : <span className="toc-text">{entry.text}</span>;
  return (
    <li className={`toc-row${entry.empty ? ' toc-row-empty' : ''}${entry.current ? ' current' : ''}`}>
      <a
        className="toc-link"
        href={entry.href}
        onClick={(event) => {
          // A real target exists for every row, so the tap is ours; if the section is missing
          // (a partial render) the browser's own `#ch-N` jump is the fallback, never a dead click.
          // BOOK-209: the row leaves a history entry behind (`jumpToChapter`), so back returns
          // the reader to the place they tapped from.
          if (jumpToChapter(entry.n)) event.preventDefault();
        }}
      >
        <span className="toc-num">{chapterLabel(entry.n)}</span>
        {text}
        {page}
      </a>
    </li>
  );
}
