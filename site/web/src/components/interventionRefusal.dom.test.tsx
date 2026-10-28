// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER, type ComposerError } from '../lib/composer.ts';
import { emptyDraft, type SeamDraft } from '../lib/draft.ts';
import { InterventionForm } from './InterventionForm.tsx';

/**
 * BOOK-111 — the refusal is the strip's fact, not the form's mount.
 *
 * A panel opened from a refusal's own door collapses the strip and unmounts the form; the form
 * is rebuilt when the panel closes. The strip keeps the refusal through `initialError` (it comes
 * back with the line and its door) and hears every change through `onRefused` (a rebuilt form
 * never prints a refusal the form itself no longer holds).
 *
 * This file proves the form's half of that contract, in both directions and on all three paths
 * that can set or clear the line: the local `INVALID` check, the transport fallback, the
 * server's answer, and the recovery that clears it.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 8,
  part: 1,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 1,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const PARAGRAPH = { chapter: 8, blockId: 'ch08#refusal1', sentence: 'Её освещал ровный свет.', baseRev: 4 };
const PREMISE = { chapter: 9, blockId: null, sentence: '', baseRev: null };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type RefusalProps = {
  initialError?: ComposerError | null;
  onRefused?: (error: ComposerError | null) => void;
};

/** The form is controlled: the page owns the draft, so the harness holds it. */
function Harness({ initial, refusal }: { initial: SeamDraft; refusal: RefusalProps }) {
  const [draft, setDraft] = useState<SeamDraft>(initial);
  return (
    <InterventionForm
      entry={ENTRY}
      draft={draft}
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: true, displayName: 'Аня' }}
      onChange={setDraft}
      onPosted={() => undefined}
      onOpenDuplicate={() => undefined}
      {...refusal}
    />
  );
}

function mount(initial: SeamDraft, refusal: RefusalProps = {}): void {
  act(() => root.render(<Harness key={JSON.stringify(initial)} initial={initial} refusal={refusal} />));
}

function draftOf(origin: typeof PARAGRAPH | typeof PREMISE, overrides: Partial<SeamDraft> = {}): SeamDraft {
  return { ...emptyDraft(origin), ...overrides };
}

async function submit(): Promise<void> {
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

describe('the refusal outlives the form (BOOK-111)', () => {
  const DUPLICATE: ComposerError = { code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_x' };

  it('prints the refusal it was handed on the very first paint', () => {
    mount(draftOf(PREMISE, { proposed: 'А как?' }), { initialError: DUPLICATE });

    // BOOK-84: the draft is an empty chapter's premise, so the rebuilt form prints the premise's
    // line — the strip's own word — and not the written chapter's.
    expect(container.querySelector('.seam-error')?.textContent).toContain('у главы уже есть замысел');
    expect(container.querySelector('[data-door="duplicate"]')).not.toBeNull();
    // The refused text is kept: the line says the filing exists, not that the thought is lost.
    expect(container.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe('А как?');
  });

  it('reports the local INVALID refusal, not only the server’s', async () => {
    const refusals: Array<ComposerError | null> = [];
    mount(draftOf(PARAGRAPH), { onRefused: (error) => refusals.push(error) });

    await submit();

    expect(refusals.at(-1)?.code).toBe('INVALID');
  });

  it('reports the network fallback, which never reaches the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const refusals: Array<ComposerError | null> = [];
    mount(draftOf(PARAGRAPH, { proposed: 'свидетель видел, как свет включили' }), {
      onRefused: (error) => refusals.push(error),
    });

    await submit();

    expect(refusals.at(-1)).toMatchObject({ code: 'INVALID', message: 'сеть не ответила — попробуйте ещё раз' });
  });

  it('reports the server refusal and the clear when the spent edit turns into a note', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 'EDIT_DAILY_LIMIT', message: 'одна правка в сутки — сегодня уже была', retryAfterMs: 3_600_000 }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const refusals: Array<ComposerError | null> = [];
    mount(draftOf(PARAGRAPH, { kind: 'testimony', proposed: 'свидетель видел, как свет включили' }), {
      onRefused: (error) => refusals.push(error),
    });

    await submit();
    expect(refusals.at(-1)?.code).toBe('EDIT_DAILY_LIMIT');

    const recovery = [...container.querySelectorAll<HTMLButtonElement>('button.seam-inline-action')].find(
      (button) => button.textContent?.trim() === 'оставить замечание',
    );
    expect(recovery, 'the day’s edit is spent, not the reader’s thought').not.toBeUndefined();
    act(() => recovery?.click());

    // The clear is reported too: the strip must not print a refusal the form no longer has.
    expect(refusals.at(-1)).toBeNull();
    expect(container.querySelector('.seam-error')).toBeNull();
  });

  it('reports the clear on a successful post, so the strip’s refusal does not outlive it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              comment: { id: 'cmt_1' } satisfies Partial<CommentDto>,
              remaining: { perHour: 10, remaining: 9, resetAt: null, editsPerDay: 1, editsRemaining: 1, editsResetAt: null },
              queue: { depth: 0 },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const refusals: Array<ComposerError | null> = [];
    mount(draftOf(PARAGRAPH, { proposed: 'свидетель видел, как свет включили' }), {
      initialError: DUPLICATE,
      onRefused: (error) => refusals.push(error),
    });

    await submit();

    expect(refusals.at(-1)).toBeNull();
    expect(container.querySelector('.seam-error')).toBeNull();
  });
});
