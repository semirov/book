// @vitest-environment jsdom
import type { ChangeDto, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RevisionObject } from './RevisionObject.tsx';

/**
 * BOOK-90 AC2 — the revision object: what an accepted mark opens.
 *
 * One component, two placements (the placement is a stylesheet step, asserted in the CSS
 * contract). Here: the head, who and when, the applied revision, «было»/«стало» resolved on
 * the paragraph's own text, the wave and the reach, the door into the record, `Esc`, focus,
 * and one fetch per change — never one per open.
 */

const api = vi.hoisted(() => ({ getChange: vi.fn() }));
vi.mock('../api.ts', () => ({ getChange: api.getChange }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
/** The same paragraph after the change landed: the sentence was rewritten. */
const CHANGED = 'Я вошёл в пустую комнату. Её освещал тусклый свет.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: {
      blockId: 'ch08#aa11bb22',
      blockIndex: 1,
      quote: 'Её освещал яркий свет.',
      prefix: 'Я вошёл в пустую комнату. ',
      suffix: '',
      resolved: true,
    },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'свет был включён до меня',
    proposedText: null,
    interventionKind: 'testimony',
    status: 'applied',
    frame: 'untouched',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: '2026-10-21T12:04:00Z',
    changeId: 'chg_1',
    applied: { chapter: 8, rev: 4 },
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

function change(overrides: Partial<ChangeDto> = {}): ChangeDto {
  return {
    premiseLanded: false,
    id: 'chg_1',
    seq: 14,
    kind: 'accepted_comment',
    interventionKind: 'testimony',
    chapter: 8,
    intent: 'свет включили до него',
    premise: false,
    source: { commentId: 'cmt_01J9Z8K4Q7', author: 'Аня' },
    base: { rev: 3 },
    scopeHint: 'phrase',
    status: 'done',
    outcome: 'applied',
    reason: null,
    position: null,
    relevance: null,
    cascade: {
      id: 'csc_1',
      status: 'closed',
      outcome: 'consistent',
      wave: 2,
      depth: { forward: 1, backward: 1 },
      chaptersChecked: [9],
      chaptersRewritten: [8, 7],
      seams: [],
      wings: {
        down: { frontier: 7, wave: 2, state: 'settled', reached: [7] },
        up: { frontier: 9, wave: 2, state: 'settled', reached: [9] },
      },
      modes: [],
      gates: { cycles: 1, findingSurvived: false },
      tokens: { total: 100 },
      ms: 1_000,
    },
    modes: [],
    steps: [
      {
        seq: 1,
        wave: 0,
        wing: null,
        chapter: 8,
        pass: 'change',
        boundary: 8,
        outcome: 'rewritten',
        revBefore: 3,
        revAfter: 4,
        seamsIn: [],
        seamsOut: [],
        charsDelta: 10,
        note: null,
        at: '2026-10-25T12:00:00Z',
        cycles: 1,
        findingSurvived: false,
      },
      {
        seq: 2,
        wave: 1,
        wing: 'upward',
        chapter: 9,
        pass: 'cascade',
        boundary: 9,
        outcome: 'rewritten',
        revBefore: 1,
        revAfter: 2,
        seamsIn: [],
        seamsOut: [],
        charsDelta: 4,
        note: null,
        at: '2026-10-25T12:01:00Z',
        cycles: 0,
        findingSurvived: false,
      },
    ],
    appliedRevs: [{ chapter: 8, rev: 4 }, { chapter: 9, rev: 2 }],
    cost: null,
    scienceCheck: 'passed',
    history: null,
    enqueuedAt: '2026-10-25T11:59:00Z',
    startedAt: '2026-10-25T12:00:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  api.getChange.mockReset();
  api.getChange.mockResolvedValue(change());
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(row: CommentDto, onClose: () => void = () => undefined, text = TEXT): Promise<void> {
  await act(async () => {
    root?.render(<RevisionObject comment={row} text={text} onClose={onClose} />);
  });
  // The change is a promise: one more turn settles the fetch inside `act`.
  await act(async () => {
    await Promise.resolve();
  });
}

const text = (): string => container.textContent ?? '';

describe('the revision object of a landed change', () => {
  it('prints the numeral, the word, who and when, the revision, было and стало', async () => {
    // The paragraph's own sentence at the anchor is the applied text — never `proposedText`.
    await mount(comment(), () => undefined, CHANGED);
    expect(text()).toContain('№4Q7');
    expect(text()).toContain('внесено');
    expect(text()).toContain('Аня');
    expect(text()).toContain('21.10');
    expect(text()).toContain('ревизия 4');
    expect(text()).toContain('было');
    expect(text()).toContain('«Её освещал яркий свет.»');
    expect(text()).toContain('стало');
    expect(text()).toContain('«Её освещал тусклый свет.»');
    expect(text()).not.toContain('Свет был включён до меня.');
    expect(text().indexOf('«Её освещал тусклый свет.»')).toBeGreaterThan(text().indexOf('«Её освещал яркий свет.»'));
  });

  it('prints no стало where the sentence at the place is unchanged', async () => {
    await mount(comment());
    expect(text()).toContain('было');
    expect(text()).toContain('«Её освещал яркий свет.»');
    expect(text()).not.toContain('стало');
    expect(text()).not.toContain('текст изменился после правки');
  });

  it('names the wave only from the second (BOOK-59) and the reach of a landed change', async () => {
    await mount(comment());
    // `waveCopy` is the project's one wave rule: below 2 it prints nothing at all.
    expect(text()).toContain('волна 2');
    // The reach is the change's own applied revisions, through `reachCopy`.
    expect(text()).toContain('дошло до глав 9');
    expect(text()).not.toContain('волна 1');
  });

  it('says the text changed when the anchor no longer resolves, and invents no sentence', async () => {
    await mount(
      comment({ anchor: { ...comment().anchor, resolved: false } }),
    );
    expect(text()).toContain('текст изменился после правки');
    expect(text()).not.toContain('стало');
  });

  it('opens the record through the existing прицел link', async () => {
    await mount(comment());
    const door = container.querySelector<HTMLAnchorElement>('.revision-door');
    expect(door?.textContent).toContain('прицел →');
    expect(door?.getAttribute('href')).toBe('#правка-chg_1');
  });

  it('is a non-modal dialog, focusable, and takes focus on open', async () => {
    await mount(comment());
    const dialog = container.querySelector<HTMLElement>('.revision');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('false');
    expect(dialog?.getAttribute('aria-label')).toBe('запись №4Q7');
    expect(dialog?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
  });

  it('closes on Esc and on ✕, and never on its own', async () => {
    const onClose = vi.fn();
    await mount(comment(), onClose);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.revision-close')?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('fetches a change once, not once per open', async () => {
    await mount(comment({ id: 'cmt_a', changeId: 'chg_cache' }));
    await act(async () => root?.unmount());
    root = createRoot(container);
    // The same change id, a fresh object: the module cache answers.
    await mount(comment({ id: 'cmt_b', changeId: 'chg_cache' }));
    const ids = api.getChange.mock.calls.map((call) => call[0] as string);
    expect(ids.filter((id) => id === 'chg_cache')).toHaveLength(1);
  });

  it('prints no invented wave when the change cannot be reached', async () => {
    api.getChange.mockRejectedValue(new Error('offline'));
    await mount(comment({ changeId: 'chg_missing' }));
    expect(text()).toContain('ревизия 4');
    expect(text()).not.toContain('волна');
    expect(text()).not.toContain('дошло до глав');
    // The door is still the record's own id, not a fabricated card.
    expect(container.querySelector('.revision-door')?.getAttribute('href')).toBe('#правка-chg_missing');
  });
});

describe('the revision object of a filing that has not landed', () => {
  it('shows the word, the next line and the quote — no было/стало table', async () => {
    await mount(comment({ status: 'accepted', applied: null, changeId: null }));
    expect(text()).toContain('идёт');
    expect(text()).toContain('правка в очереди на запись');
    expect(text()).toContain('«Её освещал яркий свет.»');
    expect(text()).not.toContain('было');
    expect(text()).not.toContain('стало');
    expect(container.querySelector('.revision-door')).toBeNull();
    expect(api.getChange).not.toHaveBeenCalled();
  });
});
