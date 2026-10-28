// @vitest-environment jsdom
import type { CatalogEntry } from '@book/shared';
import { INTERVENTION_KINDS } from '@book/shared';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { emptyDraft, type SeamDraft } from '../lib/draft.ts';
import { filingNumber } from '../lib/filings.ts';
import { NOTE_ACTION_LABEL, NOTE_FATE_LINE, PREMISE_LABEL } from '../lib/kindChoices.ts';
import { InterventionForm } from './InterventionForm.tsx';

/**
 * BOOK-84 — a premise is not a remark.
 *
 * The strip above an empty chapter says «это замысел главы, а не замечание к тексту», and the
 * form underneath offered the note action unconditionally: two acts, one of them denied by the
 * sentence right above it. An empty chapter has no block, and that one fact decides both — no
 * note action there, and no spent-day recovery either, because the recovery is the note path's
 * door and a premise never spends the day's edit (the server skips the edit slot when a filing
 * carries no `proposedText`, and the premise path never sends one).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 9,
  part: 1,
  title: null,
  rev: 0,
  chars: 0,
  blocks: 0,
  written: false,
  basis: false,
  writtenAt: null,
  updatedAt: null,
  direction: 'forward',
};

const PARAGRAPH = { chapter: 8, blockId: 'ch08#aa11bb22', sentence: 'Её освещал ровный свет.', baseRev: 4 };
const PREMISE = { chapter: 9, blockId: null, sentence: '', baseRev: null };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function draftOf(origin: typeof PARAGRAPH | typeof PREMISE, overrides: Partial<SeamDraft> = {}): SeamDraft {
  return { ...emptyDraft(origin), ...overrides };
}

/** The form is controlled: the page owns the draft, so the test holds the state. */
function LiveForm({
  initial,
  signedIn = true,
  onOpenDuplicate,
}: {
  initial: SeamDraft;
  signedIn?: boolean;
  onOpenDuplicate?: (id: string) => void;
}) {
  const [draft, setDraft] = useState<SeamDraft>(initial);
  return (
    <InterventionForm
      entry={ENTRY}
      draft={draft}
      composer={EMPTY_COMPOSER}
      viewer={signedIn ? { signedIn: true, displayName: 'Аня' } : { signedIn: false, displayName: null }}
      onChange={setDraft}
      onPosted={() => undefined}
      {...(onOpenDuplicate === undefined ? {} : { onOpenDuplicate })}
    />
  );
}

function mount(initial: SeamDraft, options: { signedIn?: boolean; onOpenDuplicate?: (id: string) => void } = {}): void {
  act(() =>
    root.render(
      <LiveForm
        key={JSON.stringify(initial)}
        initial={initial}
        {...(options.signedIn === undefined ? {} : { signedIn: options.signedIn })}
        {...(options.onOpenDuplicate === undefined ? {} : { onOpenDuplicate: options.onOpenDuplicate })}
      />,
    ),
  );
}

function textarea(): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>('textarea.seam-text');
  if (element === null) throw new Error('no wording field');
  return element;
}

function radios(): NodeListOf<HTMLInputElement> {
  return container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
}

function fieldLabel(): string | null {
  return container.querySelector('label[for="seam-text-9"]')?.textContent ?? null;
}

