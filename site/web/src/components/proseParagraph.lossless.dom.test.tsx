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
 * parted, and closed again.
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
      />,
    );
  });
}

describe.each([390, 1440])('the paragraph keeps every character at %ipx', (width) => {
  it('reads the same closed, parted and closed again', async () => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    await render();

    const closed = document.querySelector('.p');
    expect(closed).not.toBeNull();
    expect(proseText(closed)).toBe(TEXT);

    // Part the paragraph inside its fourth sentence, so both fragments hold gaps and spans.
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

    const parted = document.querySelector('.p-parted');
    expect(parted).not.toBeNull();
    // Two fragments and the strip between them: the seam really is open.
    expect(parted?.querySelector('.seam')).not.toBeNull();
    expect(proseText(parted)).toBe(TEXT);

    // Every sentence span still holds exactly the slice its `data-s` names, so a caret inside
    // it maps back to the right block offset (`wordOffsetIn`).
    const spans = [...(parted?.querySelectorAll<HTMLElement>('[data-s]') ?? [])];
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
    expect(document.querySelector('.p-parted')).toBeNull();
    expect(proseText(again)).toBe(TEXT);
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

    const parted = document.querySelector('.p-parted');
    expect(parted).not.toBeNull();
    expect(document.querySelector('.p:not(.p-parted)')).toBeNull();
    // The tap resolved the third sentence, not the first: the strip names its first word.
    expect(document.querySelector('.seam')?.getAttribute('data-block')).toBe(BLOCK_ID);
    expect(document.querySelector('.seam-word')?.textContent).toBe('«Он»');
    // And the parted paragraph still holds every character of the text.
    expect(proseText(parted)).toBe(TEXT);
  });
});
