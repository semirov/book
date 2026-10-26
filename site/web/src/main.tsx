import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { LegalPage } from './components/LegalPage.tsx';
import { staticPage } from './lib/route.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/book.css';
import './styles/live.css';
import './styles/cascade.css';
import './styles/chronicle.css';
import './styles/focus.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

// `/privacy` and `/rules` are static documents (audit M5): chosen before the app boots, so
// they render with no catalogue request and no socket.
const page = staticPage(window.location.pathname);

createRoot(container).render(
  <StrictMode>{page === null ? <App /> : <LegalPage page={page} />}</StrictMode>,
);
