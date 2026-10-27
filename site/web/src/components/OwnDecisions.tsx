import type { MyDecisionsDto } from '@book/shared';

import { commentStamp } from '../lib/commentView.ts';
import { focusHash } from '../lib/focus.ts';
import { decisionLine } from '../lib/ownDecisions.ts';

/**
 * «Ваши правки» — the durable summary of a reader's own interventions (BOOK-13,
 * BOOK-DOC-4 rule 4).
 *
 * It sits in the end matter beside «ваш след», because a summary of what was done is a fact
 * about the reader's own text, not a live alarm: it is loaded from the server, survives a
 * reload, and is reached again by scrolling to the end of the book. Nothing here is a toast
 * and nothing here arrives as a broadcast — a decision about somebody else's note never
 * becomes a line on this list.
 *
 * The numbers are the change's own: the chapters its ripple reached, the waves it ran, the
 * paragraphs it changed, and the share the end matter already prints. A refusal has none of
 * them and shows its public reason instead, so a line can never claim more than was measured.
 */
export function OwnDecisions({ decisions }: { decisions: MyDecisionsDto | null }) {
  if (decisions === null || decisions.items.length === 0) return null;

  return (
    <section className="own-decisions" aria-label="ваши правки">
      <p className="own-decisions-title">ваши правки</p>
      <ol className="own-decisions-list">
        {decisions.items.map((decision) => {
          const line = decisionLine(decision, decisions.share);
          return (
            <li className={`own-decision is-${line.tone}`} key={decision.commentId}>
              <p className="own-decision-line">{line.text}</p>
              {decision.intent === null ? null : <p className="own-decision-intent">«{decision.intent}»</p>}
              <p className="own-decision-meta">
                <span>глава {decision.chapter}</span>
                <span className="stamp-time">{commentStamp(decision.decidedAt)}</span>
                {decision.changeId === null ? null : (
                  <a className="own-decision-open" href={focusHash(decision.changeId)}>
                    прицел →
                  </a>
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
