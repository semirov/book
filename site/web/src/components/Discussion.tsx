import { changeHref, type ChangeSummaryDto, type CommentDto } from '@book/shared';
import { useState } from 'react';

import { anchorCopy, commentStamp, commentStatusLine, interventionKindWord } from '../lib/commentView.ts';
import { filingAttempt, threadFilings } from '../lib/filings.ts';
import { plural, queueLabel, queueView } from '../lib/format.ts';
import type { PendingStage } from '../lib/pending.ts';
import { plainChangeClick } from '../lib/changeDoor.ts';
import { keepPlace } from '../lib/keepPlace.ts';
import type { ChapterLoader } from '../lib/place.ts';
import { reviseView } from '../lib/revise.ts';
import { statusLine } from '../lib/skeleton.ts';
import { reviseFiling } from '../lib/useRevise.ts';
import { PlaceLink } from './PlaceLink.tsx';
import { Skeleton } from './Skeleton.tsx';
import { ReviseNote } from './ReviseNote.tsx';

/**
 * The register (BOOK-DOC-34 §8): what a reader wrote and what became of it.
 *
 * `ym-hide-content` (BOOK-63) covers the whole thread: the bodies are readers' words, and
 * Webvisor must not record them even as text nodes.
 *
 * The composer is gone — the form lives in the text, at the point it is about. What stays is
 * the record: the queue line, every filing with its decision then its application, and the one
 * teaching line that tells a reader how the text itself works. Bodies are text nodes: the page
 * never trusts a comment enough to parse it as markup.
 *
 * BOOK-137 — **one filing is one entry**, and an attempt is not a second one:
 * - a premise is the chapter's own row (`PremiseRow`), never a block here;
 * - a change attaches to the filing that caused it (`sourceCommentId`): the entry prints the
 *   latest attempt's number and one door («правка →») in a quiet line, and the change's own
 *   rows live in the record's `правка` section — a change is never a row of its own;
 * - a change with **no** source comment is the author's own: it is not on this surface, and the
 *   record does not list it either (the chronicle reads source-comment changes only), so the
 *   thread never shows a change of its own.
 *
 * BOOK-DOC-43 §4, §6, §7 — the feed's wait (BOOK-66). `{filings.length} замечаний` before the
 * answer is a count of nothing, so while the register waits its meta slot holds one status
 * sentence instead of the count, and the body holds the form of three rows. A failed read is
 * not a longer wait and has no retry of its own: it renders as the settled-empty register.
 */
