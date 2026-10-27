import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { LegalPage } from './components/LegalPage.tsx';
import { bootAnalytics } from './lib/analytics.ts';
import { staticPage } from './lib/route.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/legal.css';
import './styles/consent.css';
import './styles/book.css';
import './styles/skeleton.css';
import './styles/live.css';
import './styles/cascade.css';
import './styles/ribbon.css';
import './styles/chronicle.css';
import './styles/focus.css';
import './styles/seam.css';
import './styles/panels.css';
import './styles/seam-form.css';
// BOOK-DOC-49 — the first load's gate and stagger; last, because it overrides the caret's
// height at title scale and owns every `data-seq` delay.
import './styles/first-load.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

// BOOK-63: the counter is configuration; the gate decides whether this call ever reaches
// mc.yandex.ru. It runs for the book and for the two static documents.
void bootAnalytics();

// `/privacy` and `/rules` are static documents (audit M5): chosen before the app boots, so
// they render with no catalogue request and no socket.
const page = staticPage(window.location.pathname);

createRoot(container).render(
  <StrictMode>{page === null ? <App /> : <LegalPage page={page} />}</StrictMode>,
);
