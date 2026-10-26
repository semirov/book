import type { FrontDto } from '@book/shared';

import { IDLE_TITLE, titleMotionClass, type TitleMotion } from '../lib/titleChange.ts';

/**
 * The book's promise, in plain words (BOOK-DOC-4 «Book front and back matter»). It is book
 * matter, not marketing: one constant, verbatim, no card, no button, no exclamation, no
 * arrow. The category line («медленный multiplayer-роман») is not the promise and stays off
 * page 1. The promise is not a rule the site can enforce yet — it is the book telling the
 * reader what an intervention costs.
 */
export const TITLE_PROMISE =
  'Один читатель — одно вмешательство в день. Твоя фраза может пережить книгу. Или исчезнуть.';

/**
 * The cover caption (owner, 2026-10-27). It is web-layer copy, not manuscript text and not a
 * server field: the book's own words arrive on page 2. CSS sets it in uppercase; the line
 * carries no period. The owner's second sentence — where the two lines meet — is guidance for
 * the book, not cover copy, and stays off the cover.
 */
export const COVER_CAPTION = 'Восемь линий, четыре из начала в конец, четыре из конца в начало';

/**
 * Обложка (BOOK-DOC-5 §2, ARCHITECTURE §11.8): the title, the live byline, the promise and
 * one caption. No eyebrow, no length promise, no tagline, no ledger, no copyright line — a
 * title page does not label its own genre and makes no claim before the reader has read a
 * word. The title is a slot: a ripple that reaches the first sheet swaps the word, not the
 * sheet. First paint is still; only a real `front:updated` title change animates it.
 *
 * The byline is «author + N» with N from the server (`front.authors`), never a hardcoded
 * surname and never a client-side count: page 1 and the authors list must agree, so they
 * read one measurement. N is always rendered — on the empty book it reads «+ 0».
 */
export function TitleSheet({ front, motion = IDLE_TITLE }: { front: FrontDto; motion?: TitleMotion }) {
  const animation = titleMotionClass(motion);
  return (
    <section className="page titul">
      <h1
        className={`title${animation === '' ? '' : ` ${animation}`}`}
        key={`title-${motion.token}-${front.rev}-${front.title ?? ''}`}
      >
        {front.title ?? 'Книга'}
      </h1>
      <p className="author">{`${front.imprint.author} + ${front.authors?.count ?? 0}`}</p>
      <p className="title-promise">{TITLE_PROMISE}</p>
      <p className="cover-caption">{COVER_CAPTION}</p>
    </section>
  );
}
