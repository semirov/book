// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { PREMISE_HINT, premiseAction, premiseFiling } from '../lib/premise.ts';
import { closeSeam } from '../lib/useSeam.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-90 A.6 — the premise strip takes layout space.
 *
 * jsdom has no layout, so the test proves the **mechanism**: in `.ch-empty` the strip is the
 * row's next sibling in the article's flow (not an absolutely positioned layer), neither the
 * article nor the strip carries a position/size that could lift it over a line, and the strip
 * mounts only after the row. The measured rect intersection is taken in Chromium from the dev
 * harness (`shots/empty-*`), where the boxes are real.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const ENTRY: CatalogEntry = {
  n: 7,
  part: 1,
  title: null,
  rev: 0,
  chars: 0,
  blocks: 0,
  written: false,
  basis: false,
  opening: null,
  writtenAt: null,
  updatedAt: null,
  direction: 'forward',
};

class IdleObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
/** BOOK-111 — the prod row of ch65: a chapter-level filing, no change, `status 'new'`. */
const PENDING: CommentDto = {
  attempt: null,
  id: 'cmt_01M5Z8HKWHPHZQDHP5MCXS5RB4',
  chapter: 7,
  anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: 'а как это работает',
  proposedText: null,
  interventionKind: null,
  premise: true,
  status: 'new',
  reason: null,
  refusal: null,
  frame: null,
  createdAt: '2026-10-27T18:04:17Z',
  decidedAt: null,
  changeId: null,
  applied: null,
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IdleObserver);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => closeSeam());
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the premise strip in an empty chapter', () => {
  it('opens after the row, inside the flow, with no absolute positioning at all', async () => {
    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={ENTRY}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          firstEmpty
          history
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: false, displayName: null }}
        />,
      );
    });

    const article = container.querySelector<HTMLElement>('article.ch-empty');
    expect(article).not.toBeNull();
    expect(article?.querySelector('.seam')).toBeNull();

    const row = article?.querySelector<HTMLElement>('.premise-row');
    expect(row).not.toBeNull();
    await act(async () => row?.click());

    const seam = article?.querySelector<HTMLElement>('.seam');
    const premise = article?.querySelector<HTMLElement>('.premise');
    expect(seam).not.toBeNull();
    // The strip follows the row in the article's flow: same parent, next element.
    expect(seam?.parentElement).toBe(article);
    expect(premise?.nextElementSibling).toBe(seam);
    // Nothing in the chain is positioned or sized out of the flow.
    for (const node of [article, seam]) {
      expect(node?.style.position).toBe('');
      expect(node?.style.top).toBe('');
      expect(node?.style.height).toBe('');
    }
    // The sheet set carries no absolute rule for the strip in an empty chapter.
    for (const [name, css] of Object.entries(sheets)) {
      expect(css, name).not.toMatch(/\.ch-empty[^{]*\.seam[^{]*\{[^}]*position:\s*(absolute|fixed)/u);
      expect(css, name).not.toMatch(/\.ch-empty\s*\{[^}]*position:\s*(absolute|fixed)/u);
    }
  });

  it('prints the explanation sentence only in the first empty chapter’s own open strip', async () => {
    const count = (): number => (document.body.textContent ?? '').split(PREMISE_HINT).length - 1;
    await act(async () => {
      root?.render(
        <>
          <ChapterArticle
            entry={ENTRY}
            revision={null}
            revising={null}
            caret={null}
            fresh={false}
            firstEmpty
            history
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: false, displayName: null }}
          />
          <ChapterArticle
            entry={{ ...ENTRY, n: 8 }}
            revision={null}
            revising={null}
            caret={null}
            fresh={false}
            history
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: false, displayName: null }}
          />
        </>,
      );
    });
    // BOOK-112: the flow row prints no explanation — a closed strip has no sentence on the page.
    expect(count()).toBe(0);
    const row = container.querySelector<HTMLElement>('#ch-7 .premise-row');
    await act(async () => row?.click());
    // Open: the first empty chapter's strip carries it, the row still does not.
    expect(container.querySelector('#ch-7 .seam')).not.toBeNull();
    expect(count()).toBe(1);
  });

  it('keeps the sentence out of another chapter’s strip while the first row is closed', async () => {
    const count = (): number => (document.body.textContent ?? '').split(PREMISE_HINT).length - 1;
    await act(async () => {
      root?.render(
        <>
          <ChapterArticle
            entry={ENTRY}
            revision={null}
            revising={null}
            caret={null}
            fresh={false}
            firstEmpty
            history
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: false, displayName: null }}
          />
          <ChapterArticle
            entry={{ ...ENTRY, n: 8 }}
            revision={null}
            revising={null}
            caret={null}
            fresh={false}
            history
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: false, displayName: null }}
          />
        </>,
      );
    });
    const other = container.querySelector<HTMLElement>('#ch-8 .premise-row');
    await act(async () => other?.click());
    expect(container.querySelector('#ch-8 .seam')).not.toBeNull();
    // The flow row carries nothing, and the other chapter's strip is silent: count 0.
    expect(count()).toBe(0);
  });

  it('prints nothing in a non-first chapter’s strip: the first row owns the sentence', async () => {
    const count = (): number => (document.body.textContent ?? '').split(PREMISE_HINT).length - 1;
    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={ENTRY}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          history
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: false, displayName: null }}
        />,
      );
    });
    expect(count()).toBe(0);
    const row = container.querySelector<HTMLElement>('.premise-row');
    await act(async () => row?.click());
    expect(container.querySelector('.seam')).not.toBeNull();
    // Only the first empty chapter's own strip may carry it; this one is not the first.
    expect(count()).toBe(0);
  });

  it('keeps one <article> across the empty → written swap (the observer’s node stays live)', async () => {
    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={ENTRY}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          history
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: false, displayName: null }}
        />,
      );
    });
    const before = container.querySelector('article.ch');
    expect(before).not.toBeNull();
    expect(before?.className).toContain('ch-empty');
    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={{ ...ENTRY, written: true, blocks: 1 }}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          history
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: false, displayName: null }}
        />,
      );
    });
    const after = container.querySelector('article.ch');
    // The same DOM node: the chapter's lazy-load observer keeps watching a live slot.
    expect(after).toBe(before);
    expect(after?.className).not.toContain('ch-empty');
  });

  it('keeps the row to its number and the leader, with no word lifted from the title', async () => {
    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={{ ...ENTRY, title: 'Перевод смены' }}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          history
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: false, displayName: null }}
        />,
      );
    });
    const row = container.querySelector('.premise-row');
    expect(row?.textContent).toBe('07');
    expect(row?.querySelector('.premise-leader')).not.toBeNull();
  });

  it('a pending chapter-level filing is the chapter’s premise', async () => {
    // BOOK-111 — the prod row: `premise: true, status: 'new'`, no change yet. The row must
    // print the reader's quote and the word «ждёт», and the tap must open THAT filing's card,
    // never the form (a second premise would be refused by the server).
    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={ENTRY}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          firstEmpty
          history={false}
          comments={[PENDING]}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
        />,
      );
    });

    const row = container.querySelector<HTMLElement>('#ch-7 .premise-row');
    expect(row?.getAttribute('data-state')).toBe('held');
    expect(row?.querySelector('.premise-quote')?.textContent).toBe('«а как это работает»');
    expect(row?.querySelector('.premise-label')?.textContent).toBe('ждёт');
    expect(premiseAction(premiseFiling([PENDING], 7)).kind).toBe('card');

    await act(async () => row?.click());

    // The card, not the form: the filing the reader already sent is the one they get.
    expect(container.querySelector('.filing-panel')).not.toBeNull();
    expect(container.querySelector('.seam-form')).toBeNull();
    expect(container.querySelector('#ch-7 .seam')).toBeNull();
  });

  it('keeps the marks on one line and the premise’s words under them', async () => {
    // BOOK-128 #3900 §1: the row is two lines — the numeral, the leader and the state word in
    // mono 12, then the premise's own «…» in serif 15. The button is still one full-width target.
    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={ENTRY}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          firstEmpty
          history={false}
          comments={[PENDING]}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
        />,
      );
    });

    const row = container.querySelector<HTMLElement>('#ch-7 .premise-row');
    expect(row).not.toBeNull();
    const cells = [...(row?.children ?? [])].map((child) => child.getAttribute('class'));
    expect(cells).toEqual(['premise-facts', 'premise-quote']);
    // The marks line keeps the word on its own line: three cells, three tracks, one line.
    const facts = row?.querySelector('.premise-facts');
    expect([...(facts?.children ?? [])].map((cell) => cell.getAttribute('class'))).toEqual([
      'premise-n',
      'premise-field premise-leader',
      'premise-label',
    ]);

    const rule = /(?:^|\n)\s*\.premise-facts\s*\{([^}]*)\}/u.exec(sheets['../styles/seam-form.css'] ?? '')?.[1] ?? '';
    const template = /grid-template-columns:\s*([^;]*)/u.exec(rule)?.[1]?.trim() ?? '';
    // Three tracks: one per cell. `minmax(0, 1fr)` is one track, not three.
    expect(template.replace(/minmax\([^)]*\)/gu, 'M').split(/\s+/u)).toHaveLength(3);
    // No template row count: the marks stay one line whatever the word's width.
    expect(rule).not.toContain('grid-template-rows');
  });

  it('opens the premise card from a duplicate refusal on an empty chapter (BOOK-111)', async () => {
    // The prod 409 on an unwritten chapter: the form says the filing exists, and its door reads
    // the row by id and opens it — the same card the premise row opens, not a second form.
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/comments/cmt_x')) {
          return new Response(JSON.stringify(PENDING), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(
          JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_x' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={ENTRY}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          history={false}
          comments={[]}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
        />,
      );
    });
    await act(async () => container.querySelector<HTMLElement>('#ch-7 .premise-row')?.click());
    // The row opens the strip; «заложить замысел» opens the form.
    await act(async () => container.querySelector<HTMLElement>('#ch-7 .seam-cta')?.click());
    expect(container.querySelector('#ch-7 .seam-form')).not.toBeNull();

    const text = container.querySelector<HTMLTextAreaElement>('#ch-7 textarea.seam-text');
    expect(text).not.toBeNull();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(text, 'А как?');
    await act(async () => text?.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => {
      container.querySelector('#ch-7 form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('#ch-7 .seam-error')?.textContent).toContain('такое замечание уже отправлено');
    const open = [...container.querySelectorAll<HTMLButtonElement>('#ch-7 button.seam-inline-action')].find(
      (button) => button.textContent?.trim() === 'открыть отправленное',
    );
    expect(open).not.toBeUndefined();
    await act(async () => {
      open?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const panel = container.querySelector('.filing-panel');
    expect(panel, 'the refusal opens the filing that already exists').not.toBeNull();
    expect(panel?.textContent).toContain('а как это работает');
    // A premise has no sentence: its filing keeps the one card, and the strip that opened it
    // goes with it — one close on screen.
    expect(container.querySelector('#ch-7 .seam')).toBeNull();
    expect(container.querySelector('#ch-7 .seam-form')).toBeNull();
    await act(async () => container.querySelector<HTMLElement>('.filing-close')?.click());
    expect(container.querySelector('.filing-panel')).toBeNull();
    // The draft was not spent (BOOK-63): the store still holds it, and the row can open it again.
    expect(container.querySelector('#ch-7 .seam')).toBeNull();
  });
});
