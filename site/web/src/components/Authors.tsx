import { formatShare, type AuthorsDto, type MyDecisionsDto, type MyTraceDto } from '@book/shared';

import { formatDate } from '../lib/format.ts';
import type { PendingStage } from '../lib/pending.ts';
import type { ChapterLoader } from '../lib/place.ts';
import { statusLine } from '../lib/skeleton.ts';
import { ExportLink } from './ExportLink.tsx';
import { OwnDecisions } from './OwnDecisions.tsx';
import { OwnTrace } from './OwnTrace.tsx';
import { Skeleton } from './Skeleton.tsx';

/**
 * «Авторы» — the end matter, after chapter 42 (§6C.5, §11.8).
 *
 * The author is listed first with the remainder of the text (`1 − Σ shares`), because the
 * imprint names one person and the site must not imply the book is co-authored in law. A
 * reader's share is «доля в окончательном тексте»: the characters whose *last* cause is that
 * reader's change — the only attribution the system can compute without a theory of influence,
 * and it says so on the page. The writer, the editor and the consultant are not listed: they
 * are the process, not persons (§6C.5 rule 3).
 *
 * No publisher, no ISBN, no year: the imprint is config (§6C.6) and F020 keeps it exact. The
 * rights statement itself is printed once, in the colophon (BOOK-137): this block keeps the
 * author's name and the date the text last changed, and no second «©».
 *
 * BOOK-DOC-43 §4, §6, §7 — the shares are a measurement, and a measurement has a wait
 * (BOOK-66). While it runs, the roster is the form of three rows and the meta line says
 * «доли считаются»; the sentence «пока весь текст написан автором» is printed only for a
 * measurement that came back, because it is a fact about the text, not a placeholder. A
 * failed read is silent: the author row keeps its honest «—» and there is no retry.
 */
