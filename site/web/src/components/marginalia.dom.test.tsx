// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { GATE_WORDS, HELD_LINE } from '../lib/marginalia.ts';
import { hideRevision } from '../lib/useRevision.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-90 AC2 — the interaction at the sentence.
 *
 * An accepted tick and a note row open the **same** object; Esc closes it; focus goes back to
 * the trigger when the trigger is still on the page, and to the paragraph when the note was
 * replaced by its object. Opening another object closes the first: one open object per page.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

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

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 1, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: 'testimony',
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

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => hideRevision());
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(comments: readonly CommentDto[], text = TEXT, history = true): Promise<void> {
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId="ch08#aa11bb22"
        blockIndex={1}
        baseRev={3}
        text={text}
        blockCount={1}
        comments={comments}
        history={history}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
      />,
    );
  });
}

async function click(selector: string): Promise<void> {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  await act(async () => element.click());
}

describe('opening the revision object from the paragraph', () => {
  it('opens it from the accepted tick, then hands focus back to the tick on Esc', async () => {
    await mount([comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })]);
    await click('.filing-tick');
    expect(container.querySelector('.revision')?.getAttribute('aria-label')).toBe('запись №4Q7');
    expect(container.textContent).toContain('было');
    // The tick is not the note: it stays in the text while its object is open.
    expect(container.querySelector('.filing-tick')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.revision')).toBeNull();
    expect(document.activeElement?.className).toContain('filing-tick');
  });

  it('opens the landed record from the tick left on the rewritten sentence', async () => {
    // The sentence the change landed in no longer carries the stored quote: the tick stays at
    // its place, and the object prints the old wording as «было» and the new one as «стало».
    await mount(
      [
        comment({
          status: 'applied',
          applied: { chapter: 8, rev: 4 },
          anchor: { ...comment().anchor, prefix: 'Я вошёл в пустую комнату. ' },
        }),
      ],
      'Я вошёл в пустую комнату. Её освещал тусклый свет.',
    );
    await click('.filing-tick');
    const object = container.querySelector('.revision');
    expect(object?.textContent).toContain('было');
    expect(object?.textContent).toContain('«Её освещал яркий свет.»');
    expect(object?.textContent).toContain('стало');
    expect(object?.textContent).toContain('«Её освещал тусклый свет.»');
    expect(container.textContent).not.toContain('текст изменился после правки');
  });

  it('opens it from the note, replaces the note, and returns focus to the paragraph', async () => {
    await mount([comment()]);
    expect(container.querySelector('.margin-note')).not.toBeNull();
    await click('.margin-note');
    const object = container.querySelector('.revision');
    expect(object?.getAttribute('aria-label')).toBe('запись №4Q7');
    expect(container.textContent).toContain('ждёт');
    expect(container.textContent).toContain('попадёт в триаж');
    // The note was replaced by its object: one object in the slot, not two.
    expect(container.querySelector('.margin-note')).toBeNull();
    // A tap on the note never also opens the seam.
    expect(container.querySelector('.seam')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    // The trigger has left the page; the paragraph is the honest target, never the top.
    expect(document.activeElement).toBe(container.querySelector('.p'));
  });

  it('keeps one object per page: a second paragraph cannot hold its own', async () => {
    // Two paragraphs of one chapter, each with its own note.
    const first = comment({ id: 'cmt_a', anchor: { ...comment().anchor, blockId: 'ch08#aa11bb22' } });
    const second = comment({
      id: 'cmt_b',
      createdAt: '2026-10-22T12:03:00Z',
      anchor: { ...comment().anchor, blockId: 'ch08#cc33dd44' },
    });
    await act(async () => {
      root?.render(
        <>
          <ProseParagraph
            entry={ENTRY}
            blockId="ch08#aa11bb22"
            blockIndex={0}
            baseRev={3}
            text={TEXT}
            blockCount={1}
            comments={[first]}
            history
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: true, displayName: 'Филипп' }}
            onPosted={() => undefined}
          />
          <ProseParagraph
            entry={ENTRY}
            blockId="ch08#cc33dd44"
            blockIndex={1}
            baseRev={3}
            text={TEXT}
            blockCount={1}
            comments={[second]}
            history
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: true, displayName: 'Филипп' }}
            onPosted={() => undefined}
          />
        </>,
      );
    });
    const paragraphs = container.querySelectorAll('.p');
    await act(async () => paragraphs[0]?.querySelector<HTMLElement>('.margin-note')?.click());
    expect(container.querySelectorAll('.revision')).toHaveLength(1);
    await act(async () => paragraphs[1]?.querySelector<HTMLElement>('.margin-note')?.click());
    // The store moves the one object; the first paragraph's note is back, the object is the second's.
    expect(container.querySelectorAll('.revision')).toHaveLength(1);
    expect(container.querySelector('.revision')).not.toBeNull();
    expect(paragraphs[0]?.querySelector('.margin-note')).not.toBeNull();
    expect(paragraphs[1]?.querySelector('.margin-note')).toBeNull();
  });

  it('a held comment renders its check line under the waiting word', async () => {
    // BOOK-111 §5: a quarantined filing waits — and is never silent. With history off (the
    // prod state: no reader change yet) the note still prints the word and the check line.
    // BOOK-61: the line is the gate's own fixed sentence (`HELD_LINE`), never the guard's
    // taxonomy and never a stored `reason` — the two designs share the behaviour, one copy.
    await mount([comment({ status: 'quarantined' })], TEXT, false);
    const note = container.querySelector('.margin-note');
    expect(note).not.toBeNull();
    expect(note?.textContent ?? '').toContain('ждёт');
    expect(note?.textContent ?? '').toContain(HELD_LINE);
    // The word and the line sit in that order: what it is, then what happens next.
    const word = note?.querySelector('.margin-note-word')?.textContent ?? '';
    const next = note?.querySelector('.margin-note-next')?.textContent ?? '';
    expect(word).toBe('ждёт');
    expect(next).toBe(`${GATE_WORDS.held}: ${HELD_LINE}`);
  });

  it('keeps one object open: opening another closes the first', async () => {
    const second = comment({
      id: 'cmt_01J9Z8K5AA',
      anchor: { ...comment().anchor, quote: 'Я вошёл в пустую комнату.' },
      createdAt: '2026-10-22T12:03:00Z',
    });
    await mount([comment(), second]);
    const notes = container.querySelectorAll<HTMLElement>('.margin-note');
    expect(notes).toHaveLength(2);
    await act(async () => notes[0]?.click());
    expect(container.querySelectorAll('.revision')).toHaveLength(1);
    const firstNumber = container.querySelector('.revision')?.getAttribute('data-number');
    const remaining = container.querySelector<HTMLElement>('.margin-note');
    await act(async () => remaining?.click());
    expect(container.querySelectorAll('.revision')).toHaveLength(1);
    expect(container.querySelector('.revision')?.getAttribute('data-number')).not.toBe(firstNumber);
  });
});
