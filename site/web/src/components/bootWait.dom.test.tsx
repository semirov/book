// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BootWait } from './BootWait.tsx';

/**
 * BOOK-DOC-43 §3, §4, §6 — the boot wait says nothing for 150 ms, then one sentence
 * (BOOK-66).
 *
 * The surface is extracted from `App` precisely so this is provable without a socket, an
 * analytics banner and the whole catalogue: the only thing under test is the threshold.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement;
/** Any `console.error` during a case is an act warning or a render error; both fail the case. */
let errorCount: () => number = () => 0;
let restoreConsole: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  errorCount = () => spy.mock.calls.length;
  restoreConsole = () => spy.mockRestore();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  restoreConsole();
});

function statuses(): Element[] {
  return [...container.querySelectorAll('[role="status"]')];
}

async function render(active: boolean): Promise<void> {
  await act(async () => {
    root?.render(<BootWait active={active} />);
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe('the boot wait', () => {
  it('is silent for 149 ms, then says one sentence, then the slow one at 2 000', async () => {
    await render(true);
    // The page's own paper: no label, no bars, no busy claim of its own inside the field.
    expect(container.innerHTML).toBe('');

    await wait(149);
    expect(statuses()).toHaveLength(0);
    expect(container.textContent).toBe('');

    await wait(1);
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0]?.textContent).toBe('опись читается');
    expect(statuses()[0]?.getAttribute('aria-live')).toBe('polite');
    expect(statuses()[0]?.getAttribute('aria-atomic')).toBe('true');

    await wait(1_850);
    // Still exactly one element: the sentence is replaced, never stacked.
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0]?.textContent).toBe('опись идёт дольше обычного · книга откроется здесь же');

    expect(errorCount()).toBe(0);
  });

  it('leaves in the frame the data lands, and starts the count again on the next wait', async () => {
    await render(true);
    await wait(2_000);
    expect(statuses()).toHaveLength(1);

    await render(false);
    expect(statuses()).toHaveLength(0);
    expect(container.innerHTML).toBe('');
    // A settled surface owns no timer: nothing fires into the page later.
    expect(vi.getTimerCount()).toBe(0);

    await wait(5_000);
    expect(statuses()).toHaveLength(0);
    expect(errorCount()).toBe(0);
  });

  it('never flashes for a wait shorter than the threshold', async () => {
    await render(true);
    await wait(149);
    await render(false);
    expect(statuses()).toHaveLength(0);
    await wait(5_000);
    expect(statuses()).toHaveLength(0);
    expect(errorCount()).toBe(0);
  });
});
