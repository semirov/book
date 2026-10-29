// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { hideWord } from '../lib/useWord.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ChapterArticle } from './ChapterArticle.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-111 (owner, 2026-10-27) — **one close on screen, whatever is open**.
 *
 * This file enumerates the page's surface combinations rather than one feature: the strip, the
 * strip with its form, the strip with its form under a word's panel or under the filing its own
 * refusal names, the same three on an empty chapter's premise, the strip under a card and the
 * revision object. Each one may show exactly one floating frame and exactly one close, and no
 * two close-carrying frames may stand together — the owner's screenshot was two of them.
 *
 * Every combination is mounted for real (no store poked from the test), and each close is
 * asserted by where focus lands — the door, the strip's trigger or nothing at all — not only by
 * what the DOM holds.
 *
 * The revision object is an inline margin object, so the prescribed selector
 * (`.filing-panel, [data-open="true"]`) counts 0 for it on purpose: the one frame is asserted by
 * its own class in that case.
 *
 * BOOK-128 comment #3815 — the word's record and the phrase's facts are **marginalia** now
 * (`ProvBlock` under the strip's row, `SentenceBlock` beside the phrase): they carry no close, no
 * CTA and no `z-index`, so they are not floating frames and the enumeration counts 0 for them.
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
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const BLOCK_ID = 'ch08#oneclose';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

/** The two questions the enumeration asks of the DOM. */
const FLOATING = '.filing-panel, [data-open="true"]';
const CLOSES = '.seam-close, .prov-close, .filing-close, .rec-close';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    number: 1,
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: 'Я вошёл в пустую комнату.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    refusal: null,
    attempt: null,
    frame: null,
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

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
    hideWord();
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
    // A door may read the log (the word's facts): give the request a task to settle in.
    await new Promise((resolve) => setTimeout(resolve, 0));
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
          blockCount={40}
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

/** One floating frame (or none, where the frame is inline) and exactly one close. */
function expectOneFrame(expected: { floating: number; close: string; frame?: string }): void {
  expect(document.querySelectorAll(FLOATING).length, 'floating frames').toBe(expected.floating);
  expect(document.querySelectorAll(CLOSES).length, 'close controls').toBe(1);
  const control = document.querySelector(CLOSES);
  expect(control?.className, 'the close belongs to the one frame').toBe(expected.close);
  if (expected.frame !== undefined) expect(document.querySelector(expected.frame), expected.frame).not.toBeNull();
}

describe('one close on screen for every surface combination', () => {
  it('the record is the sentence’s only surface; the premise card is the one exception', async () => {
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

    // 3 — the word's facts are the strip's own body: still one close, nothing floating.
    await mount();
    await click('.seam-prov');
    expect(document.querySelector('.prov-block')).not.toBeNull();
    expectOneFrame({ floating: 0, close: 'seam-close', frame: '.prov-block' });
    await restart();

    // 4 — a filing row opens the record: the strip goes, no card, and the record's ✕ is the
    // only close on the page.
    await mount([comment()]);
    await click('.seam-filing');
    expect(document.querySelector('.filing-panel')).toBeNull();
    expect(document.querySelector('.rec')?.getAttribute('data-body')).toBe('filing');
    expectOneFrame({ floating: 0, close: 'rec-close', frame: '.rec' });
    await restart();

    // 5 — a landed tick opens the same record, and closes the strip and the word's body.
    await mount([comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })]);
    await click('.seam-prov');
    expect(document.querySelector('.prov-block')).not.toBeNull();
    await click('.filing-tick');
    expect(document.querySelector('.prov-block')).toBeNull();
    expect(document.querySelector('.seam')).toBeNull();
    expect(document.querySelector('.filing-panel')).toBeNull();
    expectOneFrame({ floating: 0, close: 'rec-close', frame: '.rec' });
    await restart();

    // 6 — the strip with its form under the word's facts: two half-written surfaces never
    // coexist, so the form is the surface that goes — the strip's ✕ closes the rest.
    await mount();
    await click('.seam-cta');
    expect(document.querySelector('.seam-form')).not.toBeNull();
    await click('.seam-prov');
    expect(document.querySelector('.seam-form'), 'the form goes under the facts').toBeNull();
    expectOneFrame({ floating: 0, close: 'seam-close', frame: '.prov-block' });
    await click('.seam-prov');
    expect(document.querySelector('.prov-block')).toBeNull();
    expect(document.activeElement?.getAttribute('data-door')).toBe('prov');
    expectOneFrame({ floating: 0, close: 'seam-close' });
    await restart();

    // 7 — the refusal’s own door opens the record: the card is gone from the reading path.
    refusing(comment({ id: 'cmt_x' }));
    await mount();
    await click('.seam-cta');
    typeInto('textarea.seam-text', 'Свет был включён до меня, и это видно по тени.');
    await submit();
    expect(document.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    await click('[data-door="duplicate"]');
    expect(document.querySelector('.seam-form')).toBeNull();
    expect(document.querySelector('.filing-panel')).toBeNull();
    expectOneFrame({ floating: 0, close: 'rec-close', frame: '.rec' });
    await restart();

    // 8 — the named exception: an empty chapter’s premise has no sentence, so its filing keeps
    // the one card. It is the only surface with a card and it closes to nothing else.
    refusing(
      comment({
        id: 'cmt_x',
        number: 2,
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
    expect(document.querySelector('.seam')).toBeNull();
    expectOneFrame({ floating: 1, close: 'filing-close', frame: '.filing-panel' });
    await click('.filing-close');
    expect(document.querySelector('.filing-panel')).toBeNull();
  });
});
