import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { LegalPage } from './components/LegalPage.tsx';
import { Offline, isOffline } from './components/Offline.tsx';
import { bootAnalytics } from './lib/analytics.ts';
import { disarmAfterMount } from './lib/bootSignal.ts';
import { startPwa } from './lib/pwa.ts';
import { staticPage } from './lib/route.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/running-head.css';
import './styles/legal.css';
import './styles/consent.css';
import './styles/book.css';
import './styles/skeleton.css';
import './styles/live.css';
import './styles/capacity.css';
import './styles/cascade.css';
import './styles/ribbon.css';
import './styles/chronicle.css';
import './styles/focus.css';
import './styles/seam.css';
// BOOK-121 — the pass's box, its two carets and the ink gate; after the seam, before the
// panels, because the pass paints prose and never a panel.
import './styles/pass-live.css';
// BOOK-167 — the pass strip: a block in the seam's place, after the pass's own ink.
import './styles/pass-strip.css';
// BOOK-166 — the pass record: a page framed like the colophon, after the surfaces it sits beside.
import './styles/pass-record.css';
import './styles/panels.css';
import './styles/seam-form.css';
import './styles/marginalia.css';
// BOOK-156 — the grip's band, its reserve and its veil; after the registers it sits over.
import './styles/foot-jumps.css';
// BOOK-DOC-49 — the first load's gate and stagger; last, because it overrides the caret's
// height at title scale and owns every `data-seq` delay.
import './styles/first-load.css';

declare global {
  interface Window {
    /**
     * BOOK-119 — the inline boot guard in `index.html`. Absent when the shell is older than
     * the guard or the CSP refused its hash; then nothing is waiting to be disarmed.
     */
    __bootGuard?: { ok: () => void };
  }
}

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

// BOOK-63: the counter is configuration; the gate decides whether this call ever reaches
// mc.yandex.ru. It runs for the book and for the two static documents.
void bootAnalytics();

// `/privacy` and `/rules` are static documents (audit M5): chosen before the app boots, so
// they render with no catalogue request and no socket.
// BOOK-88/BOOK-91 — the one canvas: it is the column plus its two gutters, and states the
// centring and the gutters; every register inside it is the text column (base.css `.canvas` /
// `.page`). The no-JS fallback cannot use it — it lives in `index.html` — so `.noscript` states
// its own.
const page = staticPage(window.location.pathname);

// BOOK-157: an offline document (the shell's constant, `data-offline="1"`) or a browser that
// knows it is offline renders one written sentence instead of a catalogue request that cannot
// succeed. Decided before anything mounts, so no panel and no wait is painted first — and it
// outranks the two static documents too: `/privacy` and `/rules` are served files, and with no
// network neither of them can be read either.
const offline = isOffline();

createRoot(container).render(
  <StrictMode>
    <div className="canvas">{offline ? <Offline /> : page === null ? <App /> : <LegalPage page={page} />}</div>
  </StrictMode>,
);

// BOOK-119: the guard is disarmed by a fact, not by the call above — `render` only *schedules*
// work, so disarming in this tick would remove the listeners and the five-second timer while
// `#root` is still empty, and a render that never commits would be a blank page. Optional on
// purpose: a shell served before the guard existed has no `__bootGuard`, and that must not throw.
disarmAfterMount({ container, guard: () => window.__bootGuard?.ok() });
// BOOK-157: the offline shell registers on `load` or the first interaction, never before and
// never awaited — a registration must not delay or arm anything the reader is looking at.
startPwa();
