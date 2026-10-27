// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { HELD_LINE } from '../lib/marginalia.ts';
import { anchorFor, clampQuote, seamKey } from '../lib/seam.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-33 — the seam as a reader meets it, in a DOM.
 *
 * The SSR tests prove what the markup says; these prove the interaction: a **written** ch01
 * offers no form (the freeze is keyed on chapter identity, not on `basis`), `Esc` and a tap
 * outside close the seam and hand focus back to the paragraph, the live region announces the
 * form once, and a sentence longer than the 280-character anchor bound keeps its mark.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
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

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const BLOCK_ID = 'ch01#aa11bb22';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
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
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    ...overrides,
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  closeSeam();
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

type ParagraphProps = {
  entry?: CatalogEntry;
  blockId?: string;
  text?: string;
  frozen?: boolean;
  comments?: readonly CommentDto[];
  history?: boolean;
  onPosted?: (comment: CommentDto) => void;
};

/** The paragraph is the unit that renders the strip, so a fixed entry drives the freeze. */
async function mountParagraph(props: ParagraphProps = {}): Promise<void> {
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
        frozen={props.frozen ?? false}
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

describe('a written ch01 is frozen by identity (blocker 1)', () => {
  it('offers no form at all on the chapter the server refuses', async () => {
    // `basis: false` and `written: true` — the BOOK-32 shape, which used to get a live form.
    await mountParagraph();
    const seam = document.querySelector('.seam');
    expect(seam).not.toBeNull();
    expect(seam?.getAttribute('data-frozen')).toBe('true');
    expect(seam?.textContent).toContain('закреплено');
    expect(seam?.querySelector('.seam-form')).toBeNull();
    expect(seam?.textContent).not.toContain('вмешаться');
    expect(seam?.textContent).toContain('рамка книги');
    // §4: the desktop outer-margin action is absent on a frozen chapter too.
    expect(document.querySelector('.seam-rail')).toBeNull();
  });

  it('leaves an ordinary chapter its form', async () => {
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22' });
    const seam = document.querySelector('.seam');
    expect(seam?.getAttribute('data-frozen')).toBeNull();
    expect(seam?.textContent).toContain('вмешаться');
  });

  it('shows the ≥1024 margin rail only on a chapter that can take a form', async () => {
    const { ProseParagraph } = await import('./ProseParagraph.tsx');
    const render = async (entry: CatalogEntry): Promise<void> => {
      await act(async () => {
        root?.render(
          <ProseParagraph
            entry={entry}
            blockId="ch08#aa11bb22"
            blockIndex={0}
            baseRev={entry.rev}
            text={TEXT}
            frozen={false}
            comments={[]}
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: true, displayName: 'Филипп' }}
            onPosted={() => undefined}
          history />,
        );
      });
    };
    await render({ ...ENTRY, n: 8 });
    expect(document.querySelector('.seam-rail')).not.toBeNull();
    await render({ ...ENTRY, n: 1 });
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
  /** A controlled field needs the native setter, or React never sees the change. */
  function typeInto(selector: string, value: string): void {
    const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
    if (element === null) throw new Error(`no ${selector}`);
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
  }

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

describe('a refusal survives the panel that its own door opens (BOOK-111)', () => {
  /** A controlled field needs the native setter, or React never sees the change. */
  function typeInto(selector: string, value: string): void {
    const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
    if (element === null) throw new Error(`no ${selector}`);
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
  }

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
