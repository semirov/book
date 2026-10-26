import { TOTAL_CHAPTERS, type FrontDto, type StateSnapshot } from '@book/shared';

import { formatNumber } from '../lib/format.ts';
import { IDLE_TITLE, titleMotionClass, type TitleMotion } from '../lib/titleChange.ts';

/**
 * Обложка (DESIGN §7.3, ARCHITECTURE §11.8): the live title, the author, the copyright,
 * and one line of model honesty. No publisher, no ISBN, no year, no cover image — the
 * typography is the cover. The title is a slot: a ripple that reaches the first sheet
 * swaps the word, not the sheet.
 */
export function TitleSheet({
  state,
  front,
  motion = IDLE_TITLE,
}: {
  state: StateSnapshot;
  front: FrontDto;
  motion?: TitleMotion;
}) {
  const animation = titleMotionClass(motion) || 'fade-in';
  return (
    <section className="page titul">
      <p className="kicker">роман</p>
      <h1 className={`title ${animation}`} key={`title-${motion.token}-${front.rev}-${front.title ?? ''}`}>
        {front.title ?? 'Книга'}
      </h1>
      <p className="subtitle">в шестидесяти семи главах</p>
      <div className="double-rule" aria-hidden="true" />
      <p className="author">{front.imprint.author}</p>
      <p className="premise">
        Четыре линии вперёд, четыре назад. Замечания идут в очередь, правки — по одной.
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
      <p className="cover-note">книга пишется в открытую · {TOTAL_CHAPTERS} глав</p>
      <p className="copyright">{front.imprint.copyright}</p>
    </section>
  );
}