export function Authors({
  authors,
  stage = 'quiet',
  busy,
  authorsFailed = false,
  imprint,
  lastRevisionAt,
  ownTrace = null,
  onToggleHidden,
  hidePending = false,
  decisions = null,
  live,
  exportBytes = null,
  onLoadChapter,
}: {
  authors: AuthorsDto | null;
  /** BOOK-DOC-43 §4 — quiet / skeleton / slow, from the request's settle. */
  stage?: PendingStage;
  /**
   * BOOK-DOC-43 §7 — busy for the **whole** request (data or failure), not from 150 ms.
   * Absent derives it from `stage`, so an old caller keeps the old markup.
   */
  busy?: boolean;
  /** The measurement failed: «—» stays, and no sentence claims the list is empty. */
  authorsFailed?: boolean;
  imprint: { author: string; copyright: string };
  lastRevisionAt: string | null;
  /** The signed-in reader's own trace; `null` for an anonymous visitor. */
  ownTrace?: MyTraceDto | null;
  onToggleHidden?: (hidden: boolean) => void;
  hidePending?: boolean;
  /** The signed-in reader's own decisions (BOOK-13); `null` for an anonymous visitor. */
  decisions?: MyDecisionsDto | null;
  /**
   * BOOK-56: `state.history.live`. The authors list is a history surface — with no reader
   * change there is no one to list, so the list itself is gated. The reader's own decisions
   * are not the book's past but their own present state, so they outlive the gate; with
   * neither, the section is not on the page at all.
   *
   * This block — the shares and the reader's joint series — belongs to `live`, not to the
   * chronicle: a begun book has a chronicle with one record and no authors yet. The view
   * switch at the top of the page is the only way into the chronicle; the end matter keeps
   * no second door.
   */
  live: boolean;
  /**
   * BOOK-138: the size of the file `/api/front` measured — the byte length of the body
   * `/book.fb2` sends for this edition. The download link prints it; absent on an older
   * payload, and then the link prints the verb alone.
   */
  exportBytes?: number | null;
  /** BOOK-168: the page's chapter read, so a row's place door can ask for its chapter. */
  onLoadChapter?: ChapterLoader;
}) {
  // BOOK-56: the list is the book's past; the reader's own decisions are their present state,
  // so they render on their own rather than with the list they used to sit under.
  if (!live) {
    // BOOK-60: reading is never gated, so the download is not either. A begun book has no
    // authors list, but it does have a file — the link stays with or without own decisions.
    const hasDecisions = decisions !== null && decisions.items.length > 0;
    return (
      <section className="page authors" aria-label={hasDecisions ? 'ваши правки и выгрузка книги' : 'выгрузка книги'}>
        {hasDecisions ? <OwnDecisions decisions={decisions} onLoadChapter={onLoadChapter} /> : null}
        <div className="authors-export">
          <ExportLink exportBytes={exportBytes} />
        </div>
      </section>
    );
  }
  const contributors = authors?.contributors ?? [];
  /** `null` while the shares are quiet; the one §6 sentence otherwise. */
  const status = statusLine('authors', stage);
  const pending = busy ?? stage !== 'quiet';
  /**
   * An empty roster is a claim, and it may only be made about a measurement that came back:
   * `null` is either a wait or a failure, and both keep the sentence off the page.
   */
  const settledEmpty = authors !== null && !authorsFailed && contributors.length === 0;
  return (
    // BOOK-77 (audit F1): a reader's display name is in here, so Webvisor must not record it.
    <section
      className="page authors ym-hide-content"
      id="авторы"
      aria-label="авторы"
      aria-busy={pending ? 'true' : undefined}
    >
      <h2 className="authors-title">Авторы</h2>
      <p className="authors-note">
        доля в окончательном тексте: знаки, чья последняя причина — правка читателя; автор — остальное
      </p>
      {status === null ? (
        <ol className="authors-list">
          <li className="authors-row is-author">
            <span className="authors-name">{imprint.author}</span>
            <span className="authors-role">автор</span>
            <span className="authors-share">{authors === null ? '—' : formatShare(authors.author.share)}</span>
          </li>
          {contributors.map((contributor) => (
            <li className="authors-row ym-disable-clickmap" key={contributor.identityId}>
              <span className="authors-name">{contributor.label}</span>
              <span className="authors-role">
                {contributor.edits > 0 ? `правок: ${contributor.edits}` : 'читатель'}
              </span>
              <span className="authors-share">{formatShare(contributor.share)}</span>
            </li>
          ))}
        </ol>
      ) : (
        // The form of the roster, 3 rows inside the 132 px the slot reserves (§3). The author
        // row is one of them: a real row beside the form would be a fact and a blank at once.
        // The form keeps the list's box — the `ol` carries the 18 px top margin, so the
        // content below does not move when the rows arrive; one `li` holds the hidden form.
        <ol className="authors-list">
          <li>
            <Skeleton variant="authors" />
          </li>
        </ol>
      )}
      {status === null ? (
        settledEmpty ? (
          <p className="authors-empty">пока весь текст написан автором: читательских правок в книге нет</p>
        ) : null
      ) : (
        // The status lives in the slot the sentence already owns, so it adds no height (§3).
        <p className="authors-empty">
          <span role="status" aria-live="polite" aria-atomic="true">
            {status}
          </span>
        </p>
      )}
      {ownTrace === null ? null : (
        <OwnTrace
          trace={ownTrace}
          pending={hidePending}
          {...(onToggleHidden === undefined ? {} : { onToggleHidden })}
        />
      )}
      <OwnDecisions decisions={decisions} onLoadChapter={onLoadChapter} />
      {/*
        BOOK-138 — the download keeps the end matter's own spacing (`chrome.css`,
        `.authors-export`); the link itself states no box, here or in the footer. The label
        carries the size `/api/front` measured (BOOK-138), never the edition.

        BOOK-137 — the page carries **one** ©. The imprint's copyright line lives in the
        colophon only: the end matter keeps the author names and the date of the last change,
        and printing the rights statement a second time made the footer read as two books.
      */}
      <div className="authors-export">
        <ExportLink exportBytes={exportBytes} />
      </div>
      {lastRevisionAt === null ? null : (
        <p className="authors-updated">последняя правка — {formatDate(lastRevisionAt)}</p>
      )}
    </section>
  );
}
