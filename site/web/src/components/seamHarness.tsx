import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { seamDrafts } from '../lib/draft.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-33 — the one harness the seam's DOM suites share: the entry a written ch01 has, the
 * reader's filing, the controlled-field setter, and one mounted paragraph per test. `TEXT` *is*
 * ch01's canon sentence (BOOK-137), so the paragraph that renders as the frame is this one.
 */

export const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 1,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

export const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
export const BLOCK_ID = 'ch01#aa11bb22';

export function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 1,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    frame: 'untouched',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

/** A controlled field needs the native setter, or React never sees the change. */
export function typeInto(selector: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

/**
 * The draft store is module state, keyed by the seam: a test that types drops the draft the
 * previous one kept, so «is the form open» is never inherited.
 */
export function clearDraft(entry: CatalogEntry, text: string, blockId: string): void {
  const anchor = anchorFor({ text, blockId, baseRev: entry.rev, offset: 0 });
  if (anchor !== null) seamDrafts.drop(seamKey(entry.n, blockId, anchor.sentence, entry.rev));
}

/** Open the form unless a kept draft already did. */
export async function openForm(): Promise<void> {
  if (document.querySelector('.seam-form') !== null) return;
  await act(async () => {
    (document.querySelector('.seam-cta') as HTMLElement).click();
  });
}

let root: Root | null = null;

/** Pin the environment this suite needs: React's act flag, the observer, one root per test. */
export function installSeamDom(): void {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    root = createRoot(document.body.appendChild(document.createElement('div')));
  });

  afterEach(async () => {
    // Closing the seam is a store update, and the paragraphs still subscribed to it: both
    // belong in one `act`, or React reports every update as one made outside it.
    await act(async () => {
      closeSeam();
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });
}

export type ParagraphProps = {
  entry?: CatalogEntry;
  blockId?: string;
  text?: string;
  /** Paragraphs the chapter holds: ch01's frame sits in the first one (BOOK-137). */
  blockCount?: number;
  comments?: readonly CommentDto[];
  history?: boolean;
  onPosted?: (comment: CommentDto) => void;
};

/** The paragraph is the unit that renders the strip, so a fixed entry drives the freeze. */
export async function mountParagraph(props: ParagraphProps = {}): Promise<void> {
  const entry = props.entry ?? ENTRY;
  const blockId = props.blockId ?? BLOCK_ID;
  const text = props.text ?? TEXT;
  const anchor = anchorFor({ text, blockId, baseRev: entry.rev, offset: 0 });
  const origin = document.createElement('div');
  origin.tabIndex = -1;
  origin.setAttribute('data-origin', 'true');
  document.body.append(origin);
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={entry}
        blockId={blockId}
        blockIndex={0}
        baseRev={entry.rev}
        text={text}
        blockCount={props.blockCount ?? 1}
        comments={props.comments ?? []}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={props.onPosted ?? (() => undefined)}
        history={props.history ?? true}
      />,
    );
  });
  // Open the seam after the paragraph subscribed: the store update then lands inside act.
  await act(async () => {
    openSeam({ chapter: entry.n, blockId, key: seamKey(entry.n, blockId, anchor!.sentence, entry.rev), anchor, origin });
  });
}