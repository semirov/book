import type { FrontDto } from '@book/shared';
import { useEffect, useRef } from 'react';

import { track } from '../lib/analytics.ts';
import { IDLE_TITLE, titleMotionClass, type TitleMotion } from '../lib/titleChange.ts';
import { useTitleTyping } from '../useFrontSequence.ts';

/**
 * The owner's category line (BOOK-39, 2026-10-27), verbatim. It sits on page 1 by his
 * decision, which reverses the earlier rule that a title page does not label its own genre.
 * It is book matter in tone, not marketing: one constant, no card, no eyebrow, no arrow, no
 * exclamation. It is not the promise and it never counts the book's lines.
 */
export const TITLE_GENRE =
  'Литературно-инженерный перформанс: книга пишется публично, а читатели оставляют в ней след.';

/**
 * The book's promise, in plain words (BOOK-DOC-4 «Book front and back matter»). It is book
 * matter, not marketing: one constant, verbatim, no card, no button, no exclamation, no
 * arrow. The promise is not a rule the site can enforce yet — it is the book telling the
 * reader what an intervention costs.
 */
export const TITLE_PROMISE =
  'Один читатель — одно вмешательство в день. Твоя фраза может пережить книгу. Или исчезнуть.';

/**
 * The plate's `alt` (BOOK-131 comment #3738 §6): the drawing as the eye finds it — the lamp, the
 * sheet on the desk, the row of fading figures at the right wall. One constant, short and honest,
 * and no personal data: the pale sheet on the desk is drawn and illegible, so nothing here reads
 * a word that the image does not show.
 */
export const COVER_ALT =
  'Обложка: комната с лампой над столом, бланк на столе, у стены справа — ряд стирающихся фигур.';

/**
 * The small derivative — 426 × 640, not "640 wide": the number in the file's name is its
 * **height**, and its width follows the 2:3 ratio of the original (1 024 → 1 536). It is a
 * downscale of that original, never a crop of it.
 */
const COVER_SRC = '/cover/cover-640.jpg';
/**
 * The `w` descriptors are the files' true intrinsic widths, read from their headers (the test
 * parses each JPEG's SOF segment). Declaring `640w` for a 426 px file would make every browser
 * believe it has 640 px: a 1.5× upscale by the descriptor, 1.6× in the paint.
 */
const COVER_SRC_SET = '/cover/cover-640.jpg 426w, /cover/cover-1024.jpg 1024w';
/**
 * The declared slot, not the measured one (BOOK-131 comment #3738 §6).
 *
 * The asset facts: the file named «640» is 426 × 640, so the 390 px slot (342 px wide) reads it
 * at 1.25×; the `srcset` now declares the files' true widths, so no engine has to guess a
 * density the files do not have. Which candidate an engine serves is the engine's decision, not
 * this sheet's claim — a browser may keep the 426 file where the spec would allow the 1024 one.
 * The ~640-wide derivative (~200 KB) does not exist: that is an owner-side asset gap, and the
 * design named 672w as the useful top.
 *
 * `sizes` stays the design's arithmetic: at 600 px the canvas still holds its gutters, so the
 * 218 px step over-declares the real slot by ≤31 px (187.6 vs 218) — accepted, because a magic
 * breakpoint there is not worth it.
 */
const COVER_SIZES = '(max-width: 599px) 320px, (max-width: 1023px) 218px, 224px';

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
 * read one measurement. BOOK-70: «+ N» is a reference chip and a count of nothing is not a
 * count — on a book nobody has touched the author stands alone.
 *
 * BOOK-DOC-49 §3 — the title is the one block the first load **types**. The printing loop lives
 * in `TypedTitle` below, which is the component that draws the `h1`: its per-frame state may not
 * sit in `Opening`, or every grapheme would re-render the whole opening (page 2 re-splits
 * `front.about` on each render). `useTitleTyping` is the engine's only caller. With no run the
 * title is whole, which is every render outside the first load. The `h1` carries the name in
 * `aria-label` and both of its children are `aria-hidden`, so the word is printed once — no
 * ghost, no visually hidden duplicate — and `h1.textContent` is the title itself at every moment
 * the sequence has ended. `data-caret` is what the sheet reads to turn `text-wrap: balance` off
 * while the line fills.
 *
 * BOOK-131 — the cover plate is the sheet's **second column**, not a row of the reading sequence.
 * A frontispiece faces the title page; this site has one column, so the facing page is translated
 * into the sheet's right column (a spread at ≥600 px, a stack under the text on the phone). It is
 * the section's **last** child on purpose: the owner's four blocks keep their order and their
 * first place in the reading sequence, and the plate is tagged `cover` only for a page load that
 * owns a sequence — never as a row of the order above. It is not interactive — no link, no hover,
 * no zoom — and it is never a caption: what says it is the cover is geometry, nothing else.
 */
