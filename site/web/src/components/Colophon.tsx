import { TOTAL_CHAPTERS, type FrontDto, type StateSnapshot, type ViewerDto } from '@book/shared';
import { useState } from 'react';

import { useCounterConfigured } from '../lib/analytics.ts';
import { AGE_WORDS } from '../lib/marginalia.ts';
import { BUILD, composeBuildStamp, type BuildId } from '../lib/buildStamp.ts';
import { resetConsent, useConsent } from '../lib/consent.ts';
import { formatNumber, plural } from '../lib/format.ts';
import { applyTheme, currentTheme, type Theme } from '../lib/theme.ts';
import { ExportLink } from './ExportLink.tsx';
import { LogoutRow } from './LogoutRow.tsx';
import { MarginTail } from './MarginTail.tsx';
import { PushToggle } from './PushToggle.tsx';

/**
 * The motto after the imprint's dash: presentation only, so it lives here and not in `shared`.
 * `IMPRINT_COPYRIGHT` stays the rights statement — it travels into file exports and
 * `imprintProblems()` validates it exactly — while this sentence is read by the page and
 * nothing else. One copy, one print (BOOK-94).
 */
export const COLOPHON_MOTTO = 'С любовью к научной фантастике и современным технологиям';

/**
 * The imprint line (`imprint.copyright`) lives here: the cover no longer carries «©»
 * (BOOK-DOC-5 §2), and the end matter stopped carrying it too (BOOK-137) — the page prints the
 * rights statement exactly once, in this footer.
 *
 * BOOK-59 removed the ticking clock and today's date: a clock changes while the reader reads
 * and dates nothing, and «издание · сегодня» claims an edition date the imprint does not have
 * (it is author and copyright only). What stays dates itself — «печатается по ходу письма».
 *
 * BOOK-137 — **one row per fact**: the imprint sentence and the motto; the two static pages
 * with the source link; the theme switch. Before this the three sat in one row and crammed at
 * 390 px (the owner: «странно»), six facts on one line.
 *
 * The footer is read in this order by a reader: the counts, the way out (BOOK-115), whether the
 * reader hears about their own filings (BOOK-189), the imprint, how to support the book (BOOK-126),
 * the build the page is (BOOK-109), and the book's outlay last (BOOK-114) — the page states what
 * it cost after it has said what it is, which copy of it the reader holds and how to help.
 * `cost === null` prints no row at all: before the first successful read the total is unknown, and
 * an unknown total is not a zero.
 */
