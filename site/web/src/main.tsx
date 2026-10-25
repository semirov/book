import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/book.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
