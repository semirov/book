import { TOTAL_CHAPTERS, type StateSnapshot } from '@book/shared';

import { formatNumber } from '../lib/format.ts';

/**
 * Пластина 0/67 (DESIGN §7.18): the day-one screen pasted into the page like an exhibit,
 * with a caret at each end — both ends write. Shown only while the book is empty; after
 * the first chapter the header and the опись carry the same facts without repeating them.
 */
export function Plate({ state }: { state: StateSnapshot }) {
  return (
    <section className="page plate" id="start">
      <header className="sec-h">
        <span className="lbl">начало</span>
        <span className="sec-meta">
          {state.chapters.count} / {TOTAL_CHAPTERS}
        </span>
      </header>
      <div className="plate-frame">
        <div className="pf-top">
          <span>книга · {TOTAL_CHAPTERS} глав</span>
          <span>
            {state.chapters.count} / {TOTAL_CHAPTERS}
          </span>
        </div>
        <div className="pf-spine" aria-hidden="true">
          <i className="caret" />
          <i className="caret r" />
        </div>
        <p className="pf-title">Книга</p>
        <p className="pf-line">книга начинается</p>
        <div className="pf-pair">
          <span>
            → 01<b>вперёд</b>
          </span>
          <span>
            ← {TOTAL_CHAPTERS}<b>назад</b>
          </span>
        </div>
        <p className="pf-note">
          чистый лист · {TOTAL_CHAPTERS} граф · {formatNumber(state.chapters.totalChars)} знаков
        </p>
      </div>
      <p className="fine">
        Так сайт выглядит в первый день: 67 пустых граф, две смены на концах, ни одной строки. Каретка
        слева и каретка справа — обе пишут.
      </p>
    </section>
  );
}
