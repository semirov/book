// @vitest-environment jsdom
/**
 * BOOK-157 — the page an installed app shows with no network.
 *
 * The offline document (`sw.js`'s constant) carries `data-offline="1"`, and `main.tsx` renders
 * this instead of the book. It is the app's own failure register — `.page`, `.state-line`,
 * lowercase, one fact and one retry — so it must print exactly that: no book text, no chapter
 * numbers, no counts, no interface explanation. The positive assertion (the sentence is there)
 * pairs with the negative ones, because a fix that prints nothing is not a fix either.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { OFFLINE_SENTENCE as WORKER_SENTENCE, offlineDocument } from '../../../scripts/lib/sw.mjs';
import { Offline, OFFLINE_RETRY, OFFLINE_SENTENCE, isOffline } from './Offline.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(): Promise<void> {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root?.render(<Offline />));
}

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.offline;
});

describe('the offline page', () => {
  it('says the book is not available offline, in the site’s own register', async () => {
    await mount();
    expect(OFFLINE_SENTENCE).toBe('сети нет — главы читаются с сервера, офлайн их нет');
    expect(container.textContent).toContain(OFFLINE_SENTENCE);
    // The same two surfaces the app's own failure line uses (App.tsx: «опись не прочиталась · повторить»).
    expect(container.querySelector('main.page')).not.toBeNull();
    expect(container.querySelector('.state-line')).not.toBeNull();
  });

  it('offers one real retry verb, as a button', async () => {
    await mount();
    const button = container.querySelector<HTMLButtonElement>('.state-line button');
    expect(button?.textContent).toBe(OFFLINE_RETRY);
    expect(button?.textContent).toBe('повторить');
    expect(button?.type).toBe('button');
    // One fact and one verb: the whole surface is those two strings.
    expect(container.textContent).toBe(`${OFFLINE_SENTENCE}${OFFLINE_RETRY}`);
  });

  it('says exactly what the worker’s offline document already says', () => {
    // Two copies by necessity — the worker cannot import the SPA, and the built `sw.js` must be
    // one plain file — so a test holds them together. The document prints the sentence itself,
    // as plain text in `#root`, because a reader whose release was evicted from the HTTP cache
    // has no `/assets/*` to boot: they must still get words, not a blank page.
    expect(WORKER_SENTENCE).toBe(OFFLINE_SENTENCE);
    const offline = offlineDocument({ js: '/assets/index-Bx12_3de.js', css: '/assets/index-Bx12_3de.css' });
    expect(offline).toContain(`<p>${OFFLINE_SENTENCE}</p>`);
    expect(offline).toContain('data-offline="1"');
    // No class dependency: the paragraph is the document's, not the stylesheet's.
    expect(offline).not.toContain('<p class=');
  });

  it('prints no book text, no chapter number, no count and no product word', async () => {
    await mount();
    const text = container.textContent ?? '';
    expect(text).not.toContain('Он вошёл в комнату');
    expect(text).not.toMatch(/\d/u); // no chapter number, no count, no progress
    for (const word of ['глава написана', 'пишется глава', 'замысел', 'книга ·', 'офлайн-режим', 'установить']) {
      expect(text, word).not.toContain(word);
    }
  });
});

describe('when the page is offline', () => {
  it('trusts the worker’s marker on the document', () => {
    document.documentElement.dataset.offline = '1';
    expect(isOffline(document, true)).toBe(true);
  });

  it('trusts the browser when it says so', () => {
    expect(isOffline(document, false)).toBe(true);
  });

  it('is online otherwise', () => {
    expect(isOffline(document, true)).toBe(false);
    document.documentElement.dataset.offline = '0';
    expect(isOffline(document, true)).toBe(false);
  });
});
