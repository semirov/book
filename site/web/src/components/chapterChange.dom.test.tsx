// @vitest-environment jsdom
import type { ChangeDto, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChangeCache } from '../lib/changeCache.ts';
import { currentChapterChange, openChapterChange, resetRecordMemory } from '../lib/record.ts';
import { ChapterChange } from './ChapterChange.tsx';

/**
 * A change with no sentence (a premise, an author's own change, a lost paragraph) is a row of
 * the chapter, not a dialog: the chapter prints the same section after its premise row, with
 * the numeral as the header value and one close. Escape and the close both put it away.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CHANGE: ChangeDto = {
  premiseLanded: false,
  id: 'chg_1',
  seq: 9,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'у комнаты должна быть своя дверь',
  premise: true,
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 0 },
  scopeHint: 'chapter',
  status: 'done',
  outcome: 'applied',
  reason: null,
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
  startedAt: null,
  decidedAt: '2026-10-25T12:05:00Z',
};

const FILING: CommentDto = {
  attempt: null,
  id: 'cmt_1',
  number: 2,
  chapter: 8,
  anchor: { blockId: null, blockIndex: null, quote: 'у комнаты должна быть своя дверь', prefix: null, suffix: null, resolved: false },
  author: 'Аня',
  authorColor: '#2e6274',
  body: 'у комнаты должна быть своя дверь',
  interventionKind: null,
  proposedText: null,
  premise: true,
  status: 'applied',
  frame: 'untouched',
  reason: null,
  createdAt: '2026-10-25T12:04:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
  changeId: 'chg_1',
  applied: { chapter: 8, rev: 1 },
  refusal: null,
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetChangeCache();
  resetRecordMemory();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/changes/chg_1')) {
        return new Response(JSON.stringify(CHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }),
  );
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetChangeCache();
  resetRecordMemory();
});

async function settle(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }
}

describe('a change with no sentence stands on the chapter’s row', () => {
  it('prints the numeral, the filing’s sentence and the change’s own words in the flow', async () => {
    window.history.replaceState(null, '', '/?change=chg_1');
    await act(async () => {
      openChapterChange({ chapter: 8, changeId: 'chg_1' });
      root?.render(<ChapterChange chapter={8} comments={[FILING]} />);
    });
    await settle();

    const section = container.querySelector('.rec-chapter-change');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('правка');
    expect(section?.textContent).toContain('009');
    expect(section?.textContent).toContain('«у комнаты должна быть своя дверь»');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes with its own ✕ and with Escape, and takes the address with it', async () => {
    window.history.replaceState(null, '', '/?change=chg_1');
    await act(async () => {
      openChapterChange({ chapter: 8, changeId: 'chg_1' });
      root?.render(<ChapterChange chapter={8} comments={[]} />);
    });
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.rec-change-close')?.click();
    });
    expect(currentChapterChange()).toBeNull();
    expect(window.location.search).toBe('');

    await act(async () => {
      openChapterChange({ chapter: 8, changeId: 'chg_1' });
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(currentChapterChange()).toBeNull();
  });
});
