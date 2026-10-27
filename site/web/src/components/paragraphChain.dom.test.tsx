// @vitest-environment jsdom
import type { ParagraphChainDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { placePopover, type AnchorRect } from '../lib/popover.ts';
import { useParagraphChain } from '../useParagraphChain.ts';
import { ParagraphChain } from './ParagraphChain.tsx';

/**
 * BOOK-30 — the anchored panel's box is a live CSSOM write, not a `style` prop.
 *
 * The panel is the fourth surface that used to carry a style attribute. jsdom reports a
 * zero-sized panel, so the expected box comes from the same pure placement function.
 *
 * BOOK-DOC-43 §4, §6, §7, §10 (BOOK-66) — the chain's wait and its failure: the panel shows
 * only its head while the wait is quiet, the form of three rows after 150 ms, and a failure
 * is a sentence with a retry — never «у этой строки нет истории», which is a fact about a
 * read that came back empty.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#0b7e9c31',
  chapter: 8,
  alive: true,
  versions: [],
  line: 'переписано в 14:20 правкой 7 · было: правка 3 (Аня)',
};

const ANCHOR: AnchorRect = { top: 120, left: 10, width: 80, height: 20 };

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A 404 is the API's normal «no history» answer, not a rejection. */
function notFound(): Response {
  return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as unknown as Response;
}

describe('the paragraph chain panel under a browser', () => {
  it('writes the measured box through CSSOM and clears it without an anchor', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const render = (anchor: AnchorRect | null) => (
      <ParagraphChain
        chain={CHAIN}
        loading={false}
        failed={false}
        onClose={() => undefined}
        onRetry={() => undefined}
        anchor={anchor}
      />
    );

    await act(async () => root?.render(render(null)));
    const panel = container.querySelector<HTMLElement>('aside.chain');
    expect(panel).not.toBeNull();
    expect(panel?.style.top).toBe('');

    await act(async () => root?.render(render(ANCHOR)));
    const box = placePopover(ANCHOR, { width: 0, height: 0 }, { width: window.innerWidth, height: window.innerHeight });
    expect(panel?.style.top).toBe(`${box.top}px`);
    expect(panel?.style.left).toBe(`${box.left}px`);
    expect(panel?.style.width).toBe(`${box.width}px`);
    expect(panel?.style.maxHeight).toBe(`${box.maxHeight}px`);

    await act(async () => root?.render(render(null)));
    expect(panel?.style.top).toBe('');
    expect(panel?.style.maxHeight).toBe('');
  });
});

describe('the chain’s wait and failure (BOOK-DOC-43)', () => {
  function mount(): { container: HTMLDivElement; render: (loading: boolean) => void } {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const render = (loading: boolean): void => {
      root?.render(
        <ParagraphChain
          chain={null}
          loading={loading}
          failed={false}
          onClose={() => undefined}
          onRetry={() => undefined}
          anchor={ANCHOR}
        />,
      );
    };
    return { container, render };
  }

  it('keeps only the head while the wait is quiet, then the sentence and three rows in the chain grid', async () => {
    vi.useFakeTimers();
    const { container, render } = mount();

    await act(async () => render(true));
    const panel = container.querySelector('aside.chain');
    expect(panel?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.chr-empty')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.textContent).not.toContain('цепочка читается');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const status = container.querySelector('p.chr-empty');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(status?.textContent).toBe('цепочка читается…');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('.skel-chain')?.getAttribute('data-rows')).toBe('3');
    expect(container.querySelectorAll('.skel-chain .skel-row')).toHaveLength(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_850);
    });
    expect(container.querySelector('p.chr-empty')?.textContent).toBe(
      'цепочка идёт дольше обычного · история появится здесь же',
    );
  });

  it('prints the one new failure sentence with a retry, never the absence', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onRetry = vi.fn();

    await act(async () =>
      root?.render(
        <ParagraphChain chain={null} loading={false} failed onClose={() => undefined} onRetry={onRetry} />,
      ),
    );

    expect(container.textContent).toContain('цепочка не прочиталась');
    expect(container.textContent).toContain('повторить');
    expect(container.textContent).not.toContain('у этой строки нет истории');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('aside.chain')?.hasAttribute('aria-busy')).toBe(false);

    const retry = container.querySelector<HTMLButtonElement>('aside.chain .state-line button');
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says «у этой строки нет истории» only for a read that came back empty', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <ParagraphChain
          chain={null}
          loading={false}
          failed={false}
          onClose={() => undefined}
          onRetry={() => undefined}
        />,
      ),
    );
    expect(container.textContent).toContain('у этой строки нет истории');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe('the chain’s hook (BOOK-DOC-43 §10)', () => {
  function Harness() {
    const mode = useParagraphChain();
    return (
      <>
        <button type="button" className="open" onClick={() => mode.open('ch08#0b7e9c31', ANCHOR)}>
          открыть
        </button>
        {mode.active ? (
          <ParagraphChain
            chain={mode.chain}
            loading={mode.loading}
            failed={mode.failed}
            onClose={mode.close}
            onRetry={mode.retry}
            anchor={mode.anchor}
          />
        ) : null}
      </>
    );
  }

  it('retries the same block id after a failure, and the retry is never dropped by the guard', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(notFound());
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));

    await act(async () => container.querySelector<HTMLButtonElement>('.open')?.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/history/paragraphs/ch08%230b7e9c31');
    expect(container.textContent).toContain('цепочка не прочиталась');

    const retry = container.querySelector<HTMLButtonElement>('aside.chain .state-line button');
    await act(async () => retry?.click());
    await flush();

    // The retry is a fresh attempt for the same paragraph, and its answer lands.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(String(fetchMock.mock.calls[0]?.[0]));
    expect(container.textContent).not.toContain('цепочка не прочиталась');
    expect(container.textContent).toContain('у этой строки нет истории');
  });

  it('drops a late answer for a chain that was closed meanwhile', async () => {
    let settle: ((value: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => {
        settle = resolve;
      })),
    );
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));

    await act(async () => container.querySelector<HTMLButtonElement>('.open')?.click());
    // Close while the request is still in flight: the panel unmounts.
    await act(async () => container.querySelector<HTMLButtonElement>('aside.chain .chain-close')?.click());
    await flush();
    expect(container.querySelector('aside.chain')).toBeNull();

    await act(async () => settle?.({ ok: true, status: 200, statusText: 'OK', json: async () => CHAIN } as unknown as Response));
    await flush();
    expect(container.querySelector('aside.chain')).toBeNull();
  });
});
