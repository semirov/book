import { TOTAL_CHAPTERS, type FrontDto, type StateSnapshot } from '@book/shared';
import { useState } from 'react';

import { useCounterConfigured } from '../lib/analytics.ts';
import { resetConsent, useConsent } from '../lib/consent.ts';
import { formatNumber, plural } from '../lib/format.ts';
import { applyTheme, currentTheme, type Theme } from '../lib/theme.ts';
import { MarginTail } from './MarginTail.tsx';

/**
 * The motto after the imprint's dash: presentation only, so it lives here and not in `shared`.
 * `IMPRINT_COPYRIGHT` stays the rights statement — it travels into file exports and
 * `imprintProblems()` validates it exactly — while this sentence is read by the page and
 * nothing else. One copy, one print (BOOK-94).
 */
export const COLOPHON_MOTTO = 'С любовью к научной фантастике и современным технологиям';

/**
 * The imprint line (`imprint.copyright`) lives here: the cover no longer carries «©»
 * (BOOK-DOC-5 §2), and «Авторы» keeps its own copy of it.
 *
 * BOOK-59 removed the ticking clock and today's date: a clock changes while the reader reads
 * and dates nothing, and «издание · сегодня» claims an edition date the imprint does not have
 * (it is author and copyright only). What stays dates itself — «печатается по ходу письма».
 */
export function Colophon({ state, imprint }: { state: StateSnapshot; imprint: FrontDto['imprint'] }) {
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
        <div className="row">
          <span>печатается по ходу письма</span>
          <span className="mono">{formatNumber(state.chapters.totalChars)} зн.</span>
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
        <div className="row">
          <span className="imprint-line">
            {imprint.copyright} — {COLOPHON_MOTTO} · <a href="/privacy">приватность</a> ·{' '}
            <a href="/rules">правила</a>
          </span>
          {/* BOOK-78: the one link to the source, quiet, beside the licence line. It says what
              is true — the site's code is open, not the novel — and it is a sibling of the
              sentence, not a part of it: BOOK-94 pins that sentence character for character.
              No badge, no count, no tracking. */}
          <a href="https://github.com/semirov/book" target="_blank" rel="noopener noreferrer">
            исходный код сайта открыт
          </a>
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
      </footer>
      {/* BOOK-90 §1.10: the margin's tail lives after the colophon — below everything. */}
      <MarginTail />
    </>
  );
}
