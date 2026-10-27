// @vitest-environment jsdom
import type { ParagraphChainDto } from '@book/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { useParagraphChain } from '../useParagraphChain.ts';
import { ParagraphChain } from './ParagraphChain.tsx';

/**
 * BOOK-68 — the chain panel is mounted on the reader's act, never on the answer.
 *
 * A 404 is an answer: the panel opens and says «у этой строки нет истории». A 5xx is not: the
 * panel says the chain was not read and offers «повторить», which reaches the server again.
 * A block the client already knows is historyless is not asked about twice.
 *
 * The harness composes the same two pieces the book and the chronicle do: the hook, and the
 * panel mounted on `active` (BOOK-66) — where the old inline expression was `loading ||
 * chain !== null` and so unmounted the popover exactly when the server said there was nothing
 * to show.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BLOCK_ID = 'ch08#68c0ffee';

const EMPTY_CHAIN: ParagraphChainDto = {
  blockUid: 'blk_68',
  blockId: BLOCK_ID,
  chapter: 8,
  alive: true,
  versions: [],
  line: 'без переписей',
};

function answer(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

function notFound(): Response {
  return answer({ code: 'NOT_FOUND', message: 'no such paragraph' }, 404);
}

function serverError(): Response {
  return answer({ code: 'INTERNAL', message: 'boom' }, 500);
}

function ChainHarness(): ReactElement {
  const mode = useParagraphChain();
  return (
    <div>
      <button type="button" className="ask" onClick={(event) => mode.open(BLOCK_ID, event.currentTarget.getBoundingClientRect())}>
        ⋯
      </button>
      <button type="button" className="shut" onClick={mode.close}>
        ✕
      </button>
      {mode.active ? (
        <ParagraphChain
          chain={mode.chain}
          loading={mode.loading}
          failed={mode.failed}
          onClose={mode.close}
          onRetry={mode.retry}
          anchor={mode.anchor}
          live
        />
      ) : null}
    </div>
  );
}

let root: Root | null = null;

beforeEach(() => {
  resetParagraphChainCache();
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  resetParagraphChainCache();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root?.render(<ChainHarness />);
  });
}

const ask = async (): Promise<void> => {
  await act(async () => {
    (document.querySelector('.ask') as HTMLElement).click();
  });
  await flush();
};

const panel = (): Element | null => document.querySelector('aside.chain');

describe('a 404 on the paragraph chain (BOOK-68)', () => {
  it('opens the panel with the honest line — no error state, no empty popover', async () => {
    const fetchMock = vi.fn().mockResolvedValue(notFound());
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(panel()).toBeNull();

    await ask();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/history/paragraphs/ch08%2368c0ffee`);
    expect(panel()).not.toBeNull();
    expect(panel()?.textContent).toContain('у этой строки нет истории');
    // A missing history is not a failure: no retry copy, no failure copy.
    expect(panel()?.textContent).not.toContain('повторить');
    expect(panel()?.textContent).not.toContain('история не прочиталась');
    expect(panel()?.textContent).not.toContain('читается');
  });

  it('asks once for a block it already knows is historyless', async () => {
    const fetchMock = vi.fn().mockResolvedValue(notFound());
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    await ask();
    await act(async () => {
      (document.querySelector('.shut') as HTMLElement).click();
    });
    expect(panel()).toBeNull();
    await ask();

    expect(panel()?.textContent).toContain('у этой строки нет истории');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks once for a chain that came back with no versions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(EMPTY_CHAIN, 200));
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    await ask();
    await act(async () => {
      (document.querySelector('.shut') as HTMLElement).click();
    });
    await ask();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a 5xx on the paragraph chain (BOOK-68)', () => {
  it('says the read failed and offers «повторить», never «нет истории»', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(serverError()).mockResolvedValueOnce(answer(EMPTY_CHAIN, 200));
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    await ask();

    expect(panel()).not.toBeNull();
    expect(panel()?.textContent).toContain('история не прочиталась');
    expect(panel()?.textContent).not.toContain('у этой строки нет истории');
    const retry = [...(panel()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'повторить');
    expect(retry).toBeDefined();

    await act(async () => {
      (retry as HTMLElement).click();
    });
    await flush();

    // The retry reissues the same request and the answer lands in the same panel.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/history/paragraphs/ch08%2368c0ffee`);
    expect(panel()?.textContent).toContain('без переписей');
    expect(panel()?.textContent).not.toContain('повторить');
  });
});
