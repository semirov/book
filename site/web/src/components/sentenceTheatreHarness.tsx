// @vitest-environment jsdom
import type { CommentDto, PassStageEvent } from '@book/shared';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

import type { SentenceFilings } from '../lib/filings.ts';
import type { AppliedWrite } from '../lib/clientState.ts';
import { publishFilingLive, resetFilingLive } from '../lib/filingLive.ts';
import { TheatreStageProvider } from '../lib/theatreStage.tsx';
import { SentenceTheatre } from './SentenceTheatre.tsx';

/**
 * BOOK-227 / BOOK-DOC-86 — the renderer's jsdom surface, shared by its test files.
 *
 * jsdom lays nothing out, so the sentence's boxes are injected here once: one `Range` over the
 * sentence answers with its lines, one per word with its box, and the baseline probe with its
 * own. `installFrames`/`cleanup` are the per-case hooks; `draw` mounts one sentence and returns
 * the overlay's host; `step` advances the fake clock and runs every queued frame.
 *
 * The original header follows.
 *
 * jsdom lays nothing out, so the sentence's boxes are injected: one `Range` over the sentence
 * answers with its lines, one per word with its box, and the baseline probe with its own. What
 * this proves: the overlay's nodes are the sentence's lines (never its words), the fill follows
 * the clock and stops at `sweepMs`, each rule is **painted** (not merely present), the pen leaves
 * with its act, and every act paints its own mark and no other. What it cannot prove: that a
 * browser's boxes are where the paragraph puts them — that is the plate.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const T0 = 1_764_000_000_000;
export const SENTENCE = 'Комната стояла в конце коридора и дверь была открыта';
export const WORDS = SENTENCE.split(' ');
export const LINE = 27.2;

export const rect = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

export function comment(overrides: Partial<CommentDto> & { status: CommentDto['status'] }): CommentDto {
  return {
    id: 'cmt_A7K',
    number: 12,
    chapter: 1,
    anchor: {
      blockId: 'ch01#0594465f',
      blockIndex: 3,
      quote: SENTENCE,
      prefix: null,
      suffix: null,
      resolved: true,
    },
    author: 'семиров',
    authorColor: '#000',
    body: 'текст',
    proposedText: null,
    interventionKind: 'document',
    refusal: null,
    frame: null,
    premise: false,
    changeStatus: null,
    reason: null,
    attempt: null,
    createdAt: new Date(T0 - 60_000).toISOString(),
    decidedAt: null,
    changeId: 'chg_1',
    applied: null,
    ...overrides,
  };
}

export const filingsOf = (row: CommentDto): SentenceFilings => ({
  blockId: 'ch01#0594465f',
  quote: row.anchor.quote,
  all: [row],
  number: '№A7K',
  extra: 0,
  stale: false,
});

/**
 * BOOK-220 §11.3 — the read's own frame, published exactly as `App` publishes it: the reducer's
 * `reading` field, not a store of the theatre's own.
 */
export const claim = (at: number): void => {
  publishFilingLive({
    reading: {
      commentId: 'cmt_A7K',
      chapter: 1,
      phase: 'claimed',
      attempt: 1,
      maxAttempts: 5,
      widened: null,
      desperate: false,
      since: at,
      deadlineAt: at + 900_000,
      retryAt: null,
      reason: null,
    },
    filingUpdates: {},
    decisions: {},
  });
};

/** A `chapter:applied` write naming this sentence's block (PR #121's own record). */
export const write = (overrides: Partial<AppliedWrite> = {}): AppliedWrite => ({
  n: 1,
  rev: 16,
  appliedAt: T0,
  patch: [],
  patchTruncated: false,
  span: [{ blockId: 'ch01#0594465f', before: 'было', after: 'стало', truncated: false }],
  ...overrides,
});

let frames: FrameRequestCallback[] = [];
let clock = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

export function installFrames(): void {
  resetFilingLive();
  frames = [];
  clock = T0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  // jsdom has no media queries: motion is the default, and each case that wants stillness says so.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${LINE}px` } as CSSStyleDeclaration);
  // jsdom has no offsetParent: the paragraph is the overlay's coordinate space.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('p') ? document.body : (this.parentElement?.closest('.p') ?? null);
    },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('p')) return rect(0, 0, 342, 2 * LINE);
    // the baseline probe: an empty inline-block, one line above the sentence's last line
    if (this instanceof HTMLElement && this.style.cssText.includes('vertical-align: baseline')) {
      // the inline-block's bottom edge is the baseline: 22 px below the last line's top
      return { ...rect(0, 0, 0, 0), bottom: LINE + 22 } as DOMRect;
    }
    return rect(0, 0, 0, 0);
  });
  // jsdom implements neither `Range` geometry method: the boxes are injected as data.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      if (this.toString() !== SENTENCE) return [] as unknown as DOMRectList;
      return [rect(0, 0, 300, LINE), rect(LINE, 0, 400, LINE)] as unknown as DOMRectList;
    },
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      const index = WORDS.indexOf(this.toString());
      if (index < 0) return rect(0, 0, 0, 0);
      // five words a line, 40 px each with 4 px of air
      return rect(index < 5 ? 0 : LINE, 4 + (index % 5) * 44, 40, 18);
    },
  });
}

export async function cleanup(): Promise<void> {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  resetFilingLive();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
}

export type DrawOptions = {
  row: CommentDto;
  nowAt?: number;
  reduced?: boolean;
  transportDown?: boolean;
  stages?: Parameters<typeof SentenceTheatre>[0]['stages'];
  /** The chapter's write, handed down the way `ChapterProse` hands it (§9.4). */
  applied?: AppliedWrite;
};

export async function draw(options: DrawOptions): Promise<HTMLElement> {
  if (container === null) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  clock = options.nowAt ?? T0;
  const theatre = (
    <SentenceTheatre
      filings={filingsOf(options.row)}
      stages={options.stages ?? null}
      now={() => clock}
      reduced={options.reduced}
      {...(options.transportDown === undefined ? {} : { transportDown: options.transportDown })}
    />
  );
  await act(async () => {
    root?.render(
      <p className="p">
        <span data-s="0" className="cited rule-solid ink-live">
          <span className="sentence-door">{SENTENCE}</span>
          {options.applied === undefined ? (
            theatre
          ) : (
            <TheatreStageProvider value={{ chapter: 1, stages: null, applied: options.applied, transport: 'up' }}>
              {theatre}
            </TheatreStageProvider>
          )}
        </span>
      </p>,
    );
  });
  const host = container.querySelector<HTMLElement>('.theatre');
  if (host === null) throw new Error('the theatre rendered no overlay');
  return host;
}

/** The mounted surface, for a case that asks the DOM rather than the overlay. */
export const surface = (): HTMLDivElement | null => container;

/**
 * A bare mount for a case with no act to draw: the same paragraph, no provider, no overlay.
 * `cleanup()` unmounts it with the rest.
 */
export async function mount(content: ReactNode): Promise<HTMLDivElement> {
  if (container === null) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(content);
  });
  return container;
}

/** Advance the clock and run every frame that is queued (a cancelled one is a no-op). */
export async function step(ms: number): Promise<void> {
  clock += ms;
  const due = frames;
  frames = [];
  await act(async () => {
    for (const callback of due) callback(clock);
  });
}

