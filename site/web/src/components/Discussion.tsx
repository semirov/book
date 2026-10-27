import { commentInkClass, type ChangeSummaryDto, type CommentDto } from '@book/shared';

import { anchorCopy, commentStamp, commentStatusLine, interventionKindWord } from '../lib/commentView.ts';
import { focusHash } from '../lib/focus.ts';
import { filingAttempt, threadFilings } from '../lib/filings.ts';
import { plural, queueLabel, queueView } from '../lib/format.ts';
import type { PendingStage } from '../lib/pending.ts';
import { statusLine } from '../lib/skeleton.ts';
import { Skeleton } from './Skeleton.tsx';

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
 *   latest attempt's number and one `прицел` in a quiet line, and the earlier attempts live
 *   inside the card — a change is never a row of its own;
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
  changes = [],
  comments = [],
  live,
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
  /** The thread's changes: attempts, folded into the filing they were made from. */
  changes?: readonly ChangeSummaryDto[];
  comments?: readonly CommentDto[];
  /** BOOK-56: `state.history.live`; with no reader change the register is not on the page. */
  live: boolean;
}) {
  if (!live) return null;
  /** `null` while the thread is quiet; the one §6 sentence otherwise. */
  const status = statusLine('register', stage);
  const pending = busy ?? stage !== 'quiet';
  // BOOK-137: a premise's home is the chapter's row; the thread lists every other filing.
  const filings = threadFilings(comments);
  // The queue line and the list come from one fact, so «в очереди пусто» can never stand
  // above an entry the page presents as waiting.
  const queue = queueView(depth, filings);
  const attempted = filings.some((comment) => filingAttempt(comment, changes) !== null);
  return (
    <section
      className="page talks ym-hide-content"
      id="talks"
      aria-busy={pending ? 'true' : undefined}
    >
      <header className="sec-h">
        <span className="lbl">обсуждение</span>
        {/* A bare counter is a number without its noun (BOOK-59) — and a count of zero is a
            claim, so while the feed lands the slot says what is happening instead. When the
            thread is settled and empty there is nothing to count, so it says so (BOOK-70). */}
        <span className="sec-meta">
          {status !== null ? (
            <span role="status" aria-live="polite" aria-atomic="true">
              {status}
            </span>
          ) : filings.length === 0 ? (
            'замечаний нет'
          ) : (
            `${filings.length} ${plural(filings.length, 'замечание', 'замечания', 'замечаний')}`
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
        <ol className="comments">
          {filings.map((comment) => {
            const line = commentStatusLine(comment);
            const quote = anchorCopy(comment);
            const kindWord = interventionKindWord(comment);
            /**
             * BOOK-137: the entry's one number and its one `прицел` — the latest attempt.
             * The number is the attempt's, so the entry never invents an order of its own;
             * with the change outside the loaded window the link still stands (the comment
             * carries `changeId`) and no number is claimed.
             */
            const attempt = filingAttempt(comment, changes);
            return (
              <li
                className={`comment tone-${line.tone}`}
                key={comment.id}
                data-status={comment.status}
                data-comment-id={comment.id}
              >
                <div className="comment-meta">
                  <span className={`comment-author ${commentInkClass(comment.author, comment.authorColor)}`}>
                    {comment.author}
                  </span>
                  <span>глава {comment.chapter}</span>
                  <span className="stamp-time">{commentStamp(comment.createdAt)}</span>
                </div>
                {quote === null ? null : <p className="comment-quote">«{quote}»</p>}
                <p className="comment-body">{comment.body}</p>
                <p className="comment-line">
                  {kindWord === null ? null : <span className="comment-kind">{kindWord} · </span>}
                  {line.state}
                  {line.detail === null ? null : <span className="comment-reason"> · {line.detail}</span>}
                </p>
                {attempt === null ? null : (
                  <p className="comment-attempt">
                    {attempt.number === null ? null : <span className="attempt-n">{attempt.number}</span>}
                    <a className="talk-open" href={focusHash(attempt.id)}>
                      прицел →
                    </a>
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
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
