// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePending } from './usePending.ts';

/**
 * BOOK-DOC-43 §4 — one timer per threshold, cleared on settle and on unmount (BOOK-66).
 *
 * The chapter's own test proves the surface; this one proves the hook's contract, which is
 * where a stale stage is born: no timer while nothing waits, two while the wait runs, none
 * left after the settle, and a `'quiet'` return in the same render that `active` drops.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ active }: { active: boolean }): React.ReactElement {
  const stage = usePending(active);
  return <span data-stage={stage} />;
}

let root: Root | null = null;
let container: HTMLDivElement;

function stage(): string | null {
  return container.querySelector('[data-stage]')?.getAttribute('data-stage') ?? null;
}

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root?.render(node);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the wait has one timer per threshold', () => {
  it('starts no timer while nothing waits', async () => {
    await render(<Probe active={false} />);
    expect(stage()).toBe('quiet');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(stage()).toBe('quiet');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('walks quiet → skeleton → slow, and forgets the stage the moment the wait settles', async () => {
    await render(<Probe active={true} />);
    expect(stage()).toBe('quiet');
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(149);
    });
    expect(stage()).toBe('quiet');
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(stage()).toBe('skeleton');
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(1_850);
    });
    expect(stage()).toBe('slow');

    // The settle is visible before the cleanup effect runs: no stale stage, no leftover timer.
    await render(<Probe active={false} />);
    expect(stage()).toBe('quiet');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(stage()).toBe('quiet');
  });

  it('survives a StrictMode double effect: the cleanup clears both timers, the stage still arrives', async () => {
    await render(
      <StrictMode>
        <Probe active={true} />
      </StrictMode>,
    );
    // Two mounts, two cleanups: only the live effect's pair of timers remains.
    expect(vi.getTimerCount()).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(stage()).toBe('skeleton');
    await act(async () => {
      vi.advanceTimersByTime(1_850);
    });
    expect(stage()).toBe('slow');
  });

  it('clears its timers on unmount, so nothing fires into a dead tree', async () => {
    await render(<Probe active={true} />);
    expect(vi.getTimerCount()).toBe(2);
    await act(async () => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
