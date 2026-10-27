// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { anchorFor, clampQuote } from '../lib/seam.ts';
import { ENTRY, comment, installSeamDom, mountParagraph, typeInto } from './seamHarness.tsx';

/**
 * BOOK-111 / BOOK-56 — the seam's interactions that outlive one form: a refusal that survives
 * the panel its own door opens, a sentence longer than the anchor bound, and the provenance
 * door's fetches with history off.
 *
 * The harness (`seamHarness.tsx`) is shared with `seam.dom.test.tsx`: one ENTRY, one paragraph
 * mount, one teardown, so the two files prove the same strip.
 */

installSeamDom();

describe('a refusal survives the panel that its own door opens (BOOK-111)', () => {
  /**
   * The prod 409: the reader's own filing already exists. Its door opens the filing in the one
   * panel — and the strip under that panel is rebuilt when the panel closes. The refusal is a
   * fact of the strip, not of the form's mount: it must be there afterwards, with its door.
   */
  it('a refusal survives the panel that its own door opens', async () => {
    const kept = comment({ id: 'cmt_x', chapter: 8, anchor: { ...comment().anchor, blockId: 'ch08#aa11bb22' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/comments/cmt_x')) {
          return new Response(JSON.stringify(kept), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(
          JSON.stringify({ code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_x' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22' });
    await act(async () => (document.querySelector('.seam-cta') as HTMLElement).click());
    typeInto('textarea.seam-text', 'Свет был включён до меня, и это видно по тени.');
    await act(async () => {
      document.querySelector('.seam-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });

    expect(document.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    const refused = document.querySelector<HTMLElement>('[data-door="duplicate"]');
    expect(refused, 'the refusal names the filing already sent').not.toBeNull();

    // The door opens that filing: the form goes and the strip collapses to its one line.
    await act(async () => {
      refused?.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(document.querySelector('.filing-panel')).not.toBeNull();
    expect(document.querySelector('.seam')?.getAttribute('data-state')).toBe('prov');
    expect(document.querySelector('.seam-form')).toBeNull();

    // Closing the panel rebuilds the strip — with the refusal and its door, not a clean form.
    await act(async () => {
      (document.querySelector('.filing-close') as HTMLElement).click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(document.querySelector('.filing-panel')).toBeNull();
    expect(document.querySelector('.seam')?.getAttribute('data-state')).toBe('form');
    expect(document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe(
      'Свет был включён до меня, и это видно по тени.',
    );
    expect(document.querySelector('.seam-error')?.textContent).toContain('такое замечание уже отправлено');
    expect(document.querySelector('.seam-error')?.getAttribute('role')).toBe('alert');
    // The door is back, and the focus that the panel's close hands back lands on it — never
    // on `<body>` (the form was unmounted and mounted again under the panel).
    expect(document.querySelector('[data-door="duplicate"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-door')).toBe('duplicate');
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('a sentence longer than the anchor bound keeps its mark (major 9)', () => {
  it('matches the filing by the clamped quote the server stored', async () => {
    const long = `${'слово '.repeat(60)}конец.`;
    const anchor = anchorFor({ text: long, blockId: 'ch08#aa11bb22', baseRev: 2, offset: 0 });
    expect(anchor?.quote.length).toBeLessThanOrEqual(280);
    expect(anchor?.quote).toBe(clampQuote(long));

    const filing = comment({
      id: 'cmt_long_1',
      chapter: 8,
      anchor: { blockId: 'ch08#aa11bb22', blockIndex: 0, quote: anchor?.quote ?? '', prefix: null, suffix: null, resolved: true },
    });
    await mountParagraph({
      entry: { ...ENTRY, n: 8 },
      blockId: 'ch08#aa11bb22',
      text: long,
      comments: [filing],
    });
    expect(document.querySelector('.filing-mark')).not.toBeNull();
    expect(document.querySelector('.cited')).not.toBeNull();
    // The visible numeral is the button: tapping it opens the filing, not the seam.
    await act(async () => {
      (document.querySelector('.filing-mark') as HTMLElement).click();
    });
    expect(document.querySelector('.filing-panel')).not.toBeNull();
    expect(document.querySelector('.filing-panel')?.textContent).toContain('замечание');
  });
});

/**
 * BOOK-56 — the provenance panel with history off.
 *
 * The panel keeps the word, its place and «вмешаться»; the chain rows and the DNA rows are
 * the log's answers, so the component must not ask the log for them at all. A fetch that is
 * not made is proven by the stub, not by the markup.
 */
describe('the provenance door asks nothing while history is off (BOOK-56)', () => {
  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchStub = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchStub);
    return fetchStub;
  }

  it('opens the record without a history fetch', async () => {
    const fetchStub = stubFetch();
    await mountParagraph({ entry: { ...ENTRY, n: 8, basis: false }, blockId: 'ch08#aa11bb22', history: false });
    const button = document.querySelector<HTMLElement>('.seam-prov');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      // The handler is async: flush it inside act, so its state update is not a warning.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('.prov-panel')).not.toBeNull();
    expect(document.querySelector('.prov-panel')?.textContent).toContain('откуда это слово');
    expect(document.querySelector('.prov-panel')?.textContent).toContain('вмешаться здесь');
    expect(document.querySelector('.prov-chain')).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('asks the log once when history is on', async () => {
    const fetchStub = stubFetch();
    await mountParagraph({ entry: { ...ENTRY, n: 8, basis: false }, blockId: 'ch08#aa11bb22', history: true });
    await act(async () => {
      document.querySelector<HTMLElement>('.seam-prov')?.click();
      // The handler is async: flush the fetch inside act too.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchStub.mock.calls.map(([url]) => String(url))).toContain('/api/history/paragraphs/ch08%23aa11bb22');
  });
});
