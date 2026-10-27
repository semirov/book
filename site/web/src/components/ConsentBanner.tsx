import { useCounterConfigured } from '../lib/analytics.ts';
import { CONSENT_COPY, setConsent, useConsent } from '../lib/consent.ts';

/**
 * BOOK-63 — the consent strip.
 *
 * It is book matter, not a marketing modal: a page in the reading column, no scrim, no
 * animation, no fixed layer over the text, and it wraps at 390 px. It is shown while the
 * choice is `unset` and **only when the deployment has a counter** — with no counter there
 * is nothing to consent to and the page loads nothing.
 *
 * BOOK-88: `.consent-body` is the notice's prose block — the copy and the two hairlines sit on
 * the page's prose measure, flush left, and the three actions share one mono action register.
 *
 * The copy is the legal researcher's line verbatim (comment #3619): what leaves the page,
 * and the one thing that never does. There is no pre-checked state and no «продолжая
 * пользоваться»: the script starts on «Разрешить», not on the first page view.
 */
export function ConsentBanner() {
  const state = useConsent();
  const configured = useCounterConfigured();
  if (state !== 'unset' || !configured) return null;

  return (
    <section className="page consent" aria-label="аналитика" data-consent="ask">
      <div className="consent-body">
        <p className="consent-copy">{CONSENT_COPY}</p>
        <div className="consent-actions">
          <button type="button" className="consent-choice" onClick={() => setConsent('granted')}>
            Разрешить
          </button>
          <button type="button" className="consent-choice" onClick={() => setConsent('denied')}>
            Только необходимое
          </button>
          <a className="consent-link" href="/privacy">
            приватность →
          </a>
        </div>
      </div>
    </section>
  );
}
