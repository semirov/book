import { TOTAL_CHAPTERS, type StateSnapshot } from '@book/shared';

/**
 * The 0/67 screen (ARCHITECTURE §11.2; DESIGN §7.18). It is a designed beginning, not a
 * fallback: the cover above it carries the live title, the TOC below lists all 67 slots,
 * and this band says what the reader is looking at — two drafts writing towards each
 * other in public, with a fixed ending.
 */
export function EmptyState({ state }: { state: StateSnapshot }) {
  if (state.chapters.count > 0) return null;
  return (
    <section className="page start" id="start" aria-label="начало книги">
      <header className="sec-h">
        <span className="lbl">начало</span>
        <span className="sec-meta">
          0 / {TOTAL_CHAPTERS}
        </span>
      </header>
      <div className="start-frame">
        <p className="start-line">книга начинается</p>
        <p className="start-sub">её пишут в открытую</p>
        <div className="start-spine" aria-hidden="true">
          <i className="caret" />
          <i className="caret right" />
        </div>
        <ul className="facts">
          <li>{TOTAL_CHAPTERS} глав</li>
          <li>четыре части</li>
          <li>конец фиксирован</li>
          <li>люди появляются по ходу</li>
        </ul>
      </div>
      <p className="fine">
        Здесь пока нет ни одной строки: пустые графы — это и есть книга до первой записи. Текст
        появится сам, а оглавление соберётся из названий глав.
      </p>
    </section>
  );
}
