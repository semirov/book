// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { INTERVENTION_KINDS } from '@book/shared';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { emptyDraft, type SeamDraft } from '../lib/draft.ts';
import {
  KIND_PREMISE_PLACEHOLDERS,
  KIND_WORDING_LABELS,
  KIND_WORDING_PLACEHOLDERS,
  NOTE_BUDGET_LINE,
  NOTE_FATE_LINE,
  NOTE_FIELD_LABEL,
  NOTE_PLACEHOLDER,
  PREMISE_LABEL,
  WORDING_LABEL_NEUTRAL,
  WORDING_PLACEHOLDER_NEUTRAL,
} from '../lib/kindChoices.ts';
import { SUBMIT_LINE } from '../lib/terms.ts';
import { InterventionForm } from './InterventionForm.tsx';

/**
 * BOOK-64 — the form a signed-in reader meets: no widget, no iframe, no token, and a submit
 * that goes out on identity alone. The server test proves the 201; this proves the page does
 * not wait for a challenge the deployment no longer runs.
 *
 * BOOK-57 — the form asks a different question per kind, and the note is a quiet action under
 * the submit rather than a fifth row: the grid, «что это меняет» and the wording field belong
 * to the intervention path only, and a note sends one field and no kind.
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

/**
 * The form is controlled: the page owns the draft (the seam keeps it in its own store), so a
 * test that types or picks must hold the state, not pass a frozen object.
 */
function LiveForm({
  initial,
  onPosted,
  onOpenDuplicate,
}: {
  initial: SeamDraft;
  onPosted?: (comment: CommentDto) => void;
  onOpenDuplicate?: (id: string, origin: HTMLElement) => void;
}) {
  const [draft, setDraft] = useState<SeamDraft>(initial);
  return (
    <InterventionForm
      entry={ENTRY}
      draft={draft}
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: true, displayName: 'Аня' }}
      onChange={setDraft}
      onPosted={onPosted ?? (() => undefined)}
      {...(onOpenDuplicate === undefined ? {} : { onOpenDuplicate })}
    />
  );
}

function mount(
  initial: SeamDraft,
  onPosted?: (comment: CommentDto) => void,
  onOpenDuplicate?: (id: string, origin: HTMLElement) => void,
): void {
  act(() =>
    root.render(
      <LiveForm
        key={JSON.stringify(initial)}
        initial={initial}
        {...(onPosted === undefined ? {} : { onPosted })}
        {...(onOpenDuplicate === undefined ? {} : { onOpenDuplicate })}
      />,
    ),
  );
}

function renderForm(body: string): ReturnType<typeof emptyDraft> {
  const draft = { ...emptyDraft(PARAGRAPH), body };
  mount(draft);
  return draft;
}

function fieldLabel(): string | null {
  return container.querySelector('label[for="seam-text-8"]')?.textContent ?? null;
}

function textarea(): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>('textarea.seam-text');
  if (element === null) throw new Error('no wording field');
  return element;
}

function noteAction(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>('button.note-action');
  if (element === null) throw new Error('no note action');
  return element;
}

function radios(): NodeListOf<HTMLInputElement> {
  return container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
}

/** A controlled field needs the native setter, or React never sees the change. */
function typeInto(selector: string, value: string): void {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

function bodyInput(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('input.seam-input');
  if (element === null) throw new Error('no «что это меняет» field');
  return element;
}

describe('the intervention form without a challenge (BOOK-64)', () => {
  it('renders no captcha block, no iframe and no provider word', () => {
    renderForm('свет не от лампы');
    expect(container.querySelector('.seam-captcha')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.innerHTML).not.toMatch(/проверка/iu);
    expect(container.innerHTML).not.toMatch(/turnstile|hcaptcha|cloudflare/iu);
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('submits when the reader is signed in and the text is valid, with no token in the body', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          comment: { id: 'cmt_1' },
          remaining: { perHour: 10, remaining: 9, resetAt: null, editsPerDay: 1, editsRemaining: 1, editsResetAt: null },
          queue: { depth: 0 },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const posted = vi.fn();
    mount(draftOf(PARAGRAPH, { body: 'свет не от лампы' }), posted);

    const button = container.querySelector('button.seam-submit') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ chapter: 8, body: 'свет не от лампы', blockId: 'ch08#aa11bb22' });
    expect(body).not.toHaveProperty('captchaToken');
    // BOOK-111: the form hands the caller the posted DTO itself, not its id.
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ id: 'cmt_1' }));
  });

  /**
   * BOOK-58 — the one line under the submit button. It is the exact text a submission accepts
   * (the server hashes `acceptedTermsText()`), and it is an offer to assign the right, never a
   * licence: no licence word may appear under the button, in any state of the form.
   */
  it('prints exactly the submit line under the button, with no licence promise (BOOK-58)', () => {
    for (const noteOnly of [false, true]) {
      mount(draftOf(PARAGRAPH, { body: 'свет не от лампы', noteOnly }));
      const line = container.querySelector('p.fine.seam-licence');
      expect(line, `licence line, noteOnly=${String(noteOnly)}`).not.toBeNull();
      const text = line?.textContent ?? '';
      // The sentence first, then the door to the rules and nothing else.
      expect(text.replace(SUBMIT_LINE, '').trim()).toBe('правила →');
      expect(text).not.toMatch(/лиценз/iu);
    }
  });
});