export function Colophon({
  state,
  imprint,
  build = BUILD,
  viewer = { signedIn: false, displayName: null },
  donateUrl = null,
  exportBytes = null,
  gated = false,
  reload,
}: {
  state: StateSnapshot;
  imprint: FrontDto['imprint'];
  /**
   * BOOK-109: the build this page is. The default is what `vite.config.ts` baked in; a test
   * passes its own, so the text can be pinned without a build.
   */
  build?: BuildId;
  viewer?: ViewerDto;
  /**
   * BOOK-126: the gift link, already validated at boot (`donateUrlOf`). `null` prints no row —
   * a deployment that does not ask for gifts says nothing about money at all.
   */
  donateUrl?: string | null;
  /**
   * BOOK-138: the size of the export, from the same `/api/front` payload the end matter gets.
   * The row is printed even without it — a begun book already has a file — and the link then
   * states the verb alone.
   */
  exportBytes?: number | null;
  /**
   * BOOK-225 — while the gate stands, the footer still prints (the book is discoverable), but
   * its download row does not: the file is the whole book, the route refuses it without the
   * acknowledgement, and a visible link that can only answer `403` is a lie.
   */
  gated?: boolean;
  /** Test seam only — jsdom cannot navigate; the page reloads into a guest session. */
  reload?: (url: string) => void;
}) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const consent = useConsent();
  const analyticsConfigured = useCounterConfigured();

  const toggle = (): void => {
    const next: Theme = theme === 'night' ? 'day' : 'night';
    applyTheme(next);
    setTheme(next);
  };

  return (
    <>
      <footer className="page sheet colophon" id="colo">
        <div className="row">
          {/* BOOK-70: a count of nothing is a sentence, not a chip. */}
          <span>
            {state.chapters.count === 0
              ? 'книга · глав ещё нет'
              : `книга · ${state.chapters.count} ${plural(state.chapters.count, 'глава', 'главы', 'глав')} из ${TOTAL_CHAPTERS}`}
          </span>
        </div>
        <div className="row row-print">
          <span>печатается по ходу письма</span>
          <span className="mono">{formatNumber(state.chapters.totalChars)} зн.</span>
        </div>
        {/* BOOK-225 — the rating, a fact of the book in its own row: what is inside, said once,
            in the same quiet mark as the imprint. It is not a badge, not a colour and not a
            warning about the reader; the words live in `AGE_WORDS` (BOOK-218) so they cannot drift from the
            gate and `/rules`. */}
        <div className="row">
          <span className="age-line">{AGE_WORDS.colophon}</span>
        </div>
        {analyticsConfigured ? (
          // BOOK-63: the quiet place to change the choice later; «изменить» returns the reader
          // to the undecided state, and the strip asks again. BOOK-77 (F2): a live counter stops
          // on the spot (cookies cleared, one reload), so the click is a real withdrawal.
          <div className="row">
            <span className="analytics-line">
              аналитика: {consent === 'granted' ? 'включена' : 'выключена'} ·{' '}
              <button type="button" className="analytics-change" onClick={resetConsent}>
                изменить
              </button>
            </span>
          </div>
        ) : null}
        <LogoutRow viewer={viewer} reload={reload} />
        {/* BOOK-189: the reader's own notifications, straight after the way out — the second
            question about this session. The row draws itself only where push can work, so a
            deployment without push, a browser without the objects and a signed-out reader all
            print nothing here. */}
        <PushToggle viewer={viewer} />
        {/* BOOK-117: the money bound is a fact of this register, not a notice. The server
            composes the one line from the `pass_spend` ledger and this row prints it verbatim —
            nothing added, nothing rephrased, so a pause or a stop is visible without a click.
            `ok` (and a snapshot that predates the field) prints nothing here, which keeps the
            markup of an unbound book exactly as it was. */}
        {state.budget !== undefined && state.budget.state !== 'ok' ? (
          <div
            className="row"
            role="note"
            data-budget-state={state.budget.state}
            aria-label={state.budget.line}
          >
            <span className="mono">{state.budget.line}</span>
          </div>
        ) : null}
        <div className="row">
          <span className="imprint-line">
            {imprint.copyright} — {COLOPHON_MOTTO}
          </span>
        </div>
        {/* BOOK-138: the file, in the footer's own register, straight after the imprint and
            before the gift: a reader who came to take the book away finds it without
            scrolling to the end matter, and a reader who stayed meets it where the page says
            what it is. One row, one anchor, no counter and no script.
            BOOK-225: while the gate stands the file is refused by the server, so the row is
            not there — a way out that can only answer `403` is not a way out. */}
        {gated ? null : (
          <div className="row">
            <ExportLink exportBytes={exportBytes} />
          </div>
        )}
        {/* BOOK-126: the gift row — one outbound link and nothing else. A gift between
            individuals, not a payment and not a payment platform: no script, no iframe, no
            widget, no pixel, so the reader stays unknown to us and the CSP is untouched. It
            prints only a value validated at boot; with none, the row does not exist. */}
        {donateUrl === null ? null : (
          <div className="row">
            <a className="donate" href={donateUrl} target="_blank" rel="noopener noreferrer">
              поддержать книгу →
            </a>
          </div>
        )}
        {/* BOOK-137 — one row per fact: the two static pages and the source link are their own
            row, so the imprint sentence stays one sentence and nothing is crammed beside it. */}
        <div className="row">
          <span className="legal-line">
            <a href="/privacy">приватность</a> · <a href="/rules">правила</a>
          </span>
          {/* BOOK-78: the one link to the source, quiet, beside the licence line. It says what
              is true — the site's code is open, not the novel — and it is a sibling of the
              sentence, not a part of it: BOOK-94 pins that sentence character for character.
              No badge, no count, no tracking. */}
          <a href="https://github.com/semirov/book" target="_blank" rel="noopener noreferrer">
            исходный код сайта открыт
          </a>
        </div>
        {/* BOOK-137 — the theme is a fact of its own row: the switch is not a footnote. */}
        <div className="row">
          <button
            className="theme"
            type="button"
            onClick={toggle}
            aria-pressed={theme === 'night'}
            aria-label={theme === 'night' ? 'включить дневной бланк' : 'включить ночную смену'}
          >
            <span className="switch" aria-hidden="true" />
            {theme === 'night' ? 'дневной бланк' : 'ночная смена'}
          </button>
        </div>
        {/* BOOK-109: which build the reader is holding. A row of its own after the imprint
            line, in the micro rung — the one fact that tells two hosts (and a stale cache)
            apart, printed quietly and never as a claim about the text. */}
        <div className="row">
          <span className="build-stamp">{composeBuildStamp(build)}</span>
        </div>
      </footer>
      {/* BOOK-90 §1.10: the margin's tail lives after the colophon — below everything. */}
      <MarginTail />
    </>
  );
}
