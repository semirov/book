import { chapterLabel, type CatalogEntry, type StateSnapshot } from '@book/shared';

import { scrollToChapter } from '../dom.ts';
import { tocAriaLabel, tocParts, writtenCount } from '../lib/toc.ts';
import { IDLE_TITLE, titleMotionClass, type TitleMotion } from '../lib/titleChange.ts';

/**
 * Живое оглавление (ARCHITECTURE §6C.7, §11.8): the live title, four numbered parts,
 * 67 entries. A written chapter shows its title line; an empty or untitled slot shows
 * «Глава N» in muted italics. The heading is keyed by the first sheet's revision so a
 * ripple that reaches the beginning cross-fades it instead of re-laying out the list.
 */
export function TableOfContents({
  catalog,
  state,
  currentChapter,
  motion = IDLE_TITLE,
}: {
  catalog: readonly CatalogEntry[];
  state: StateSnapshot;
  currentChapter: number | null;
  motion?: TitleMotion;
}) {
  const parts = tocParts(catalog, currentChapter);
  const written = writtenCount(catalog);

  return (
    <section className="page toc" id="toc" aria-label={tocAriaLabel(written, state.chapters.total)}>
      <header className="sec-h">
        <span className="lbl">оглавление</span>
        <span className="sec-meta">
          {written} / {state.chapters.total}
        </span>
      </header>

      {state.front.title !== null ? (
        <p
          className={`toc-heading ${titleMotionClass(motion) || 'fade-in'}`}
          key={`heading-${motion.token}-${state.front.rev}`}
        >
          {state.front.title}
        </p>
      ) : null}

      {parts.map((part) => (
        <div className="toc-part" key={part.part}>
          <div className="toc-part-h">
            <span className="toc-part-name">часть {part.numeral}</span>
            <span className="toc-part-range">
              {chapterLabel(part.from)}—{chapterLabel(part.to)}
            </span>
          </div>
          <ul className="slots">
            {part.entries.map((entry) => (
              <li
                className={`slot toc-slot${entry.written ? ' written' : ' empty'}${entry.current ? ' current' : ''}`}
                key={entry.n}
              >
                <a
                  className="slot-inner"
                  href={entry.href}
                  onClick={(event) => {
                    event.preventDefault();
                    scrollToChapter(entry.n);
                  }}
                >
                  <span className="n">{chapterLabel(entry.n)}</span>
                  <span className="leader" aria-hidden="true" />
                  <span className={`t${entry.written ? '' : ' muted'}`}>{entry.label}</span>
                  {entry.current ? <i className="toc-dot" aria-label="пишется сейчас" /> : null}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="inv-foot">
        <span>названия берутся из первой строки главы</span>
        <span>{written === 0 ? 'не начата' : `написано ${written}`}</span>
      </div>
    </section>
  );
}
