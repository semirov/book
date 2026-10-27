import type { FrontDto } from '@book/shared';
import { useEffect, useRef } from 'react';

import { track } from '../lib/analytics.ts';
import { IDLE_TITLE, titleMotionClass, type TitleMotion } from '../lib/titleChange.ts';

/**
 * The owner's category line (BOOK-39, 2026-10-27), verbatim. It sits on page 1 by his
 * decision, which reverses the earlier rule that a title page does not label its own genre.
 * It is book matter in tone, not marketing: one constant, no card, no eyebrow, no arrow, no
 * exclamation. It is not the promise and it never counts the book's lines.
 */
export const TITLE_GENRE =
  'Литературно-инженерный перформанс: книга возникает прямо перед тобой, а читатели вмешиваются в её судьбу.';

/**
 * The book's promise, in plain words (BOOK-DOC-4 «Book front and back matter»). It is book
 * matter, not marketing: one constant, verbatim, no card, no button, no exclamation, no
 * arrow. The promise is not a rule the site can enforce yet — it is the book telling the
 * reader what an intervention costs.
 */
export const TITLE_PROMISE =
  'Один читатель — одно вмешательство в день. Твоя фраза может пережить книгу. Или исчезнуть.';

/**
 * Обложка (BOOK-39, BOOK-DOC-5 §2, ARCHITECTURE §11.8): the title, the live byline, the
 * owner's category line and the promise, in that order — and nothing else. The category line
 * is on page 1 by the owner's decision (BOOK-39), so a title sheet may now name the genre;
 * there is still no eyebrow, no length promise, no tagline, no ledger, no caption and no
 * copyright line. The title is a slot: a ripple that reaches the first sheet swaps the word,
 * not the sheet. First paint is still; only a real `front:updated` title change animates it.
 *
 * The byline is «author + N» with N from the server (`front.authors`), never a hardcoded
 * surname and never a client-side count: page 1 and the authors list must agree, so they
 * read one measurement. N is always rendered — on the empty book it reads «+ 0».
 */
export function TitleSheet({ front, motion = IDLE_TITLE }: { front: FrontDto; motion?: TitleMotion }) {
  const animation = titleMotionClass(motion);
  /**
   * `cover_seen` is the first screen **rendered**, not the shell requested (BOOK-63); the
   * ref keeps React's development double-mount from counting the same act twice.
   */
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    track('cover_seen', {});
  }, []);
  return (
    <section className="page titul">
      <h1
        className={`title${animation === '' ? '' : ` ${animation}`}`}
        key={`title-${motion.token}-${front.rev}-${front.title ?? ''}`}
      >
        {front.title ?? 'Книга'}
      </h1>
      <p className="author">{`${front.imprint.author} + ${front.authors?.count ?? 0}`}</p>
      <p className="title-genre">{TITLE_GENRE}</p>
      <p className="title-promise">{TITLE_PROMISE}</p>
    </section>
  );
}
