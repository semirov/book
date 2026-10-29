import type { MyFilingsDto, MyTraceDto, ViewerDto } from '@book/shared';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import { getMyFilings, getMyTrace, postAuthorsHide } from '../api.ts';
import { anchorCopy, commentStamp, commentStatusLine } from '../lib/commentView.ts';
import { filingNumber, filingWord } from '../lib/filings.ts';
import type { ChapterLoader } from '../lib/place.ts';
import { traceLine } from '../lib/trace.ts';
import { PlaceLink } from './PlaceLink.tsx';

/**
 * BOOK-207 — «ваш след», the reader's own page.
 *
 * A page of the book, not a modal and not a sheet: one `<section class="page sheet sled">` in
 * the same column, reached by `#след` from the foot and left by `к оглавлению` (`#toc`).
 *
 * The page holds two facts: the trace line (`пережила 12 ревизий, сейчас 0,4 %`) with its one
 * hide toggle, and the reader's own filings, newest first — the filing's number with its noun,
 * its state word and moment, the quote as a door back to the sentence, the state's own detail
 * and the two lines of how it was read. `показаны последние 50` prints only when the read
 * returned exactly the bound; there is no total, because the page did not read one.
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
   * `к оглавлению` changes the mode first: the browser has nothing to scroll to while the trail
   * is mounted. The hash is set at once (the book becomes the page), and the contents are landed
   * once they exist — a bounded wait of 20 frames, never a claim that it moved.
   */
  const exit = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    window.location.hash = '#toc';
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
                  const line = commentStatusLine(comment);
                  return (
                    <li className="sled-row" key={comment.id} data-comment-id={comment.id}>
                      <p className="sled-meta">
                        {`замечание ${filingNumber(comment)} · ${filingWord(comment)} · ${commentStamp(comment.createdAt)}`}
                      </p>
                      {quote === null ? null : (
                        <p className="sled-quote">
                          <PlaceLink place={comment} {...(onLoadChapter === undefined ? {} : { onLoadChapter })}>
                            «{quote}»
                          </PlaceLink>
                        </p>
                      )}
                      {line.detail === null ? null : <p className="sled-detail">{line.detail}</p>}
                      {comment.report === null || comment.report === undefined ? null : (
                        <>
                          <p className="sled-detail">{comment.report.line1}</p>
                          <p className="sled-detail">{comment.report.line2}</p>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}

      <p className="sled-exit">
        <a href="#toc" onClick={exit}>
          к оглавлению
        </a>
      </p>
    </section>
  );
}