describe('one question per kind (BOOK-57)', () => {
  it('asks a paragraph’s own label and placeholder for each of the four kinds', () => {
    for (const kind of INTERVENTION_KINDS) {
      mount(draftOf(PARAGRAPH, { kind }));
      expect(fieldLabel(), kind).toBe(KIND_WORDING_LABELS[kind]);
      expect(textarea().placeholder, kind).toBe(KIND_WORDING_PLACEHOLDERS[kind]);
    }
  });

  it('keeps one premise label and changes only the placeholder', () => {
    for (const kind of INTERVENTION_KINDS) {
      mount(draftOf(PREMISE, { kind }));
      expect(fieldLabel(), kind).toBe(PREMISE_LABEL);
      expect(textarea().placeholder, kind).toBe(KIND_PREMISE_PLACEHOLDERS[kind]);
    }
  });

  it('says what the field waits for before a kind is chosen', () => {
    mount(draftOf(PARAGRAPH));
    expect(fieldLabel()).toBe(WORDING_LABEL_NEUTRAL);
    expect(textarea().placeholder).toBe(WORDING_PLACEHOLDER_NEUTRAL);

    // A premise keeps its label; only the placeholder is the neutral one.
    mount(draftOf(PREMISE));
    expect(fieldLabel()).toBe(PREMISE_LABEL);
    expect(textarea().placeholder).toBe(WORDING_PLACEHOLDER_NEUTRAL);
  });

  it('asks for the text of the document, not for prose', () => {
    mount(draftOf(PARAGRAPH, { kind: 'document' }));
    expect(fieldLabel()).toBe('текст бумаги');
    expect(textarea().placeholder).toBe('кто выдал · номер · кому адресован');
    // The wording field is the paragraph's own, six rows high: the placeholder moves no layout.
    expect(textarea().rows).toBe(6);
  });
});