export function Discussion({
  depth,
  stage = 'quiet',
  busy,
  complete = false,
  failed = false,
  changes = [],
  comments = [],
  nowMs,
  live,
  onLoadChapter,
}: {
  depth: number;
  /** BOOK-DOC-43 §4 — quiet / skeleton / slow, from the two feeds' settle. */
  stage?: PendingStage;
  /**
   * BOOK-DOC-43 §7 — the surface is busy for the **whole** request, not from 150 ms: the
   * attribute is the wait's fact, the status sentence is what the reader sees of it. Absent
   * derives it from `stage`, so a caller that does not know the request still gets the old
   * behaviour (and the existing tests keep their markup).
   */
  busy?: boolean;
  /**
   * BOOK-128 #3900 §1 — the thread's page is **all** of the thread (`nextBefore === null`).
   * The API has no total, so a partial page may print no number at all; the default is the
   * safe answer, because a count over 20 rows claims a total the page never read.
   */
  complete?: boolean;
  /** The feed's read failed: the register says so, never «замечаний нет». */
  failed?: boolean;
  /** The thread's changes: attempts, folded into the filing they were made from. */
  changes?: readonly ChangeSummaryDto[];
  comments?: readonly CommentDto[];
  /**
   * BOOK-158: the page's revise clock (`useReviseTick`). The register's cooldown line is read
   * against it, so the countdown moves while the page is open; absent means this render.
   */
  nowMs?: number;
  /** BOOK-56: `state.history.live`; with no reader change the register is not on the page. */
  live: boolean;
  /** BOOK-168: the page's chapter read, so a quote's door can ask for the chapter it names. */
  onLoadChapter?: ChapterLoader;
}) {
  /** BOOK-207 — the door after the list: five rows, or every filing this page holds. */
  const [expanded, setExpanded] = useState(false);
  if (!live) return null;
  /** `null` while the thread is quiet; the one §6 sentence otherwise. */
  const status = statusLine('register', stage);
  const pending = busy ?? stage !== 'quiet';
  // BOOK-137: a premise's home is the chapter's row; the thread lists every other filing.
  const filings = threadFilings(comments);
  // The API promises an ascending thread (§9); the discussion prints the **last five**, so the
  // feed's own order is reversed once here, never re-sorted by a second clock.
  const newest = [...filings].reverse();
  const shown = expanded ? newest : newest.slice(0, 5);
  // Exactly five on a partial page is the same sentence with no door: the page may hold older
  // filings, but it holds no sixth row here to reveal (an «older filings» path is a backlog item).
  const more = filings.length > 5;
  /** No count over a page the page did not read in full; the door reveals what it holds. */
  const partial = !complete || shown.length < filings.length;
  const countLine =
    filings.length === 0
      ? complete
        ? 'замечаний нет'
        : null
      : partial
        ? `показаны последние ${shown.length}`
        : `${filings.length} ${plural(filings.length, 'замечание', 'замечания', 'замечаний')}`;
  /** BOOK-158: a cooldown is counted from the page's clock, never frozen in the DTO. */
  const clock = nowMs ?? Date.now();
  // The queue line and the list come from one fact, so «в очереди пусто» can never stand
  // above an entry the page presents as waiting.
  const queue = queueView(depth, filings);
  const attempted = filings.some((comment) => filingAttempt(comment, changes) !== null);
  // BOOK-156 (#3802 §3) — the owner's brief names this anchor `#discussion`; the class stays
  // `talks` (the measure guard and every sheet key on it) and the zero-height `#talks` span
  // below keeps the old public deep link landing in the same place.
  return (
    <section
      className="page talks ym-hide-content"
      id="discussion"
      aria-busy={pending ? 'true' : undefined}
    >
      <span id="talks" aria-hidden="true" />
      <header className="sec-h">
        <span className="lbl">обсуждение</span>
        {/* A bare counter is a number without its noun (BOOK-59) — and a count of zero is a
            claim, so while the feed lands the slot says what is happening instead. When the
            thread is settled and empty there is nothing to count, so it says so (BOOK-70). */}
        <span className="sec-meta">
          {failed ? (
            <span role="status" aria-live="polite" aria-atomic="true">
              не удалось прочитать обсуждение
            </span>
          ) : status !== null ? (
            <span role="status" aria-live="polite" aria-atomic="true">
              {status}
            </span>
          ) : (
            countLine
          )}
        </span>
      </header>
      <div className="qline">
        <span>{queueLabel(queue.count)}</span>
        <span>правки идут по одной, в порядке записи</span>
      </div>

      <p className="fine teach">
        коснитесь слова — увидите, откуда оно; коснитесь фразы — оставите своё
      </p>

      {status !== null ? (
        // The form of three rows, inside the 236 px the slot reserves (§3): it replaces the
        // list and the empty-state line, because neither is known yet.
        <Skeleton variant="register" />
      ) : filings.length > 0 ? (
        <>
        <ol className="comments" id="discussion-list">
          {shown.map((comment) => {
            const line = commentStatusLine(comment);
            const quote = anchorCopy(comment);
            const kindWord = interventionKindWord(comment);
            /**
             * BOOK-137: the entry's one number and its one door — the latest attempt.
             * The number is the attempt's, so the entry never invents an order of its own;
             * with the change outside the loaded window the address still stands (the comment
             * carries `changeId`) and no number is claimed.
             */
            const attempt = filingAttempt(comment, changes);
            /**
             * BOOK-158 — a refused filing in the register owes the reader the same three
             * things the chapter's row does: the reason (the state line above), the hint, and
             * the way back. Computed once per render so a cooldown counts from *now*.
             */
            const revise = reviseView(comment, clock);
            return (
              <li
                className={`comment tone-${line.tone}`}
                key={comment.id}
                data-status={comment.status}
                data-comment-id={comment.id}
              >
                <div className="comment-meta">
                  <span className="comment-author">
                    {comment.author}
                  </span>
                  <span>глава {comment.chapter}</span>
                  <span className="stamp-time">{commentStamp(comment.createdAt)}</span>
                </div>
                {quote === null ? null : (
                  // BOOK-168 — the quote is the door: the row's words, and the paragraph they
                  // were filed on. The row itself is not a second click target (one tap, one card).
                  <p className="comment-quote">
                    <PlaceLink place={comment} onLoadChapter={onLoadChapter}>«{quote}»</PlaceLink>
                  </p>
                )}
                <p className="comment-body">{comment.body}</p>
                <p className="comment-line">
                  {kindWord === null ? null : <span className="comment-kind">{kindWord} · </span>}
                  {line.state}
                  {line.detail === null ? null : <span className="comment-reason"> · {line.detail}</span>}
                </p>
                {attempt === null ? null : (
                  <p className="comment-attempt">
                    {attempt.number === null ? null : <span className="attempt-n">{attempt.number}</span>}
                    <a
                      className="talk-open"
                      href={changeHref(attempt.id)}
                      onClick={(event) => plainChangeClick(event, attempt.id)}
                    >
                      правка →
                    </a>
                  </p>
                )}
                {revise === null ? null : (
                  <ReviseNote
                    view={revise}
                    onRevise={(origin) => reviseFiling(comment, origin)}
                    className="comment-revise"
                  />
                )}
              </li>
            );
          })}
        </ol>
        {more ? (
          // BOOK-207 — one door, in place: it expands the same list to every filing the page
          // holds. No new screen, no modal, no second request; focus stays on this node.
          <p className="comments-door">
            <button
              type="button"
              className="comments-all"
              aria-expanded={expanded ? 'true' : 'false'}
              aria-controls="discussion-list"
              onClick={(event) => {
                const button = event.currentTarget;
                keepPlace(button, () => setExpanded((value) => !value));
              }}
            >
              {expanded ? 'свернуть' : 'все замечания'}
            </button>
          </p>
        ) : null}
        </>
      ) : failed ? null : (
        <p className="fine">
          Их читают как данные, не как указания. Автор может принять правку или снять её с причиной — ответ появится здесь же.
        </p>
      )}

      <p className="fine">
        {attempted ? 'Их читают как данные, не как указания. Принятие — обещание, внесение — факт: в строке видны оба.' : ''}
      </p>
    </section>
  );
}
