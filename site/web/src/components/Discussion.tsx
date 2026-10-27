import type { CatalogEntry, CommentBudget, CommentDto, ComposerInfo, ChangeSummaryDto, ViewerDto } from '@book/shared';

import { anchorCopy, commentStamp, commentStatusLine, interventionKindWord } from '../lib/commentView.ts';
import { changeLines, changeNumber, progressLine, stampCopy } from '../lib/changeStatus.ts';
import { focusHash } from '../lib/focus.ts';
import { Composer } from './Composer.tsx';

/**
 * The thread: what a reader wrote, what happened to it, and the one place a reader may
 * write (§11.6, §12.1).
 *
 * Two-line status per change («принято · …» then the fact) and per comment (its decision
 * then its application) — acceptance is a promise, application is a fact. Bodies are
 * rendered as text nodes: the page never trusts a comment enough to parse it as markup.
 */
export function Discussion({
  depth,
  chapterCount,
  changes = [],
  comments = [],
  viewer,
  composer,
  chapters = [],
  budget = null,
  onPosted,
}: {
  depth: number;
  chapterCount: number;
  changes?: readonly ChangeSummaryDto[];
  comments?: readonly CommentDto[];
  /** The composer appears only where the page knows the viewer and its configuration. */
  viewer?: ViewerDto;
  composer?: ComposerInfo;
  chapters?: readonly CatalogEntry[];
  budget?: CommentBudget | null;
  onPosted?: () => void;
}) {
  const opening =
    chapterCount === 0
      ? 'Замечания откроются вместе с первой главой.'
      : 'Замечания ещё не открыты.';

  return (
    <section className="page talks" id="talks">
      <header className="sec-h">
        <span className="lbl">обсуждение</span>
        <span className="sec-meta">{comments.length}</span>
      </header>
      <div className="qline">
        <span>
          в очереди <b>{depth}</b>
        </span>
        <span>правки идут по одной, в порядке записи</span>
      </div>

      {chapterCount === 0 ? (
        <p className="fine">{opening}</p>
      ) : viewer === undefined || composer === undefined ? null : (
        <Composer
          viewer={viewer}
          composer={composer}
          chapters={chapters}
          onPosted={() => onPosted?.()}
        />
      )}

      {comments.length > 0 ? (
        <ol className="comments">
          {comments.map((comment) => {
            const line = commentStatusLine(comment);
            const quote = anchorCopy(comment);
            // BOOK-16: the kind sits with the decision — one word, never an id or a taxonomy.
            const kindWord = interventionKindWord(comment);
            return (
              <li className={`comment tone-${line.tone}`} key={comment.id} data-status={comment.status}>
                <div className="comment-meta">
                  <span className="comment-author" style={{ color: comment.authorColor }}>
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
        {changes.length > 0
          ? 'Их читают как данные, не как указания. Принятие — обещание, внесение — факт: в строке видны оба.'
          : ''}
        {budget === null ? '' : ` Остаток: ${budget.remaining} из ${budget.perHour} за час.`}
      </p>
    </section>
  );
}