describe('the note path (BOOK-57)', () => {
  it('opens under the submit, leaves the grid, and stays the way back', () => {
    mount(draftOf(PARAGRAPH, { proposed: 'в абзаце повтор' }));
    expect(radios()).toHaveLength(INTERVENTION_KINDS.length);
    expect(noteAction().getAttribute('aria-pressed')).toBe('false');

    // The reader's intervention line, typed by hand in «что это меняет».
    typeInto('input.seam-input', 'свет не от лампы');
    expect(bodyInput().value).toBe('свет не от лампы');

    act(() => noteAction().click());

    // The note block: the fate line, then the field, then the budget line — in that order.
    const text = container.textContent ?? '';
    const fate = text.indexOf(NOTE_FATE_LINE);
    const label = text.indexOf(NOTE_FIELD_LABEL);
    const budget = text.indexOf(NOTE_BUDGET_LINE);
    expect(fate, 'the fate line is in the note block').toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(fate);
    expect(budget).toBeGreaterThan(label);
    expect(fieldLabel()).toBe(NOTE_FIELD_LABEL);
    expect(textarea().placeholder).toBe(NOTE_PLACEHOLDER);
    expect(textarea().rows).toBe(4);
    expect(noteAction().getAttribute('aria-pressed')).toBe('true');
    // The reader's wording survives the switch.
    expect(textarea().value).toBe('в абзаце повтор');
    expect(container.querySelector('button.seam-submit')?.textContent).toBe('оставить замечание');

    // No grid, no state line, no «что это меняет».
    expect(radios()).toHaveLength(0);
    expect(container.textContent).not.toContain('тип не выбран');
    expect(container.textContent).not.toContain('что это меняет');
    expect(container.querySelector('.kind-state')).toBeNull();
    expect(container.querySelector('input.seam-input')).toBeNull();

    // The action stays visible and closes the note on the second press — with the draft whole:
    // the intervention line the reader typed is still there, and so is the wording.
    act(() => noteAction().click());
    expect(noteAction().getAttribute('aria-pressed')).toBe('false');
    expect(radios()).toHaveLength(INTERVENTION_KINDS.length);
    expect(container.textContent).not.toContain(NOTE_FATE_LINE);
    expect(bodyInput().value).toBe('свет не от лампы');
    expect(textarea().value).toBe('в абзаце повтор');
    expect(fieldLabel()).toBe(WORDING_LABEL_NEUTRAL);
  });

  it('keeps the picked kind and the intervention line through the note', () => {
    mount(draftOf(PARAGRAPH, { kind: 'testimony', body: 'свет не от лампы', proposed: 'свидетель видел' }));

    act(() => noteAction().click());
    expect(radios()).toHaveLength(0);

    act(() => noteAction().click());
    const checked = [...radios()].filter((radio) => radio.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0]?.value).toBe('testimony');
    expect(bodyInput().value).toBe('свет не от лампы');
    expect(fieldLabel()).toBe(KIND_WORDING_LABELS.testimony);
    expect(textarea().value).toBe('свидетель видел');
  });

  it('cannot send a note that is only whitespace', () => {
    mount(draftOf(PARAGRAPH));
    act(() => noteAction().click());

    typeInto('textarea.seam-text', '   ');
    expect((container.querySelector('button.seam-submit') as HTMLButtonElement).disabled).toBe(true);

    typeInto('textarea.seam-text', '  повтор  ');
    expect((container.querySelector('button.seam-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the note field alone: no wording, no kind', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          comment: { id: 'cmt_note' },
          remaining: { perHour: 10, remaining: 9, resetAt: null, editsPerDay: 1, editsRemaining: 1, editsResetAt: null },
          queue: { depth: 0 },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const posted = vi.fn();
    // A stale intervention line stays in the draft while the note is open — and is not sent.
    mount(draftOf(PARAGRAPH, { body: 'свет не от лампы', proposed: 'в абзаце повтор' }), posted);

    act(() => noteAction().click());
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ chapter: 8, body: 'в абзаце повтор' });
    expect(sent).not.toHaveProperty('proposedText');
    expect(sent).not.toHaveProperty('interventionKind');
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ id: 'cmt_note' }));
  });

  it('offers the note when the day’s edit is spent', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'EDIT_DAILY_LIMIT', message: 'одна правка в сутки — сегодня уже была', retryAfterMs: 3_600_000 }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    mount(draftOf(PARAGRAPH, { kind: 'testimony', proposed: 'свидетель видел, как свет включили' }));

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const recovery = [...container.querySelectorAll('button.seam-inline-action')].find(
      (button) => button.textContent?.trim() === 'оставить замечание',
    );
    expect(recovery, 'the recovery action carries the new label').not.toBeUndefined();

    act(() => (recovery as HTMLButtonElement).click());
    expect(noteAction().getAttribute('aria-pressed')).toBe('true');
    expect(radios()).toHaveLength(0);
    expect(container.textContent).toContain(NOTE_FATE_LINE);
    // The refused wording is kept: the day was spent, not the thought.
    expect(textarea().value).toBe('свидетель видел, как свет включили');
    // The recovery and the note submit are one word, from one function.
    expect(container.querySelector('button.seam-submit')?.textContent).toBe('оставить замечание');
  });
});

describe('a refusal that names the existing filing (BOOK-111)', () => {
  it('a duplicate answer prints the line and opens the existing filing', async () => {
    // BOOK-111 — the prod 409: the reader's own filing already exists. The line must be on the
    // page (the strip, `role="alert"`), and the 409's `commentId` must give a way to it.
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_x' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const opened = vi.fn();
    mount(draftOf(PREMISE, { proposed: 'А как?' }), undefined, opened);

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const alert = container.querySelector('.seam-error');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('такое замечание уже отправлено');
    // The refused text is kept: the line says the filing exists, not that the thought is lost.
    expect(container.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe('А как?');

    const open = [...container.querySelectorAll<HTMLButtonElement>('button.seam-inline-action')].find(
      (button) => button.textContent?.trim() === 'открыть отправленное',
    );
    expect(open, 'the duplicate offers the door to the filing already sent').not.toBeUndefined();
    act(() => open?.click());
    expect(opened).toHaveBeenCalledWith('cmt_x', open);
  });

  it('keeps the duplicate line when the door is pressed: a refusal is never cleared', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_x' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    mount(draftOf(PREMISE, { proposed: 'А как?' }), undefined, () => undefined);

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const open = [...container.querySelectorAll<HTMLButtonElement>('button.seam-inline-action')].find(
      (button) => button.textContent?.trim() === 'открыть отправленное',
    );
    act(() => open?.click());
    expect(container.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
  });

  it('offers no duplicate door when the 409 carries no id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    mount(draftOf(PREMISE, { proposed: 'А как?' }), undefined, () => undefined);
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    expect(container.querySelectorAll('button.seam-inline-action')).toHaveLength(0);
  });
});