describe('a premise is not a remark (BOOK-84)', () => {
  it('offers no note action in an empty chapter and no «замечание» at all', () => {
    mount(draftOf(PREMISE, { kind: 'decision', proposed: 'смена переходит на ночь' }));

    expect(container.querySelector('button.note-action')).toBeNull();
    expect(container.textContent).not.toMatch(/замечани/iu);
    // The premise keeps its own act: the grid, the premise label and «заложить замысел».
    expect(radios()).toHaveLength(INTERVENTION_KINDS.length);
    expect(fieldLabel()).toBe(PREMISE_LABEL);
    expect(container.querySelector('button.seam-submit')?.textContent).toBe('заложить замысел');
  });

  it('keeps the note action on a written chapter', () => {
    mount(draftOf(PARAGRAPH, { proposed: 'в абзаце повтор' }));

    const action = container.querySelector<HTMLButtonElement>('button.note-action');
    expect(action).not.toBeNull();
    expect(action?.textContent).toBe(NOTE_ACTION_LABEL);
    expect(action?.getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * The recovery under `EDIT_DAILY_LIMIT` opens the note path, so a premise gets no recovery:
   * the one thing the button does is the one thing a premise does not have. Were the refusal to
   * arrive anyway, the line and the reader's text stay, and the submit word stays the premise's
   * — the form never switches a premise into a note the strip denies.
   */
  it('offers no spent-day recovery on a premise, and keeps the text and the premise word', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ code: 'EDIT_DAILY_LIMIT', message: 'одна правка в сутки — сегодня уже была', retryAfterMs: 3_600_000 }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    mount(draftOf(PREMISE, { kind: 'decision', proposed: 'смена переходит на ночь' }));

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('.seam-error')?.textContent).toContain('одна правка в сутки');
    expect(container.querySelectorAll('button.seam-inline-action')).toHaveLength(0);
    expect(container.querySelector('button.note-action')).toBeNull();
    // The refusal spends nothing: the text is the reader's, and the act is still the premise.
    expect(textarea().value).toBe('смена переходит на ночь');
    expect(container.querySelector('button.seam-submit')?.textContent).toBe('заложить замысел');
    expect(container.textContent).not.toContain(NOTE_FATE_LINE);
  });
});

/**
 * BOOK-84 — the refusal path is the form's too.
 *
 * The clean form agreed with the strip and the errors still said «замечание»: the duplicate
 * line, the too-short line, the signed-out gate and the transport fallback all came from the
 * written chapter's table. One mapping (`refusalCopy`, `signinCopy`) answers for the surface,
 * and a written chapter keeps its own words exactly — the two are different filings, and both
 * lines must stay true: a duplicate is still a duplicate, a signed-out read still asks to sign
 * in for the act the form performs.
 */
describe('a premise’s refusals speak of the premise (BOOK-84)', () => {
  async function submit(): Promise<void> {
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
  }

  function errorText(): string {
    return container.querySelector('.seam-error')?.textContent ?? '';
  }

  it('says the chapter already holds a premise when the server answers DUPLICATE', async () => {
    // The prod 409 on an unwritten chapter: the refusal names the premise that exists, keeps
    // its door to that row, and never calls it a remark.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_x' }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const opened = vi.fn();
    mount(draftOf(PREMISE, { kind: 'decision', proposed: 'смена переходит на ночь' }), { onOpenDuplicate: opened });

    await submit();

    expect(errorText()).toContain('у главы уже есть замысел');
    // The number in the line is the row the door opens — one source, so they cannot diverge.
    expect(errorText()).toContain(`первый замысел — ${filingNumber({ id: 'cmt_x' })}`);
    expect(errorText()).not.toMatch(/замечани/iu);
    expect(container.textContent ?? '').not.toMatch(/замечани/iu);
    // A duplicate is still a duplicate: the door to the premise that exists is beside the line.
    const open = [...container.querySelectorAll<HTMLButtonElement>('button.seam-inline-action')].find(
      (button) => button.textContent?.trim() === 'открыть отправленное',
    );
    expect(open).not.toBeUndefined();
    act(() => open?.click());
    expect(opened).toHaveBeenCalledWith('cmt_x', open);
    // BOOK-63: the refusal spends nothing — the reader's text is still in the field.
    expect(textarea().value).toBe('смена переходит на ночь');
  });

  it('asks a signed-out reader to sign in to leave a premise', async () => {
    mount(draftOf(PREMISE), { signedIn: false });

    const gate = container.querySelector('.seam-signin');
    expect(gate?.textContent).toContain('войдите через Яндекс, чтобы заложить замысел');
    expect(gate?.textContent ?? '').not.toMatch(/замечани/iu);
    expect(gate?.querySelector('.seam-cta')?.getAttribute('href')).toBe('/auth/yandex/start');
  });

  it('keeps the written chapter’s note wording exactly as it was', async () => {
    mount(draftOf(PARAGRAPH), { signedIn: false });
    expect(container.querySelector('.seam-signin')?.textContent).toContain(
      'войдите через Яндекс, чтобы оставить замечание',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    mount(draftOf(PARAGRAPH, { proposed: 'в абзаце повтор' }));
    await submit();

    expect(errorText()).toContain('такое замечание уже отправлено');
  });
});
