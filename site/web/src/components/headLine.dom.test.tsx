// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClientState } from '../lib/clientState.ts';
import { apply, resetSeq } from '../lib/framesFixtures.ts';
import { LINGER_MS } from '../lib/nowState.ts';
import {
  applied,
  accepted,
  base,
  CATALOG,
  page,
  queued,
  reading,
  stage,
  STATE,
  T,
} from './headLineFixtures.ts';
import { Header } from './Header.tsx';
import { firstDeclarations } from './cssRules.ts';

/**
 * BOOK-DOC-84 §11.1 — the head's status line, mounted in the real head.
 *
 * What is asserted here is the DOM contract: the line is its own block under the running head
 * (not a node in `.top-row`, not a badge), it is one real `<a>` to the place it names (or no
 * link at all), it rests four seconds after an ending and then the node is gone, the author's
 * line exists only for the author, and no rendered word is machinery. The running head keeps
 * its three facts — brand, chapter number + title, page number — in both states, and the
 * phone's width queries no longer hide them. The **pixel** checks — the row and line boxes not
 * intersecting, the head growing by the line, `--offset-top` following it, one row at 390 /
 * one at 1440 — need a layout engine and live in `scripts/head-cdp.mjs`; jsdom has none, so the
 * flow guarantee is asserted as the style that puts the line in it (`position: static` inside
 * `.top-in`, after `.top-row`).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(client: ClientState, options: { nowMs?: number | null } = {}): Promise<void> {
  await act(async () => {
    root?.render(
      <Header
        state={STATE}
        ribbon={null}
        catalog={CATALOG}
        markers={[]}
        onOpenChange={() => undefined}
        live
        client={client}
        {...(options.nowMs === null ? {} : { nowMs: options.nowMs ?? T })}
        reading={{ n: 1, page: 1 }}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** The line's own text, with the separators' no-break space read as a space. */
