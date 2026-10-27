// @vitest-environment jsdom
import type { CatalogEntry } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { PREMISE_HINT } from '../lib/premise.ts';
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
  writtenAt: null,
  updatedAt: null,
  direction: 'forward',
};

class IdleObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

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

  it('prints the explanation sentence exactly once with the strip open', async () => {
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
    // Closed: the row carries it, the strip does not exist.
    expect(count()).toBe(1);
    const row = container.querySelector<HTMLElement>('#ch-7 .premise-row');
    await act(async () => row?.click());
    // Open: the strip carries it, the row does not — never both.
    expect(container.querySelector('#ch-7 .seam')).not.toBeNull();
    expect(count()).toBe(1);
  });

  it('keeps one sentence when another chapter’s strip is open and the first row is closed', async () => {
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
    // The first row still carries the page's one sentence; the other chapter's strip is silent.
    expect(count()).toBe(1);
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

  it('names the slot’s own word in the row and keeps the leader in an empty field', async () => {
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
    expect(row?.textContent).toContain('07');
    expect(row?.textContent).toContain('Перевод смены');
    expect(row?.querySelector('.premise-leader')).not.toBeNull();
  });
});
