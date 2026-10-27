import { commentInkClass, type ChangeSummaryDto, type CommentDto } from '@book/shared';

import { anchorCopy, commentStamp, commentStatusLine, interventionKindWord } from '../lib/commentView.ts';
import { changeLines, changeNumber, progressLine, stampCopy } from '../lib/changeStatus.ts';
import { focusHash } from '../lib/focus.ts';
import { plural } from '../lib/format.ts';

/**
 * The register (BOOK-DOC-34 §8): what a reader wrote and what became of it.
 *
 * The composer is gone — the form lives in the text, at the point it is about. What stays is
 * the record: the queue line, every filing with its decision then its application, and the one
 * teaching line that tells a reader how the text itself works. Bodies are text nodes: the page
 * never trusts a comment enough to parse it as markup.
 */
export function Discussion({
  depth,
  changes = [],
  comments = [],
}: {
  depth: number;
  changes?: readonly ChangeSummaryDto[];
  comments?: readonly CommentDto[];
}) {
  return (
    <section className="page talks" id="talks">
      <header className="sec-h">
        <span className="lbl">обсуждение</span>
        {/* A bare counter is a number without its noun (BOOK-59). */}
        <span className="sec-meta">
          {comments.length} {plural(comments.length, 'замечание', 'замечания', 'замечаний')}
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

      {comments.length > 0 ? (
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
