// @vitest-environment jsdom
import type { CatalogEntry } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-68 — the word's `абзац` row may not claim a paragraph's history it does not have.
 *
 * The panel opened from the seam used to print «написан целиком; читательских правок в нём не
 * было» whenever the chain was still missing or had failed. Now a 404 is an answer («у этой
 * строки нет истории»), the wait says the chain is being read, and only a real DTO may count
 * rewrites. The block is also not asked about twice once its answer is known.
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

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const BLOCK_ID = 'ch08#68deed01';

function answer(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

const notFound = (): Response => answer({ code: 'NOT_FOUND', message: 'no such paragraph' }, 404);

let root: Root | null = null;

beforeEach(() => {
  resetParagraphChainCache();
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
  resetParagraphChainCache();
});

/** One act around the act and its whole promise chain: no state lands after the test leaves. */
async function actAndSettle(action: () => void): Promise<void> {
  await act(async () => {
    action();
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });
}

/** The paragraph with its seam open inside the first sentence — the strip and its panels. */
async function openParagraph(): Promise<void> {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 3 });
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
  await act(async () => {
    openSeam({ chapter: ENTRY.n, blockId: BLOCK_ID, key: seamKey(ENTRY.n, BLOCK_ID, anchor!.sentence, ENTRY.rev), anchor, origin: document.body });
  });
}

const openWord = async (): Promise<void> => {
  await actAndSettle(() => (document.querySelector('.seam-prov') as HTMLElement).click());
};

const paragraphRow = (): string | null =>
  [...document.querySelectorAll('.prov-row')]
    .find((row) => row.querySelector('dt')?.textContent === 'абзац')
    ?.querySelector('dd')?.textContent ?? null;

describe('the word panel and a missing paragraph history (BOOK-68)', () => {
  it('says the chain is being read, then that the line has no history — never a rewrite claim', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/history/paragraphs/')) return pending;
      return Promise.resolve(notFound());
    });
    vi.stubGlobal('fetch', fetchMock);
    await openParagraph();

    await openWord();
    expect(document.querySelector('.prov-panel')).not.toBeNull();
    expect(paragraphRow()).toBe('цепочка читается…');
    expect(document.querySelector('.prov-panel')?.textContent).not.toContain('написан целиком');

    await actAndSettle(() => release(notFound()));
    expect(paragraphRow()).toBe('у этой строки нет истории');
    expect(document.querySelector('.prov-panel')?.textContent).not.toContain('написан целиком');
    expect(document.querySelector('.prov-panel')?.textContent).not.toContain('читательских правок');
  });

  it('asks once when the reader reopens the panel on the same historyless block', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(notFound()));
    vi.stubGlobal('fetch', fetchMock);
    const chainCalls = (): number =>
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/history/paragraphs/')).length;
    await openParagraph();

    await openWord();
    expect(paragraphRow()).toBe('у этой строки нет истории');
    expect(chainCalls()).toBe(1);

    await actAndSettle(() => (document.querySelector('.prov-close') as HTMLElement).click());
    expect(document.querySelector('.prov-panel')).toBeNull();

    await openWord();
    expect(paragraphRow()).toBe('у этой строки нет истории');
    expect(chainCalls()).toBe(1);
  });
});
