// @vitest-environment jsdom
import type { CatalogEntry } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-68 — opening the seam must not edit the paragraph.
 *
 * The paragraph used to be re-assembled from `sentence.text` with one space between the
 * sentences, so every character `splitSentences` did not claim vanished: a double space, an
 * indent, the tail after the last full stop. The parted state lost the same characters twice
 * over. This text carries all five shapes the issue names — double spaces, em dashes, a
 * closing quote between sentences, a sentence with no final period and a trailing
 * abbreviation — and the paragraph's own text is compared character for character: closed,
 * open, and closed again.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 8,
  part: 1,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 1,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const BLOCK_ID = 'ch08#68a1b2c3';
const TEXT =
  'Он вошёл в комнату.  Она была пуста, и только часы — старые, отцовские — шли. ' +
  'Он сказал: «Уходи. » Потом закрыл дверь. Дальше он молчал, и так прошло утро и т. д.  И потом тишина';

/** The paragraph's own characters: chrome (rail, numeral, strip) is not prose. */
const CHROME = ['seam', 'seam-rail', 'seam-announce', 'prov', 'filing-mark', 'caret-inline', 'revising-label'];

function proseText(host: Element | null): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (!(node instanceof Element)) return;
    if (CHROME.some((name) => node.classList.contains(name))) return;
    node.childNodes.forEach(walk);
  };
  host?.childNodes.forEach(walk);
  return out;
}

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  closeSeam();
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        frozen={false}
        comments={[]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
        history
      />,
    );
  });
}

describe.each([390, 1440])('the paragraph keeps every character at %ipx', (width) => {
  it('reads the same closed, open and closed again', async () => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    await render();

    const closed = document.querySelector('.p');
    expect(closed).not.toBeNull();
    expect(proseText(closed)).toBe(TEXT);

    // Open the seam inside its fourth sentence, so both the gaps and the spans are exercised.
    const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: TEXT.indexOf('Потом') });
    expect(anchor).not.toBeNull();
    await act(async () => {
      openSeam({
        chapter: ENTRY.n,
        blockId: BLOCK_ID,
        key: seamKey(ENTRY.n, BLOCK_ID, anchor!.sentence, ENTRY.rev),
        anchor,
        origin: document.body,
      });
    });

    // BOOK-68: one paragraph in both states — the same node, no fragment boundary.
    const open = document.querySelector('.p');
    expect(open).not.toBeNull();
    expect(open).toBe(closed);
    expect(document.querySelectorAll('p.p')).toHaveLength(1);
    expect(document.querySelector('.p-parted')).toBeNull();
    // The strip is a following sibling of the paragraph, never a descendant of it.
    const strip = document.querySelector('.seam');
    expect(strip).not.toBeNull();
    expect(strip?.parentElement).toBe(open?.parentElement);
    expect(open?.contains(strip ?? null)).toBe(false);
    expect(open?.nextElementSibling).toBe(strip);
    // The prose is untouched: every character, no strip text mixed in.
    expect(proseText(open)).toBe(TEXT);

    // Every sentence span still holds exactly the slice its `data-s` names, so a caret inside
    // it maps back to the right block offset (`wordOffsetIn`).
    const spans = [...(open?.querySelectorAll<HTMLElement>('[data-s]') ?? [])];
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      const start = Number(span.getAttribute('data-s'));
      const text = span.textContent ?? '';
      expect(text).toBe(TEXT.slice(start, start + text.length));
      expect(TEXT.slice(start, start + text.length)).toBe(span.getAttribute('data-quote'));
    }

    await act(async () => {
      closeSeam();
    });
    const again = document.querySelector('.p');
    expect(again).not.toBeNull();
    expect(again).toBe(closed);
    expect(document.querySelector('.seam')).toBeNull();
    expect(proseText(again)).toBe(TEXT);
  });
});

/**
 * BOOK-68 — the line breaking is a property of the markup, and the markup is this shape:
 * one `<p>` holding the whole run, the anchored sentence marked by an inline class only, and
 * the strip a block sibling below the paragraph.
 */
describe('the seam marks the paragraph and lays its strip after it (BOOK-68)', () => {
  it('keeps one paragraph, marks only the anchored sentence, and adds and removes the strip', async () => {
    await render();
    const before = document.querySelector('p.p');
    expect(before).not.toBeNull();
    // Closed: no seam mark and no strip.
    expect(document.querySelector('.is-anchored')).toBeNull();
    expect(document.querySelector('.seam')).toBeNull();

    const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: TEXT.indexOf('Потом') });
    await act(async () => {
      openSeam({
        chapter: ENTRY.n,
        blockId: BLOCK_ID,
        key: seamKey(ENTRY.n, BLOCK_ID, anchor!.sentence, ENTRY.rev),
        anchor,
        origin: document.body,
      });
    });

    // The paragraph element is the same node: opening restyles it, it never remounts it.
    expect(document.querySelector('p.p')).toBe(before);
    expect(document.querySelectorAll('p.p')).toHaveLength(1);
    // Exactly the anchor sentence wears the marker, and the marker is a class, not a box.
    const marked = [...document.querySelectorAll<HTMLElement>('.p .is-anchored')];
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute('data-s')).toBe(String(anchor!.sentence.start));
    expect(marked[0]?.textContent).toBe(anchor!.sentence.text);
    // The strip follows the paragraph; it is not inside it.
    const strip = document.querySelector('.seam');
    expect(strip).not.toBeNull();
    expect(before?.nextElementSibling).toBe(strip);
    expect(before?.contains(strip ?? null)).toBe(false);

    await act(async () => {
      closeSeam();
    });
    expect(document.querySelector('.seam')).toBeNull();
    expect(document.querySelector('.is-anchored')).toBeNull();
    expect(document.querySelector('p.p')).toBe(before);
    expect(proseText(before)).toBe(TEXT);
  });
});

describe('a tap on a sentence (BOOK-68)', () => {
  it('opens the seam on the sentence it landed in and still leaves the paragraph whole', async () => {
    await render();
    const span = [...document.querySelectorAll<HTMLElement>('.p [data-s]')][2];
    expect(span).toBeDefined();
    expect(span?.getAttribute('data-quote')).toBe('Он сказал: «Уходи.');

    await act(async () => {
      span?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });

    const paragraph = document.querySelector('p.p');
    expect(paragraph).not.toBeNull();
    expect(document.querySelector('.p-parted')).toBeNull();
    // The tap resolved the third sentence, not the first: the strip names its first word.
    expect(document.querySelector('.seam')?.getAttribute('data-block')).toBe(BLOCK_ID);
    expect(document.querySelector('.seam-word')?.textContent).toBe('«Он»');
    // The tapped sentence is the marked one, and the paragraph still holds every character.
    expect(paragraph?.querySelector('.is-anchored')).toBe(span);
    expect(proseText(paragraph)).toBe(TEXT);
  });
});
