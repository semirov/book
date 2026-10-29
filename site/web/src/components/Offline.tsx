/**
 * BOOK-157 — the page an installed app shows when there is no network.
 *
 * The offline shell (`sw.js`) answers a navigation it cannot fetch with a document that carries
 * `data-offline="1"`; this module is what that document renders instead of the book. It is the
 * same register as the app's own failure line (`App.tsx`: «опись не прочиталась · повторить») —
 * one fact, one retry, lowercase, no book text, no counts, no product words — and it must say
 * the one thing that is true: the chapters come from the server and are not held by the app.
 *
 * No stylesheet of its own: `.page` and `.state-line` are the site's, so the sentence stands in
 * the same column, at the same size, on the same paper.
 */

import { useEffect, type ReactElement } from 'react';

/** The one fact and the one verb. Pinned by `offline.test.tsx`. */
export const OFFLINE_SENTENCE = 'сети нет — главы читаются с сервера, офлайн их нет';
export const OFFLINE_RETRY = 'повторить';

/**
 * True when this document cannot reach the book: the worker said so (`data-offline="1"`, set on
 * the document it serves from its own constant), or the browser knows it is offline.
 */
export function isOffline(doc: Document = document, online: boolean = navigator.onLine): boolean {
  return doc.documentElement.dataset.offline === '1' || online === false;
}

/**
 * BOOK-157 — **one reload when the network comes back**, which is the stale-bundle guard for the
 * crash-loop case: the document this page booted from was the worker's *own* constant, and it
 * names the release that served it. When the host returns, the reader is looking at an old
 * bundle answering a new server; one navigation is all it takes to get the deploy, and the
 * offline page has no print to interrupt. One event, once, injected so a test can fire it.
 */
export function reloadWhenOnline(
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  reload: () => void,
): () => void {
  events.addEventListener('online', reload, { once: true });
  return () => events.removeEventListener('online', reload);
}

export function Offline(): ReactElement {
  useEffect(() => reloadWhenOnline(window, () => window.location.reload()), []);
  return (
    <main className="page" data-offline-surface="1">
      <div className="state-line">
        <span>{OFFLINE_SENTENCE}</span>
        <button type="button" onClick={() => window.location.reload()}>
          {OFFLINE_RETRY}
        </button>
      </div>
    </main>
  );
}
