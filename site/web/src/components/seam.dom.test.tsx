// @vitest-environment jsdom
import { FRAME_FIRST_SENTENCE, FRAME_WARNING, type CommentDto } from '@book/shared';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HELD_LINE } from '../lib/marginalia.ts';
import {
  BLOCK_ID,
  ENTRY,
  TEXT,
  installSeamDom,
  clearDraft,
  comment,
  mountParagraph,
  openForm,
  typeInto,
} from './seamHarness.tsx';

/**
 * BOOK-33 / BOOK-137 — the seam as a reader meets it, in a DOM.
 *
 * The SSR tests prove what the markup says; these prove the interaction. BOOK-137 replaced the
 * chapter-level freeze: a **written** ch01 is ordinary prose — its body takes a form, and only
 * the canon sentence itself answers «рамка книги · не меняется», with the warning line printed
 * before the reader types and the form still available (the filing becomes paperwork).
 *
 * The rest of the strip's interaction — a refusal that outlives its panel, the clamped anchor,
 * the provenance door with history off — lives in `seamInteraction.dom.test.tsx`, on this
 * same harness.
 */

installSeamDom();

describe('the canon sentence is frozen, the chapter is not (BOOK-137)', () => {
  it('says the sentence does not change on the sentence itself — and still takes the filing', async () => {
    // `TEXT` *is* ch01's canon sentence: the one edge that is not text.
    await mountParagraph();
    const seam = document.querySelector('.seam');
    expect(seam).not.toBeNull();
    expect(seam?.getAttribute('data-frozen')).toBe('true');
    expect(seam?.querySelector('.seam-prov')?.textContent).toBe('рамка книги · не меняется');
    expect(seam?.textContent).not.toContain('закреплено');
    expect(seam?.textContent).not.toContain('откуда это слово');
    expect(seam?.querySelector('.seam-frozen')?.getAttribute('href')).toBe('/rules#рамка');
    // The action is «вмешаться», exactly as on any other prose: the filing is taken.
    expect(seam?.querySelector('.seam-cta')?.textContent).toBe('вмешаться');
    // The strip never claims the sentence will change — it says the opposite, once.
    expect(seam?.textContent).toContain('фраза не изменится');
    expect(seam?.textContent).not.toContain('будет изменена');
  });

  it('prints the warning in the strip, before the reader types (BOOK-137)', async () => {
    await mountParagraph();
    const seam = document.querySelector('.seam');
    expect(seam?.getAttribute('data-state')).toBe('strip');
    // The one line, from `@book/shared`, and the form is not there yet.
    expect(seam?.querySelector('.seam-note.seam-frame')?.textContent).toBe(FRAME_WARNING);
    expect(seam?.querySelector('.seam-form')).toBeNull();
    // One copy of it, even while the form is open.
    await act(async () => {
      (document.querySelector('.seam-cta') as HTMLElement).click();
    });
    expect(document.querySelector('.seam')?.getAttribute('data-state')).toBe('form');
    expect(document.querySelectorAll('.seam-frame')).toHaveLength(1);
  });

  it('opens the form on the frame and leaves the submit to the draft alone', async () => {
    clearDraft(ENTRY, TEXT, BLOCK_ID);
    await mountParagraph();
    await openForm();
    expect(document.querySelector('.seam-form')).not.toBeNull();
    // An empty draft is not a filing — the same rule as everywhere else, and no modal.
    expect(document.querySelector<HTMLButtonElement>('.seam-submit')?.disabled).toBe(true);
    await act(async () => {
      typeInto('.seam-text', 'Свет включали до него.');
    });
    expect(document.querySelector<HTMLButtonElement>('.seam-submit')?.disabled).toBe(false);
  });

  it('never carries the sentence as the reader’s wording, and sends nothing on open', async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
        return {
          ok: true,
          status: 201,
          statusText: 'Created',
          json: async () => ({
            comment: { id: 'cmt_new_1' },
            remaining: { perHour: 20, remaining: 19, resetAt: null, editsPerDay: 10, editsRemaining: 9, editsResetAt: null },
            queue: { depth: 0 },
          }),
        } as unknown as Response;
      }),
    );
    clearDraft(ENTRY, TEXT, BLOCK_ID);
    await mountParagraph();
    await openForm();
    // Opening the form is not a filing.
    expect(sent).toHaveLength(0);
    await act(async () => {
      typeInto('.seam-text', 'Свет включали до него.');
    });
    await act(async () => {
      (document.querySelector('.seam-submit') as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sent).toHaveLength(1);
    // The anchor is the sentence the reader touched; the wording is only ever what they typed.
    expect(sent[0]?.body.quote).toBe('Я вошёл в пустую комнату.');
    expect(sent[0]?.body.proposedText).toBe('Свет включали до него.');
  });

  it('leaves an ordinary chapter its form', async () => {
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22' });
    const seam = document.querySelector('.seam');
    expect(seam?.getAttribute('data-frozen')).toBeNull();
    expect(seam?.textContent).toContain('вмешаться');
    expect(seam?.querySelector('.seam-frame')).toBeNull();
  });

  it('closes ch65 to nothing: its prose is a chapter like any other (BOOK-137)', async () => {
    // Prod's own API has ch65 as `basis: false, written: true`; nothing may answer «закреплено».
    await mountParagraph({ entry: { ...ENTRY, n: 65 }, blockId: 'ch65#aa11bb22' });
    const seam = document.querySelector('.seam');
    expect(seam).not.toBeNull();
    expect(seam?.getAttribute('data-frozen')).toBeNull();
    expect(seam?.querySelector('.seam-filing')).toBeNull();
    expect(seam?.querySelector('.seam-prov')?.textContent).toBe('откуда это слово');
    expect(seam?.textContent).not.toContain('рамка книги');
    expect(seam?.textContent).toContain('вмешаться');
  });

  it('shows the ≥1024 margin rail on every paragraph that is not the sentence itself', async () => {
    // A written ch01 body and ch65 both take the action; only the basis slot (the sentence and
    // nothing else) has no rail of its own — the sentence stays touchable.
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22', text: TEXT });
    expect(document.querySelector('.seam-rail')).not.toBeNull();
    await mountParagraph({ entry: ENTRY, text: `Свет был включён до меня. ${TEXT}` });
    expect(document.querySelector('.seam-rail')).not.toBeNull();
    await mountParagraph({ entry: { ...ENTRY, basis: true, written: false }, text: FRAME_FIRST_SENTENCE });
    expect(document.querySelector('.seam-rail')).toBeNull();
  });

  it('announces the open form once through a polite live region', async () => {
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22' });
    const announce = document.querySelector('.seam-announce');
    expect(announce?.getAttribute('aria-live')).toBe('polite');
    // Closed seam: the region says nothing; the form is not announced until it opens.
    expect(announce?.textContent).toBe('');
    await act(async () => {
      (document.querySelector('.seam-cta') as HTMLElement).click();
    });
    expect(document.querySelector('.seam-announce')?.textContent).toBe('форма открыта');
  });
});

