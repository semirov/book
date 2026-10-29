import { outcomeLine, type CommentDto, type MyFilingsDto, type MyTraceDto, type ViewerDto } from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getMyFilings, getMyTrace, postAuthorsHide } from '../api.ts';
import { changeNumber } from '../lib/changeStatus.ts';
import { anchorCopy, commentStamp } from '../lib/commentView.ts';
import { filingSentence, outcomeOf } from '../lib/marginalia.ts';
import type { ChapterLoader } from '../lib/place.ts';
import { traceLine } from '../lib/trace.ts';
import { PlaceLink } from './PlaceLink.tsx';
import { ScreenExit } from './ScreenExit.tsx';

/**
 * BOOK-221 / BOOK-218 — the trail row, in the reader's own vocabulary (BOOK-DOC-82).
 *
 * The row used to print our machinery: «замечание №A7K · внесено» and «в очереди на запись».
 * A reader is owed a number («правка 014»), the chapter and the moment, and one sentence that
 * says what became of **their** edit. That sentence is the module's — `filingSentence` from
 * `@book/shared`'s `stateWords.ts` through `lib/marginalia.ts` — and this file spells no state
 * word of its own.
 */

/**
 * The one sentence a row says about its own state — the module's, never a table of its own.
 * BOOK-218: where the row names an outcome (a reading, a lock, our failure) that outcome is the
 * whole sentence; otherwise the deck's own line stands.
 */
export function trailStateLine(comment: CommentDto): string {
  const outcome = outcomeOf(comment);
  return outcome === null ? filingSentence(comment) : outcomeLine(outcome);
}

export function trailMetaLine(comment: CommentDto): string {
  const head =
    comment.changeSeq === null || comment.changeSeq === undefined
      ? `правка по главе ${String(comment.chapter)}`
      : `правка ${changeNumber(comment.changeSeq)} · глава ${String(comment.chapter)}`;
  return `${head} · ${commentStamp(comment.createdAt)}`;
}

/**
 * BOOK-207 — «ваш след», the reader's own page.
 *
 * A page of the book, not a modal and not a sheet: one `<section class="page sheet sled">` in
 * the same column, reached by `#след` from the foot and left by the one exit at its top
 * (`ScreenExit`, BOOK-221).
 *
 * The page holds two facts: the trace line (`lib/trace.ts` — what changed, when, and what is the
 * reader's now) with its one hide toggle, and the reader's own filings, newest first — the
 * filing's number and moment, its state's own sentence, the quote as a door back to the
 * sentence, and the two lines of how it was read. `показаны последние 50` prints only when the
 * read returned exactly the bound; there is no total, because the page did not read one.
 *
 * States are honest and exclusive: signed out asks for the sign-in, empty says so, a failed
 * read says it could not read and offers `повторить`, and the wait is one status line re-replaced
 * in place. No count, no modal, no floating layer.
 */
export function TrailPage({
  viewer,
  onLoadChapter,
}: {
  viewer: ViewerDto;
  onLoadChapter?: ChapterLoader;
}) {
  const head = useRef<HTMLHeadingElement>(null);
  const [trace, setTrace] = useState<MyTraceDto | null>(null);
  const [filings, setFilings] = useState<MyFilingsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidePending, setHidePending] = useState(false);

  const load = useCallback(async () => {
    if (!viewer.signedIn) return;
    setFailed(false);
    setTrace(null);
    setFilings(null);
    try {
      const [ownTrace, ownFilings] = await Promise.all([getMyTrace(), getMyFilings()]);
      setTrace(ownTrace);
      setFilings(ownFilings);
    } catch {
      setFailed(true);
    }
  }, [viewer.signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The mode opens at the page's top: the book tree leaves, the document shrinks, and a reader
   * who tapped `след` past the first screenful would otherwise land at the trail's bottom on the
   * browser's clamped offset. The head then takes focus without a second scroll.
   */
  useEffect(() => {
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'auto' });
    head.current?.focus({ preventScroll: true });
  }, []);

  const toggleHidden = async (hidden: boolean): Promise<void> => {
    setHidePending(true);
    try {
      const result = await postAuthorsHide(hidden);
      setTrace((current) => (current === null ? current : { ...current, hidden: result.hidden }));
    } catch {
      /* the flag did not change: the button stays as it was, nothing claims success */
    } finally {
      setHidePending(false);
    }
  };

  const waiting = viewer.signedIn && !failed && (trace === null || filings === null);

  /**
   * The exit's enhancement, never its handler: the browser makes the mode change on its own
   * (`#toc` is a real href), and the contents are landed once they exist — a bounded wait of 20
   * frames, never a claim that it moved. Nothing here prevents the navigation or sets the hash.
   */
  const exit = (): void => {
    if (typeof window.requestAnimationFrame !== 'function') return;
    let frames = 0;
    const land = (): void => {
      const toc = document.getElementById('toc');
      if (toc !== null) {
        toc.scrollIntoView({ block: 'start', behavior: 'auto' });
        return;
      }
      frames += 1;
      if (frames < 20) window.requestAnimationFrame(land);
    };
    window.requestAnimationFrame(land);
  };

  return (
    <section className="page sheet sled ym-hide-content ym-disable-clickmap" aria-label="ваш след">
      <ScreenExit onFollow={exit} />

      <h2 className="sled-head" tabIndex={-1} ref={head}>
        ваш след
      </h2>

      {!viewer.signedIn ? (
        <>
          <p className="sled-line">войдите, чтобы увидеть свой след</p>
          <p className="sled-signed-out">
            <a href="/auth/yandex/start">войти через Яндекс</a>
          </p>
        </>
      ) : failed ? (
        <>
          <p className="sled-line" role="status">
            след не прочитался
          </p>
          <p className="sled-retry">
            <button type="button" onClick={() => void load()}>
              повторить
            </button>
          </p>
        </>
      ) : waiting ? (
        <p className="sled-line" role="status" aria-live="polite">
          след читается
        </p>
      ) : (
        <>
          {trace === null ? null : (
            <>
              <p className="sled-trace">{traceLine(trace)}</p>
              <p className="sled-toggle-line">
                {trace.isAuthor ? null : (
                  <button
                    type="button"
                    className="sled-toggle"
                    disabled={hidePending}
                    onClick={() => void toggleHidden(!trace.hidden)}
                  >
                    {trace.hidden ? 'вернуть в список' : 'скрыть из списка авторов'}
                  </button>
                )}
              </p>
            </>
          )}

          {filings === null || filings.items.length === 0 ? (
            <p className="sled-line">вы ещё ничего не написали</p>
          ) : (
            <>
              {filings.items.length === 50 ? <p className="sled-bound">показаны последние 50</p> : null}
              <ul className="sled-rows">
                {filings.items.map((comment) => {
                  const quote = anchorCopy(comment);
                  return (
                    <li className="sled-row" key={comment.id} data-comment-id={comment.id}>
                      <p className="sled-meta">{trailMetaLine(comment)}</p>
                      {quote === null ? null : (
                        <p className="sled-quote">
                          <PlaceLink place={comment} {...(onLoadChapter === undefined ? {} : { onLoadChapter })}>
                            «{quote}»
                          </PlaceLink>
                        </p>
                      )}
                      <p className="sled-state">{trailStateLine(comment)}</p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
