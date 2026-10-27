// @vitest-environment jsdom
import type { StateSnapshot } from '@book/shared';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCurrentChapter } from '../lib/useCurrentChapter.ts';
import { Header } from './Header.tsx';

/**
 * BOOK-90 B — the running head names the chapter the reader is in.
 *
 * The mechanism is one `IntersectionObserver` over the slots with a band under the sticky
 * head; the test drives the callbacks directly (the repo's stub idiom) and proves: no chapter
 * before the first one, the number inside a chapter, the slot's own word, updates only when
 * the chapter changes, one reserved chip in the existing first row, and no extra row.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

type Band = { target: Element; isIntersecting: boolean };

class BandObserver {
  static last: BandObserver | null = null;
  targets: Element[] = [];
  unobserved: Element[] = [];
  disconnected = false;
  options: IntersectionObserverInit | undefined;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.options = options;
    BandObserver.last = this;
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    this.unobserved.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(entries: Band[]): void {
    this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

const STATE: StateSnapshot = {
  version: 1,
  at: '2026-10-27T12:00:00Z',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: '2026-10-27T10:00:00Z' },
  chapters: { total: 67, written: [1], empty: [2, 21, 67], count: 1, totalChars: 12_000, basis: [] },
  cursors: {
    forward: { lane: 'forward', from: 1, to: 67, cursor: 1, next: 2, status: 'idle', lastPassAt: null, lastPass: null },
    backward: { lane: 'backward', from: 67, to: 1, cursor: 67, next: 66, status: 'idle', lastPassAt: null, lastPass: null },
  },
  toc: [],
  meeting: { forwardFront: 1, backwardFront: 67, gap: 0, converged: false, seam: 'not_reached' },
  cascade: null,
  queue: {
    depth: 0,
    byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
    head: null,
    processing: null,
    lastDecidedAt: null,
  },
  revising: [],
  current: null,
  unresolved: [],
  activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', BandObserver);
  BandObserver.last = null;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  await act(async () => {
    root?.render(
      <>
        <Header state={STATE} ribbon={null} markers={[]} onOpenChange={() => undefined} />
        <article className="ch" data-n={1} id="ch-1">
          <h3 className="ch-title">Комната на восьмом</h3>
        </article>
        <article className="ch ch-empty" data-n={21} id="ch-21">
          <div className="premise">
            <button type="button" className="premise-row">
              <span className="premise-label">замысел</span>
            </button>
          </div>
        </article>
        <article className="ch ch-empty" data-n={67} id="ch-67" />
      </>,
    );
  });
}

function chip(): HTMLElement {
  const node = container.querySelector<HTMLElement>('.top-chapter');
  if (node === null) throw new Error('no .top-chapter');
  return node;
}

describe('the running head', () => {
  it('names no chapter before the first one, and observes every slot', async () => {
    await mount();
    expect(BandObserver.last?.targets).toHaveLength(3);
    expect(chip().textContent).toBe('');
    expect(chip().getAttribute('data-n')).toBeNull();
    // The band starts at the head's own offset (64 px when the token cannot be read).
    expect(BandObserver.last?.options?.rootMargin).toBe('-64px 0px -68% 0px');
  });

  it('follows a chapter created live: the new slot is observed and can be named', async () => {
    await mount();
    const late = document.createElement('article');
    late.className = 'ch ch-empty';
    late.setAttribute('data-n', '30');
    late.innerHTML = '<button class="premise-row"><span class="premise-label">замысел</span></button>';
    await act(async () => {
      container.append(late);
      await Promise.resolve();
    });
    const observer = BandObserver.last!;
    expect(observer.targets).toHaveLength(4);
    await act(async () => observer.emit([{ target: late, isIntersecting: true }]));
    expect(chip().textContent).toContain('30');
    expect(chip().textContent).toContain('замысел');
  });

  it('stops observing a slot that left the page', async () => {
    function Removable(): ReactElement {
      const [shown, setShown] = useState(true);
      return (
        <>
          <article className="ch" data-n={9} id="ch-9" />
          {shown ? <article className="ch" data-n={67} id="ch-67" /> : null}
          <button type="button" data-remove onClick={() => setShown(false)}>
            remove
          </button>
        </>
      );
    }
    await act(async () => {
      root?.render(
        <>
          <Header state={STATE} ribbon={null} markers={[]} onOpenChange={() => undefined} />
          <Removable />
        </>,
      );
    });
    const observer = BandObserver.last!;
    const removed = container.querySelector('#ch-67')!;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-remove]')?.click();
      await Promise.resolve();
    });
    expect(observer.unobserved).toContain(removed);
  });

  it('names the chapter the band enters: 1, 21, 67 — number and the slot’s own word', async () => {
    await mount();
    const observer = BandObserver.last!;

    await act(async () => observer.emit([{ target: container.querySelector('#ch-1')!, isIntersecting: true }]));
    expect(chip().textContent).toContain('1');
    expect(chip().textContent).toContain('Комната на восьмом');
    expect(chip().getAttribute('data-n')).toBe('1');

    await act(async () =>
      observer.emit([
        { target: container.querySelector('#ch-1')!, isIntersecting: false },
        { target: container.querySelector('#ch-21')!, isIntersecting: true },
      ]),
    );
    expect(chip().textContent).toContain('21');
    expect(chip().textContent).toContain('замысел');
    expect(chip().getAttribute('data-n')).toBe('21');

    await act(async () =>
      observer.emit([
        { target: container.querySelector('#ch-21')!, isIntersecting: false },
        { target: container.querySelector('#ch-67')!, isIntersecting: true },
      ]),
    );
    expect(chip().textContent).toContain('67');
    expect(chip().getAttribute('data-n')).toBe('67');
    // The last slot prints no word: the number alone, never an invented chapter name.
    expect(chip().querySelector('.top-chapter-w')).toBeNull();
  });

  it('updates only when the chapter changes: the same chapter again changes nothing', async () => {
    await mount();
    const observer = BandObserver.last!;
    const target = container.querySelector('#ch-21')!;
    await act(async () => observer.emit([{ target, isIntersecting: true }]));
    const before = chip().outerHTML;
    await act(async () => observer.emit([{ target, isIntersecting: true }]));
    expect(chip().outerHTML).toBe(before);
  });

  it('keeps one reserved chip inside the existing first row — never a third row', async () => {
    await mount();
    expect(container.querySelectorAll('.top-row')).toHaveLength(2);
    expect(container.querySelector('.top-row')?.querySelector('.top-chapter')).toBe(chip());
    // Two clusters: brand + chapter chip on the left, the live chip and the queue on the right.
    const rows = container.querySelectorAll('.top-row');
    expect(rows[0]?.querySelector('.brand')).not.toBeNull();
    expect(rows[0]?.querySelector('.top-chapter')).toBe(chip());
    expect(rows[1]?.querySelector('.live')).not.toBeNull();
    expect(rows[1]?.querySelector('.queue')).not.toBeNull();
    // The old `display: contents` is what spread four items across the line; it is gone, and the
    // left cluster keeps one 24 px gap between the brand and the chip.
    const chrome = sheets['../styles/chrome.css'] ?? '';
    expect(chrome).not.toContain('display: contents');
    expect(chrome).toMatch(/\.top-in \.top-row:first-child \{[^}]*gap: 24px/u);
    const css = sheets['../styles/running-head.css'] ?? '';
    expect(css).toContain('font-family: var(--label)');
    expect(css).toContain('font-size: var(--fs-micro)');
    expect(css).toContain('width: 18ch');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    // The phone keeps the fact: the number alone when the word does not fit.
    expect(css).toMatch(/@media \(max-width: 599px\)[\s\S]*\.top-chapter-w[\s\S]*display: none/u);
    // No new rung: the chip is the floor, not a smaller size.
    expect(css).not.toMatch(/font-size:\s*(1[01](\.\d+)?px|0\.\d+rem)/u);
  });

  it('is inert without an observer, and does not observe when disabled', async () => {
    function Probe({ enabled }: { enabled: boolean }): ReactElement {
      const chapter = useCurrentChapter(enabled);
      return <span data-probe>{chapter === null ? '' : String(chapter.n)}</span>;
    }
    vi.stubGlobal('IntersectionObserver', undefined);
    await act(async () => {
      root?.render(
        <>
          <Probe enabled />
          <article className="ch" data-n={1} />
        </>,
      );
    });
    expect(container.querySelector('[data-probe]')?.textContent).toBe('');

    vi.stubGlobal('IntersectionObserver', BandObserver);
    BandObserver.last = null;
    await act(async () => {
      root?.render(
        <>
          <Probe enabled={false} />
          <article className="ch" data-n={1} />
        </>,
      );
    });
    expect(BandObserver.last).toBeNull();
  });

  it('stops observing when the head goes away', async () => {
    await mount();
    const observer = BandObserver.last!;
    await act(async () => root?.unmount());
    root = null;
    expect(observer.disconnected).toBe(true);
  });
});
