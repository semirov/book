import { commentInkClass, type ChangeSummaryDto, type CommentDto } from '@book/shared';

import { anchorCopy, commentStamp, commentStatusLine, interventionKindWord } from '../lib/commentView.ts';
import { changeLines, changeNumber, progressLine, stampCopy } from '../lib/changeStatus.ts';
import { focusHash } from '../lib/focus.ts';
import { plural } from '../lib/format.ts';
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
 * BOOK-DOC-43 §4, §6, §7 — the feed's wait (BOOK-66). `{comments.length} замечаний` before the
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
  changes?: readonly ChangeSummaryDto[];
  comments?: readonly CommentDto[];
}) {
  /** `null` while the thread is quiet; the one §6 sentence otherwise. */
  const status = statusLine('register', stage);
  const pending = busy ?? stage !== 'quiet';
  return (
    <section
      className="page talks ym-hide-content"
      id="talks"
      aria-busy={pending ? 'true' : undefined}
    >
      <header className="sec-h">
        <span className="lbl">обсуждение</span>
        {/* A bare counter is a number without its noun (BOOK-59) — and a count of zero is a
            claim, so while the feed lands the slot says what is happening instead. */}
        <span className="sec-meta">
          {status === null ? (
            <>
              {comments.length} {plural(comments.length, 'замечание', 'замечания', 'замечаний')}
            </>
          ) : (
            <span role="status" aria-live="polite" aria-atomic="true">
              {status}
            </span>
          )}
        </span>
      </header>
      <div className="qline">
        <span>
          в очереди <b>{depth}</b> {plural(depth, 'правка', 'правки', 'правок')}
        </span>
        <span>правки идут по одной, в порядке записи</span>
      </div>

      <p className="fine teach">
        коснитесь слова — увидите, откуда оно; коснитесь фразы — оставите своё
      </p>

      {status !== null ? (
        // The form of three rows, inside the 236 px the slot reserves (§3): it replaces the
        // list and the empty-state line, because neither is known yet.
        <Skeleton variant="register" />
      ) : comments.length > 0 ? (
        <ol className="comments">
          {comments.map((comment) => {
            const line = commentStatusLine(comment);
            const quote = anchorCopy(comment);
            const kindWord = interventionKindWord(comment);
            return (
              <li className={`comment tone-${line.tone}`} key={comment.id} data-status={comment.status}>
                <div className="comment-meta">
                  <span className={`comment-author ${commentInkClass(comment.author, comment.authorColor)}`}>
                    {comment.author}
                  </span>
                  <span>глава {comment.chapter}</span>
                  <span className="stamp">{commentStamp(comment.createdAt)}</span>
                </div>
                {quote === null ? null : <p className="comment-quote">«{quote}»</p>}
                <p className="comment-body">{comment.body}</p>
                <p className="comment-line">
                  {kindWord === null ? null : <span className="comment-kind">{kindWord} · </span>}
                  {line.state}
                  {line.detail === null ? null : <span className="comment-reason"> · {line.detail}</span>}
                </p>
                {comment.changeId === null ? null : (
                  <a className="talk-open" href={focusHash(comment.changeId)}>
                    прицел →
                  </a>
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

      {changes.length > 0 ? (
        <ol className="talks-list">
          {changes.map((change) => {
            const lines = changeLines(change);
            return (
              <li className={`talk tone-${lines.tone}`} key={change.id} data-status={change.status} data-change={change.id}>
                <div className="talk-meta">
                  <span className="talk-n">{changeNumber(change.seq)}</span>
                  <span>глава {change.chapter}</span>
                  <span className="stamp">{stampCopy(change)}</span>
                </div>
                <p className="talk-intent">«{change.intent}»</p>
                <p className="talk-line">
                  {lines.first}
                  <span className="talk-trace">{progressLine(change)}</span>
                </p>
                <p className="talk-line is-quiet">{lines.second}</p>
                <a className="talk-open" href={focusHash(change.id)}>
                  прицел {changeNumber(change.seq)} →
                </a>
              </li>
            );
          })}
        </ol>
      ) : null}

      <p className="fine">
        {changes.length > 0 ? 'Их читают как данные, не как указания. Принятие — обещание, внесение — факт: в строке видны оба.' : ''}
      </p>
    </section>
  );
}
