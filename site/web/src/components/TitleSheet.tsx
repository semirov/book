import { TOTAL_CHAPTERS, type StateSnapshot } from '@book/shared';

import { formatNumber } from '../lib/format.ts';

/** Титульный лист: the title is a slot — swap the word, not the sheet (DESIGN §7.3). */
export function TitleSheet({ state }: { state: StateSnapshot }) {
  return (
    <section className="page titul">
      <p className="kicker">роман</p>
      <h1 className="title">Книга</h1>
      <p className="subtitle">в шестидесяти семи главах</p>
      <div className="double-rule" aria-hidden="true" />
      <p className="premise">
        Пишется здесь, с двух концов — навстречу. Замечания идут в очередь, правки — по одной.
      </p>
      <dl className="ledger">
        <div>
          <dt>глав</dt>
          <dd>{TOTAL_CHAPTERS}</dd>
        </div>
        <div>
          <dt>написано</dt>
          <dd>{formatNumber(state.chapters.count)}</dd>
        </div>
        <div>
          <dt>знаков</dt>
          <dd>{formatNumber(state.chapters.totalChars)}</dd>
        </div>
      </dl>
    </section>
  );
}
