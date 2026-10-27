// @vitest-environment jsdom
import type { CatalogEntry, ChangeDto, CommentDto } from '@book/shared';
import { act, useCallback, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { closeOverlays } from '../lib/overlays.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { hideRevision } from '../lib/useRevision.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { useFocusMode } from '../useFocus.ts';
import { ChapterArticle } from './ChapterArticle.tsx';
import { FocusView } from './FocusView.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-111 (owner, 2026-10-27) — **one close on screen, whatever is open**.
 *
 * This file enumerates the page's surface combinations rather than one feature: the strip, the
 * strip with its form, the strip with its form under a word's panel or under the filing its own
 * refusal names, the same three on an empty chapter's premise, the strip under a card, the
 * revision object and the прицел. Each one may show exactly one floating frame and exactly one
 * close, and no two close-carrying frames may stand together — the owner's screenshot was two
 * of them.
 *
 * Every combination is mounted for real (no store poked from the test): the прицел is entered
 * through the hash and the app's own `enterFocus`, and each close is asserted by where focus
 * lands — the door, the strip's trigger or nothing at all — not only by what the DOM holds.
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
    refusal: null,
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
  window.location.hash = '';
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

async function mount(comments: readonly CommentDto[] = [], extra: ReactNode = null): Promise<void> {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 0 });
  await act(async () => {
    root?.render(
      <>
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
        />
        {extra}
      </>,
    );
  });
  await act(async () => {
    openSeam({ chapter: 8, blockId: BLOCK_ID, key: seamKey(8, BLOCK_ID, anchor!.sentence, ENTRY.rev), anchor, origin: container });
  });
}

/** An empty chapter, mounted the way the page mounts it: one row, and its premise strip. */
const EMPTY: CatalogEntry = {
  ...ENTRY,
  n: 7,
  title: null,
  rev: 0,
  chars: 0,
  blocks: 0,
  written: false,
  writtenAt: null,
  updatedAt: null,
};

async function mountEmptyChapter(): Promise<void> {
  await act(async () => {
    root?.render(
      <ChapterArticle
        entry={EMPTY}
        revision={null}
        revising={null}
        caret={null}
        fresh={false}
        firstEmpty
        history={false}
        comments={[]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
      />,
    );
  });
}

/** A controlled field needs the native setter, or React never sees the change. */
function typeInto(selector: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

/** Submit the open form and let the refused request settle inside the same act. */
async function submit(): Promise<void> {
  await act(async () => {
    document.querySelector('.seam-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

/**
 * The prod 409 answering the form, and the filing it names answering the door. The combination
 * the blocker lived in: the refusal's own door opens the filing, and the strip under the panel
 * is rebuilt when the panel closes.
 */
function refusing(dto: CommentDto): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(`/api/comments/${dto.id}`)) {
        return new Response(JSON.stringify(dto), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: dto.id }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

/**
 * The app's own door into the прицел: `App.tsx` hands `enterFocus` (`card.close()` +
 * `closeOverlays()`) to `useFocusMode`, so entering the mode clears every overlay before the
 * lit sheet is drawn. The enumeration enters it the same way — the hash, not a test shortcut.
 */
function FocusDoor() {
  const enterFocus = useCallback(() => closeOverlays(), []);
  const focus = useFocusMode(enterFocus);
  return focus.id === null ? null : (
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

    // 6 — the прицел: a mode of the same page, entered exactly as the app enters it (§11.9).
    // The app's `enterFocus` clears every overlay; the sheet's «выйти» is the only close, and
    // when it goes the strip behind is not resurrected.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === `/api/changes/${CHANGE.id}`) {
          return new Response(JSON.stringify(CHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    await mount([comment()], <FocusDoor />);
    await click('.seam-filing');
    expect(document.querySelector('.filing-panel')).not.toBeNull();
    await act(async () => {
      window.location.hash = '#правка-chg_1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      // jsdom queues its own `hashchange` for the same assignment: let it land inside this act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('.focus-n')?.textContent, 'the sheet loaded the change').toBe('правка 014');
    expect(document.querySelector('.seam'), 'entering the прицел closes the strip').toBeNull();
    expect(document.querySelector('.filing-panel'), 'and the panel under it').toBeNull();
    expectOneFrame({ floating: 0, close: 'focus-exit', frame: '.focus' });
    await click('.focus-exit');
    expect(document.querySelector('.focus')).toBeNull();
    expect(document.querySelector('.seam'), 'the strip does not resurrect').toBeNull();
    // The sheet's exit hands nothing to a strip: the page behind is clean, and no focus was
    // left on a control that no longer exists.
    expect(document.activeElement).toBe(document.body);
    await restart();

    // 7 — the strip with its form under the word's record: two half-written surfaces never
    // coexist, so the form is the surface that goes — and the panel's close gives it back.
    await mount();
    await click('.seam-cta');
    expect(document.querySelector('.seam-form')).not.toBeNull();
    await click('.seam-prov');
    expect(document.querySelector('.seam-form'), 'the form goes under the panel').toBeNull();
    expectOneFrame({ floating: 1, close: 'prov-close' });
    await click('.prov-close');
    expect(document.querySelector('.seam-form'), 'and comes back with the strip').not.toBeNull();
    expect(document.querySelector('.seam')?.getAttribute('data-state')).toBe('form');
    expectOneFrame({ floating: 1, close: 'seam-close' });
    expect(document.activeElement?.getAttribute('data-door')).toBe('prov');
    await restart();

    // 8 — the strip with its form under the filing its own refusal names (the blocker). The
    // refusal is the strip's fact: the rebuilt form prints the line and its door again, and the
    // focus the panel's close returns lands on that door — never on `<body>`.
    refusing(comment({ id: 'cmt_x' }));
    await mount();
    await click('.seam-cta');
    typeInto('textarea.seam-text', 'Свет был включён до меня, и это видно по тени.');
    await submit();
    expect(document.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    await click('[data-door="duplicate"]');
    expect(document.querySelector('.seam-form')).toBeNull();
    expectOneFrame({ floating: 1, close: 'filing-close' });
    await click('.filing-close');
    expect(document.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    expect(document.querySelector('[data-door="duplicate"]')).not.toBeNull();
    expectOneFrame({ floating: 1, close: 'seam-close' });
    expect(document.activeElement?.getAttribute('data-door')).toBe('duplicate');
    await restart();

    // 9 — an empty chapter's premise strip with its form under the card its refusal names. The
    // same three surfaces on a chapter with no prose: one close at a time, and the refusal
    // survives the card that its own door opened.
    refusing(
      comment({
        id: 'cmt_x',
        chapter: 7,
        premise: true,
        anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
      }),
    );
    await mountEmptyChapter();
    await click('.premise-row');
    expect(document.querySelector('.seam')).not.toBeNull();
    await click('.seam-cta');
    expect(document.querySelector('.seam-form')).not.toBeNull();
    expectOneFrame({ floating: 1, close: 'seam-close' });
    typeInto('textarea.seam-text', 'А как это работает, если свет был раньше?');
    await submit();
    expect(document.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    await click('[data-door="duplicate"]');
    expect(document.querySelector('.seam-form')).toBeNull();
    expectOneFrame({ floating: 1, close: 'filing-close', frame: '.filing-panel' });
    await click('.filing-close');
    expect(document.querySelector('.seam-form'), 'the premise form comes back').not.toBeNull();
    expect(document.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    expectOneFrame({ floating: 1, close: 'seam-close' });
    expect(document.activeElement?.getAttribute('data-door')).toBe('duplicate');
  });
});