describe('the posted filing enters the page at once (BOOK-111)', () => {
  /** A quarantined 201: the DTO the server answers with, in full. */
  function answer(dto: CommentDto): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            comment: dto,
            remaining: { perHour: 10, remaining: 9, resetAt: null, editsPerDay: 1, editsRemaining: 1, editsResetAt: null },
            queue: { depth: 0 },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  }

  async function submitWith(dto: CommentDto): Promise<{ posted: ReturnType<typeof vi.fn>; receipt: string }> {
    answer(dto);
    const posted = vi.fn();
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22', onPosted: posted });
    // The strip opens closed: one tap opens the form, then the reader writes and sends.
    await act(async () => (document.querySelector('.seam-cta') as HTMLElement).click());
    typeInto('textarea.seam-text', 'Свет был включён до меня.');
    typeInto('input.seam-input', 'свет не от лампы');
    await act(async () => {
      document.querySelector('.seam-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    return { posted, receipt: document.querySelector('.seam-receipt')?.textContent ?? '' };
  }

  it('hands the DTO to the page and says «ждёт» on the receipt, with no reload', async () => {
    const dto: CommentDto = {
      ...comment({ status: 'new' }),
      id: 'cmt_01M5Z8HKWHPHZQDHP5MCXS5RB4',
    };
    const { posted, receipt } = await submitWith(dto);
    // The form is closed and the receipt is the fact: the id is not printed, the word is.
    expect(document.querySelector('.seam-form')).toBeNull();
    expect(document.querySelector('.seam')?.getAttribute('data-state')).toBe('receipt');
    expect(receipt).toContain('зарегистрировано');
    expect(receipt).toContain('ждёт');
    expect(receipt).not.toContain('cmt_');
    // BOOK-111: the caller gets the whole row, not its id — that is what fills the feed.
    expect(posted).toHaveBeenCalledWith(dto);
  });

  it('adds the check line to the receipt when the filing is held', async () => {
    const { receipt } = await submitWith(comment({ status: 'quarantined' }));
    // BOOK-111 §5: a held filing is never silent — the receipt says what happens before triage.
    // BOOK-61: the check line is the gate's fixed sentence (`HELD_LINE`), one copy for the page.
    expect(receipt).toContain('ждёт');
    expect(receipt).toContain(HELD_LINE);
  });
});

describe('closing the seam (major 4)', () => {
  it('closes on Escape and returns focus to the paragraph', async () => {
    await mountParagraph();
    expect(document.querySelector('.seam')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.seam')).toBeNull();
    // Focus went back to the element the tap came from, not to the top of the page.
    expect(document.activeElement?.getAttribute('data-origin')).toBe('true');
  });

  it('closes on a desktop click outside the strip and leaves a press that began inside alone', async () => {
    // jsdom's viewport is 1024 px wide with no `matchMedia`: a fine pointer, the desktop rule.
    await mountParagraph();
    await act(async () => {
      document.querySelector('.seam')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    expect(document.querySelector('.seam')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    expect(document.querySelector('.seam')).toBeNull();
  });
});

describe('the strip’s lines at the seam', () => {
  it('renders one element per line role and hides nothing behind a title', async () => {
    // Chapter 8 takes a form (ch01/ch67 are frozen by identity): the row has its action.
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22' });
    const seam = document.querySelector('.seam');
    const row = seam?.querySelector('.seam-row') ?? null;
    expect(row).not.toBeNull();
    for (const selector of ['.seam-prov', '.seam-word', '.seam-cta', '.seam-close']) {
      expect(row?.querySelectorAll(selector), selector).toHaveLength(1);
    }
    // The word is printed whole: the phone rule wraps it, it is never shortened.
    expect(row?.querySelector('.seam-word')?.textContent).toBe('«Я»');
    expect([...seam!.querySelectorAll('*')].filter((el) => el.hasAttribute('title'))).toHaveLength(0);
    // An accessible name adds to a control's own words; it never replaces hidden text.
    for (const control of seam!.querySelectorAll('[aria-label]')) {
      expect(['BUTTON', 'A'], control.tagName).toContain(control.tagName);
      expect((control.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});