export function TitleSheet({
  front,
  motion = IDLE_TITLE,
  seq = false,
  running = false,
}: {
  front: FrontDto;
  motion?: TitleMotion;
  /** This block belongs to this page load's sequence (BOOK-DOC-49): the sheet owns its delays. */
  seq?: boolean;
  /** The sequence is live: the title types. Every other state prints the server's word whole. */
  running?: boolean;
}) {
  const animation = titleMotionClass(motion);
  /** The readers whose text survived; `+ 0` is a count of nothing and is not printed. */
  const readers = front.authors?.count ?? 0;
  const title = front.title ?? 'Книга';
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
      <div className="titul-text">
        <TypedTitle
          headingKey={`title-${motion.token}-${front.rev}-${front.title ?? ''}`}
          title={title}
          animation={animation}
          seq={seq}
          running={running}
        />
        <p className="author" data-seq={seq ? 'byline' : undefined}>
          {front.imprint.author}
          {/* The space belongs to the byline, not to the chip: a chip is `+ 3`, never ` + 3`. */}
          {readers >= 1 ? (
            <>
              {' '}
              <span className="author-plus">{`+ ${readers}`}</span>
            </>
          ) : null}
        </p>
        <p className="title-genre" data-seq={seq ? 'genre' : undefined}>
          {TITLE_GENRE}
        </p>
        <p className="title-promise" data-seq={seq ? 'promise' : undefined}>
          {TITLE_PROMISE}
        </p>
      </div>
      {/* The second column of the sheet, and its last child (BOOK-131). `width`/`height` reserve
          the 2:3 box before the bytes land (CLS 0); `fetchPriority="high"` because the plate is
          above the fold at 390, 768, 1024 and 1440, and it is the first screen's only image. The
          `w` descriptors are the files' real widths: the derivative named «640» is 426 × 640, so
          the 342 px phone slot reads it at 1.25×. */}
      <img
        className="cover-plate"
        src={COVER_SRC}
        srcSet={COVER_SRC_SET}
        sizes={COVER_SIZES}
        width={1024}
        height={1536}
        alt={COVER_ALT}
        loading="eager"
        decoding="async"
        fetchPriority="high"
        data-seq={seq ? 'cover' : undefined}
      />
    </section>
  );
}

/**
 * BOOK-DOC-49 §3 — the `h1`, and the only component in the opening that re-renders per frame.
 *
 * The typing state has to live exactly here: the caret's phase is written into `data-caret` on
 * the `h1` (`text-wrap: balance` is off while the line fills) and the caret itself is a child of
 * the typed span, so the h1's own component is the smallest thing a grapheme can update. The
 * title is whole whenever the driver is not running, which is every render outside the sequence.
 */
function TypedTitle({
  headingKey,
  title,
  animation,
  seq,
  running,
}: {
  /** `front:updated` keys the heading so the ripple's CSS animation restarts on a renamed title. */
  headingKey: string;
  title: string;
  animation: string;
  seq: boolean;
  running: boolean;
}) {
  const printed = useTitleTyping(title, running) ?? { text: title, caret: null };
  return (
    <h1
      className={`title${animation === '' ? '' : ` ${animation}`}`}
      key={headingKey}
      aria-label={title}
      data-seq={seq ? 'title' : undefined}
      data-caret={printed.caret ?? undefined}
    >
      <span aria-hidden="true">
        {printed.text}
        {/* §3: inside the typed span, after the last revealed grapheme — never absolutely
            placed, so it cannot be orphaned at the start of a line. */}
        {printed.caret === null ? null : (
          <span
            className={`caret-inline ${printed.caret === 'resting' ? 'resting' : 'blink'}`}
            aria-hidden="true"
          />
        )}
      </span>
    </h1>
  );
}
