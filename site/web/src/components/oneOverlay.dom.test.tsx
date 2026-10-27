// @vitest-environment jsdom
import type { CatalogEntry, ChangeDto, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { closeOverlays } from '../lib/overlays.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { hideRevision } from '../lib/useRevision.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { FocusView } from './FocusView.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-111 (owner, 2026-10-27) — **one close on screen, whatever is open**.
 *
 * This file enumerates the page's surface combinations rather than one feature: the strip, the
 * strip with its form, the strip under a word's panel, the strip under a card, the revision
 * object and the прицел. Each one may show exactly one floating frame and exactly one close,
 * and no two close-carrying frames may stand together — the owner's screenshot was two of them.
 *
 * The прицел is not a floating layer and the revision object is an inline margin object, so the
 * prescribed selector (`.prov-panel, .filing-panel, [data-open="true"]`) counts 0 for them on
 * purpose: the one frame is asserted by its own class in those cases.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 8,
  part: 2,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 40,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const BLOCK_ID = 'ch08#oneclose';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

/** The two questions the enumeration asks of the DOM. */
const FLOATING = '.prov-panel, .filing-panel, [data-open="true"]';
const CLOSES = '.seam-close, .prov-close, .filing-close, .revision-close, .focus-exit';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: 'Я вошёл в пустую комнату.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

/** A dropped change: the settled прицел prints its sheet and fetches nothing. */
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
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

let root: Root | null = null;
let container: HTMLDivElement;

function freshRoot(): void {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
}

beforeEach(() => {
  resetParagraphChainCache();
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true });
  freshRoot();
});

afterEach(async () => {
  await teardown();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetParagraphChainCache();
});

async function teardown(): Promise<void> {
  await act(async () => {
    hideFiling();
    hideRevision();
    closeSeam();
  });
  if (root !== null) await act(async () => root?.unmount());
  root = null;
}

/** Between combinations: the page is cleared and a fresh root is ready for the next one. */
async function restart(): Promise<void> {
  await teardown();
  document.body.innerHTML = '';
  freshRoot();
}

async function click(selector: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  await act(async () => {
    element.click();
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

async function mount(comments: readonly CommentDto[] = []): Promise<void> {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 0 });
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        frozen={false}
        comments={comments}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
        history
      />,
    );
  });
  await act(async () => {
    openSeam({ chapter: 8, blockId: BLOCK_ID, key: seamKey(8, BLOCK_ID, anchor!.sentence, ENTRY.rev), anchor, origin: container });
  });
}

/** One floating frame (or none, where the frame is inline) and exactly one close. */
function expectOneFrame(expected: { floating: number; close: string; frame?: string }): void {
  expect(document.querySelectorAll(FLOATING).length, 'floating frames').toBe(expected.floating);
  expect(document.querySelectorAll(CLOSES).length, 'close controls').toBe(1);
  const control = document.querySelector(CLOSES);
  expect(control?.className, 'the close belongs to the one frame').toBe(expected.close);
  if (expected.frame !== undefined) expect(document.querySelector(expected.frame), expected.frame).not.toBeNull();
}

describe('one close on screen for every surface combination', () => {
  it('one close on screen for every surface combination', async () => {
    // 1 — the strip alone: no floating layer, and its own ✕ is the only control of its kind.
    await mount();
    expectOneFrame({ floating: 0, close: 'seam-close' });
    await restart();

    // 2 — the strip with its form: the form is inline, and it does not add a second ✕.
    await mount();
    await click('.seam-cta');
    expect(document.querySelector('.seam-form')).not.toBeNull();
    expectOneFrame({ floating: 1, close: 'seam-close' });
    await restart();

    // 3 — the strip under the word's record: the strip's ✕ is gone, the panel's is the one.
    await mount();
    await click('.seam-prov');
    expect(document.querySelector('.seam-close')).toBeNull();
    expectOneFrame({ floating: 1, close: 'prov-close' });
    await restart();

    // 4 — the strip under the sentence's card: still one frame and one close.
    await mount([comment()]);
    await click('.seam-filing');
    expect(document.querySelector('.seam-close')).toBeNull();
    expectOneFrame({ floating: 1, close: 'filing-close' });
    await restart();

    // 5 — the revision object: inline in the margin, so it is not a floating layer — but the
    // record opens over a seam and a panel, and exactly one close stays on the page.
    await mount([comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })]);
    await click('.seam-prov');
    expect(document.querySelector('.prov-panel')).not.toBeNull();
    await click('.filing-tick');
    expect(document.querySelector('.prov-panel')).toBeNull();
    expect(document.querySelector('.seam')).toBeNull();
    expectOneFrame({ floating: 0, close: 'revision-close', frame: '.revision' });
    await restart();

    // 6 — the прицел: a mode of the same page, entered exactly as the app enters it. Every
    // overlay is cleared, and the sheet's «выйти» is the only close.
    await mount([comment()]);
    await click('.seam-filing');
    expect(document.querySelector('.filing-panel')).not.toBeNull();
    await act(async () => closeOverlays());
    expect(document.querySelector('.seam')).toBeNull();
    expect(document.querySelector('.filing-panel')).toBeNull();
    const focusHost = document.body.appendChild(document.createElement('div'));
    const focusRoot = createRoot(focusHost);
    await act(async () => {
      focusRoot.render(
        <FocusView
          change={CHANGE}
          impact={null}
          missing={false}
          ribbon={null}
          revisions={{}}
          onClose={() => undefined}
          live
        />,
      );
    });
    expectOneFrame({ floating: 0, close: 'focus-exit', frame: '.focus' });
    await act(async () => focusRoot.unmount());
    focusHost.remove();
  });
});
