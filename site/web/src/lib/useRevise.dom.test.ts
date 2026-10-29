// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seamDrafts } from './draft.ts';
import { seamKey } from './seam.ts';
import { closeSeam, currentSeam } from './useSeam.ts';
import { reviseFiling } from './useRevise.ts';

/**
 * BOOK-158 — «исправить» is one act, whatever surface it is pressed from.
 *
 * Two things must be true before the strip can show a form: the draft is in the store under the
 * key the strip reads, and the seam names the filing's own place (its chapter and block, or no
 * block for a premise). The third — a block the page has not loaded yet — brings the chapter
 * into view instead of inventing a paragraph to file against.
 */

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_refused',
    number: 1,
    chapter: 8,
    anchor: {
      blockId: 'ch08#aa11bb22',
      blockIndex: 0,
      quote: 'Её освещал яркий свет.',
      prefix: null,
      suffix: null,
      resolved: true,
    },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: 'testimony',
    status: 'rejected',
    frame: 'untouched',
    premise: false,
    reason: 'вне рамок: не про текст этой главы',
    hint: 'сформулируйте одно событие этой главы, которого ещё нет в тексте',
    revise: { allowed: true, at: null, attemptsLeft: 2, closed: false, blocked: null },
    createdAt: '2026-10-27T12:00:00Z',
    decidedAt: '2026-10-28T11:55:00Z',
    changeId: null,
    applied: null,
    refusal: 'auditor',
    attempt: null,
    ...overrides,
  };
}

/** The one browser fact `scrollToChapter` reads (jsdom has no matchMedia). */
function stubMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(stubMotion);

afterEach(() => {
  closeSeam();
  seamDrafts.drop('ch8:premise');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('a revision of a block filing (BOOK-158)', () => {
  it('writes the draft under the strip’s key and opens the seam on the filing’s own sentence', () => {
    const row = comment();
    const origin = document.createElement('button');
    reviseFiling(row, origin);

    const seam = currentSeam();
    expect(seam).toMatchObject({ chapter: 8, blockId: 'ch08#aa11bb22', origin });
    // The anchor is the filing's, not a new claim: no revision is sent with a revision.
    expect(seam?.anchor).toMatchObject({
      blockId: 'ch08#aa11bb22',
      baseRev: null,
      quote: 'Её освещал яркий свет.',
      word: 'Её',
    });
    expect(seam?.key).toBe(seamKey(8, 'ch08#aa11bb22', { text: 'Её освещал яркий свет.', start: 0, end: 22 }, null));
    // The draft is what makes the form open with the reader's text in it.
    expect(seamDrafts.read(seam?.key ?? '')).toMatchObject({
      body: 'в комнате должен быть свет, но не от лампы',
      proposed: 'в комнате должен быть свет, но не от лампы',
      kind: 'testimony',
      revisesId: row.id,
    });
  });

  it('opens a premise’s strip at the chapter, with the chapter’s own key', () => {
    const premise = comment({
      chapter: 65,
      premise: true,
      anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    });
    reviseFiling(premise);
    expect(currentSeam()).toMatchObject({ chapter: 65, blockId: null, key: 'ch65:premise', anchor: null });
    expect(seamDrafts.read('ch65:premise')).toMatchObject({ revisesId: premise.id, blockId: null });
    seamDrafts.drop('ch65:premise');
  });

  it('brings a chapter the page has not loaded into view, and leaves a loaded one alone', () => {
    const scrolled = document.createElement('div');
    const spy = vi.fn();
    // The jump is one `window.scrollTo` at the measured offset (`dom.ts` `scrollToChapter`):
    // the page, not the element, owns the arithmetic now.
    Object.defineProperty(window, 'scrollTo', { value: spy, configurable: true });
    scrolled.id = 'ch-8';
    document.body.append(scrolled);

    reviseFiling(comment());
    expect(spy).toHaveBeenCalledTimes(1);

    // The paragraph is on the page now (its mark carries the block id): nothing to scroll.
    spy.mockClear();
    const paragraph = document.createElement('p');
    paragraph.dataset.blockId = 'ch08#aa11bb22';
    document.body.append(paragraph);
    reviseFiling(comment());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('what «исправить» refuses to do (BOOK-158)', () => {
  it('opens nothing for a filing that was not refused', () => {
    const fresh = comment({ status: 'new', revise: undefined, hint: null, refusal: null });
    reviseFiling(fresh);
    expect(currentSeam()).toBeNull();
  });

  it('opens nothing when the filing has no place left to stand on', () => {
    // A stale anchor whose quote is gone names no sentence: the strip would have nothing to
    // open over, so no seam is made and no draft is written for one.
    const gone = comment({
      anchor: { blockId: 'ch08#aa11bb22', blockIndex: null, quote: null, prefix: null, suffix: null, resolved: false },
    });
    reviseFiling(gone);
    expect(currentSeam()).toBeNull();
    expect(seamDrafts.read(seamKey(8, 'ch08#aa11bb22', { text: '', start: 0, end: 0 }, null))).toBeNull();
  });
});
