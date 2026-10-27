// @vitest-environment jsdom
import type { ChangeDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFocusMode } from '../useFocus.ts';
import { FocusView } from './FocusView.tsx';

/**
 * BOOK-DOC-43 §4, §6, §7, §10 (BOOK-66) — the прицел's wait.
 *
 * The thresholds need a clock: 149 ms shows no sentence and no form, 150 ms shows both in the
 * bar's own `.focus-n` slot and in the sheet area, 2 000 ms adds the one slow sentence, and
 * the data replaces it in the same commit with the busy claim removed. A failure is not a
 * longer wait: the sheet prints the not-found block, never «правка читается» for ever.
 *
 * The fixture is a dropped change (`canPrint` false, `history` null), so mounting the settled
 * state fetches nothing: this file is about the wait, not the blocks.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CHANGE: ChangeDto = {
  id: 'chg_1',
  seq: 14,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  premise: false,
  source: { commentId: null, author: null },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'void',
  outcome: 'dropped',
  reason: 'в главе уже одно упоминание — второе убрано',
  position: null,
  relevance: null,
  cascade: null,
  modes: [],
  steps: [],
  appliedRevs: [],
  cost: null,
  history: null,
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

let root: Root | null = null;

beforeEach(() => {
  // jsdom has no scrolling; the dialog restores the reader's offset on unmount.
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.location.hash = '';
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

function sheet(change: ChangeDto | null, missing = false) {
  return (
    <FocusView change={change} impact={null} missing={missing} ribbon={null} revisions={{}} onClose={() => undefined} live />
  );
}

describe('the прицел while the change is read (BOOK-DOC-43)', () => {
  it('says nothing before 150 ms, then the sentence and the form, then the slow line, and the sheet on data', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(sheet(null)));
    const dialog = (): HTMLElement | null => container.querySelector('.focus');
    // §7: busy for the whole request, from the first render.
    expect(dialog()?.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(container.querySelector('.focus-n')?.textContent).toBe('');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.skel')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const status = container.querySelector('.focus-n [role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(status?.textContent).toBe('правка читается');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('.skel-sheet')).not.toBeNull();
    expect(container.querySelector('.skel-sheet')?.getAttribute('data-lines')).toBe('4');
    // No paper ahead of the text: the form sits in the sheet's area, the sheet does not.
    expect(container.querySelector('.focus-paper')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_850);
    });
    expect(container.querySelector('.focus-n [role="status"]')?.textContent).toBe(
      'правка идёт дольше обычного · лист заполнится здесь же',
    );

    // The change lands: the number replaces the sentence, the form goes, the busy claim goes.
    await act(async () => root?.render(sheet(CHANGE)));
    expect(container.querySelector('.focus-n')?.textContent).toBe('правка 014');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(dialog()?.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('.focus-paper')).not.toBeNull();
  });

  it('prints the not-found block on a failure instead of the eternal waiting line', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(sheet(null, true)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(container.textContent).toContain('правка не найдена');
    expect(container.textContent).toContain('ссылка ведёт на правку, которой нет · возможно, она старая');
    expect(container.textContent).not.toContain('правка читается');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.focus')?.hasAttribute('aria-busy')).toBe(false);
  });
});

/** Only `status`, `ok` and `json()` are read on the happy path; jsdom has no `Response`. */
function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

/** The hook and the sheet, wired the way `App` wires them. */
function Harness() {
  const focus = useFocusMode(() => undefined);
  return (
    <FocusView
      change={focus.change}
      impact={focus.impact}
      missing={focus.missing}
      ribbon={null}
      revisions={{}}
      onClose={focus.close}
      live
    />
  );
}

describe('the прицел’s session on a failed read (BOOK-DOC-43 §10)', () => {
  it('leaves the waiting state for the not-found block', async () => {
    window.location.hash = '#правка-chg_1';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Harness />));
    await flush();

    expect(container.textContent).toContain('правка не найдена');
    expect(container.textContent).not.toContain('правка читается');
    expect(container.querySelector('.focus')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('treats an answer for another id as a missing change, not as a longer wait', async () => {
    // §10: the route is keyed by id, so a payload naming another change cannot be shown —
    // and it cannot be a wait either, or «правка читается» and the 176 px sheet form stay up
    // for ever. Before the fix `change` stayed null and `missing` stayed false.
    window.location.hash = '#правка-chg_1';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/changes/chg_1') return Promise.resolve(answer({ ...CHANGE, id: 'chg_9' }));
        return Promise.reject(new Error('offline'));
      }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Harness />));
    await flush();

    expect(container.textContent).toContain('правка не найдена');
    expect(container.textContent).not.toContain('правка читается');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('.focus')?.hasAttribute('aria-busy')).toBe(false);
  });
});