function text(): string | null {
  const node = container.querySelector('.head-line');
  if (node === null) return null;
  return (node.textContent ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** The running head's three facts, as the DOM prints them. */
function runningHead(): { brand: string | null; chapterN: string | null; chapterW: string | null; page: string | null } {
  return {
    brand: container.querySelector('.brand')?.textContent ?? null,
    chapterN: container.querySelector('.top-chapter-n')?.textContent ?? null,
    chapterW: container.querySelector('.top-chapter-w')?.textContent ?? null,
    page: container.querySelector('.folio')?.textContent ?? null,
  };
}

const RUNNING_HEAD = { brand: 'Бланк', chapterN: '1', chapterW: 'Ночная смена', page: '1' };

beforeEach(async () => {
  resetSeq();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  await mount(page());
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('§11.1 — idle is no node at all', () => {
  it('renders no status word and no line node: the head is one row', async () => {
    await mount(page());
    expect(container.querySelector('.head-line')).toBeNull();
    // The row is still one row, the brand and the folio as before; no placeholder, no word.
    expect(container.querySelectorAll('.top-row')).toHaveLength(1);
    expect(text()).toBeNull();
    // The vocabulary keeps `idle` as an internal kind with no rendered word: «тихо» is nowhere.
    expect(container.textContent).not.toContain('тихо');
    // The line is in the head's flow, so the head's height includes it when it exists (the
    // pixel proof of the growth is the CDP harness).
    const css = sheets['../styles/head-status.css'] ?? '';
    const line = firstDeclarations(css, '.head-line');
    expect(line).toContain('position: static');
    expect(line).not.toContain('position: absolute');
    expect(line).not.toContain('top: 100%');
    // The head is a block formatting context, so the line is a block *under* the row.
    expect(firstDeclarations(sheets['../styles/chrome.css'] ?? '', '.top-in')).toContain('display: block');
    // The three facts of the running head are all there in idle.
    expect(runningHead()).toEqual(RUNNING_HEAD);
  });

  it('keeps the chapter number and title on the phone, by the sheets', () => {
    // Owner, 2026-10-29: the head reads brand, chapter number + title, page number at 390 as
    // well. A width query may not hide the cluster or its title.
    const running = sheets['../styles/running-head.css'] ?? '';
    const live = sheets['../styles/live.css'] ?? '';
    expect(running).not.toMatch(/\.top-chapter-w\s*\{[^}]*display:\s*none/u);
    expect(live).not.toMatch(/\.top-chapter\s*\{[^}]*display:\s*none/u);
  });
});

describe('§11.1 — the line is a block in the head’s flow, under the running head', () => {
  it('follows the row as a sibling, keeps the three facts, and is not in the row', async () => {
    const client = apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state;
    await mount(client);
    const row = container.querySelector('.top-row');
    const line = container.querySelector('.head-line');
    expect(row).not.toBeNull();
    expect(line).not.toBeNull();
    if (row === null || line === null) return;
    // The line is the row's next sibling inside `.top-in`, not a node in the row: in block flow
    // it can only sit below, and the head's measured height includes it.
    expect(row.contains(line)).toBe(false);
    expect(line.parentElement).toBe(row.parentElement);
    expect(row.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(runningHead()).toEqual(RUNNING_HEAD);
  });
});

describe('§11.1 — the line, per state', () => {
  it('reads the filing with its try and the frame’s clock, as one link to its record', async () => {
    const client = apply(base(), 'filing:reading', reading()).state;
    await mount(client);
    expect(text()).toBe('машина читает правку 012 · попытка 1 из 5 · 17:04');
    const door = container.querySelector<HTMLAnchorElement>('.head-line a');
    expect(door).not.toBeNull();
    expect(door?.getAttribute('href')).toBe('#ch-4');
    expect(door?.textContent).toContain('машина читает правку 012');
    // The whole line is the door: the `<a>` carries every part of the state.
    expect(door?.querySelectorAll('.head-line-part').length).toBe(3);
  });

  it('waits with the queue’s place, and the door is still the filing', async () => {
    const client = apply(page(), 'change:queued', queued).state;
    await mount(client);
    expect(text()).toBe('правка 012 ждёт: впереди 2 · 16:59');
    expect(container.querySelector('.head-line a')?.getAttribute('href')).toBe('#ch-4');
  });

  it('writes a chapter, to the chapter’s own fragment', async () => {
    const client = apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state;
    await mount(client);
    expect(text()).toBe('машина пишет главу 1 · правка 012 · попытка 1 из 5 · 17:04');
    expect(container.querySelector('.head-line a')?.getAttribute('href')).toBe('#ch-1');
  });

  it('checks with the gate and its round', async () => {
    const at = Date.parse('2026-10-29T14:08:00Z');
    const client = apply(
      apply(base(), 'pass:accepted', accepted).state,
      'pass:stage',
      stage('verdict', { at, gate: 'editor', round: 1, stageSeq: 2 }),
    ).state;
    await mount(client, { nowMs: at });
    expect(text()).toBe('машина проверяет главу 1 · правка 012 · редактор, раунд 1 · 17:08');
  });

  it('fixes by a remark with the frame’s own iteration', async () => {
    const at = Date.parse('2026-10-29T14:09:00Z');
    const client = apply(
      apply(base(), 'pass:accepted', accepted).state,
      'pass:stage',
      stage('revising', { at, iteration: 2, maxIterations: 5, stageSeq: 2 }),
    ).state;
    await mount(client, { nowMs: at });
    expect(text()).toBe('машина правит по замечанию · правка 012 · поправка 2 из 5 · 17:09');
  });

  it('announces the write with its edition', async () => {
    const client = apply(page(), 'chapter:applied', applied).state;
    await mount(client, { nowMs: applied.appliedAt });
    expect(text()).toBe('внесено · глава 1, редакция 13 · 17:12');
    expect(container.querySelector('.head-line a')?.getAttribute('href')).toBe('#ch-1');
  });
});

describe('§11.1 — the ending rests four seconds, then the node is gone', () => {
  it('keeps the line for 4 s after a terminal frame and removes it without a transition', async () => {
    const client = apply(page(), 'chapter:applied', applied).state;
    await mount(client, { nowMs: applied.appliedAt + 3_999 });
    expect(container.querySelector('.head-line')).not.toBeNull();
    await act(async () => {
      root?.render(
        <Header
          state={STATE}
          ribbon={null}
          catalog={CATALOG}
          markers={[]}
          onOpenChange={() => undefined}
          live
          client={client}
          nowMs={applied.appliedAt + LINGER_MS}
          reading={{ n: 1, page: 1 }}
        />,
      );
    });
    expect(container.querySelector('.head-line')).toBeNull();
    const css = sheets['../styles/head-status.css'] ?? '';
    expect(firstDeclarations(css, '.head-line')).toContain('transition: none');
  });
});

describe('§11.1 — the author’s own line', () => {
  it('is printed for an author and for nobody else', async () => {
    const client = apply(base(), 'filing:reading', reading()).state;
    await mount(client);
    expect(container.querySelector('.head-line-author')).toBeNull();

    const author: ClientState = { ...client, viewer: { signedIn: true, displayName: 'Аня', isAuthor: true } };
    await mount(author);
    // No place in the queue is «следом», never «впереди 0»: a count of nothing is not a count.
    // The leading separator belongs to the phone's row (jsdom paints no sheet, so it is read
    // here); above 767 the author's line is a row of its own and `head-status.css` hides it.
    const authorText = (container.querySelector('.head-line-author')?.textContent ?? '')
      .replace(/\u00a0/gu, ' ')
      .replace(/^\s*·\s*/u, '');
    // §11.1/BOOK-220 — the price is the author's line and only the author's: the reader's head
    // above printed no money at all, and this one prints the shared money word.
    expect(authorText).toBe('следом · 0,05 $');
    expect(authorText).toContain('0,05 $');
    // The author's line is not the door: the link is the state alone.
    expect(container.querySelector('.head-line a')?.textContent).not.toContain('0,05');
  });

  it('never prices anything in a reader’s head', async () => {
    // Every reader state the head prints: none of them may carry a price, in any currency.
    const states: ClientState[] = [
      apply(base(), 'filing:reading', reading()).state,
      apply(page(), 'change:queued', queued).state,
      apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state,
      apply(page(), 'chapter:applied', applied).state,
    ];
    for (const client of states) {
      expect(client.viewer.isAuthor).not.toBe(true);
      await mount(client, { nowMs: T });
      const shown = text() ?? '';
      expect(shown.length).toBeGreaterThan(0);
      expect(shown, 'a reader’s head must not price anything').not.toMatch(/[$₽]|USD/u);
      expect(container.querySelector('.head-line-author')).toBeNull();
    }
  });
});

describe('§11.1 — the head prints no machinery', () => {
  it('carries no machine noun and no slash counter, in any state', async () => {
    const MACHINE_NOUNS = ['модель', 'LLM', 'триаж', 'вердикт', 'гейт', 'итерация', 'сокет', 'лейн', 'очередь'];
    const states: ClientState[] = [
      apply(base(), 'filing:reading', reading()).state,
      apply(page(), 'change:queued', queued).state,
      apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state,
      apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('verdict', { gate: 'consultant', round: 2 })).state,
      apply(page(), 'chapter:applied', applied).state,
    ];
    for (const client of states) {
      await mount(client, { nowMs: T });
      const shown = text() ?? '';
      expect(shown.length).toBeGreaterThan(0);
      for (const noun of MACHINE_NOUNS) expect(shown.toLowerCase()).not.toContain(noun.toLowerCase());
      expect(/\d\s*\/\s*\d/u.test(shown)).toBe(false);
    }
  });
});
