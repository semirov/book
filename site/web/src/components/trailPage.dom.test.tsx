// @vitest-environment jsdom
import {
  AUTHOR_COLORS,
  type CommentDto,
  type FilingUpdatePayload,
  type MyFilingsDto,
  type MyTraceDto,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissNotice, unfollow } from '../lib/follow.ts';
import { ScreenExit } from './ScreenExit.tsx';
import { TrailPage } from './TrailPage.tsx';

/**
 * BOOK-207 — «ваш след» as its own page: signed out, empty, and two rows whose quotes are
 * doors back to the sentence. The page reads own-only (`/api/authors/me`, `/api/me/filings`)
 * and prints no total.
 *
 * BOOK-221 — the page begins with the one exit (`к оглавлению`), the trace line says what it
 * measures, and a row is a number, a chapter, a moment and one sentence in the reader's own
 * words — never a record code («№A7K») and never a state of our machinery.
 *
 * BOOK-DOC-84 #17/D6 — the trail also moves by frame: `filing:update` carries the state and the
 * tries left, so a row changes in place with no second read, and nothing polls while the page
 * sits still (the 10 s `/api/queue` poll is gone, and no interval took its place).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TRACE: MyTraceDto = {
  label: 'Аня',
  edits: 2,
  chars: 4_000,
  share: 0.004,
  series: [],
  hidden: false,
  isAuthor: false,
  survivedRevisions: 12,
};

/** `4 000 знаков`: the number, the site's non-breaking space and the noun with its plural. */
const CHARS = '4\u00a0000\u00a0знаков';

/** Every element the browser would stop at while tabbing, in document order. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Does `first` stand before `second` in document order? */
function precedes(first: Element | null, second: Element | null): boolean {
  return first !== null && second !== null && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function filing(
  id: string,
  chapter: number,
  blockIndex: number,
  quote: string,
  extra: Partial<CommentDto> = {},
): CommentDto {
  return {
    id,
    // BOOK-218 — the filing's own number; the fixture keeps the two rows distinct.
    number: chapter - 11,
    chapter,
    anchor: { blockId: `ch${chapter}#b${blockIndex}`, blockIndex, quote, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'пусть останется как есть',
    proposedText: 'пусть войдёт в книгу как есть',
    // A real intervention: a note (`interventionKind: null`) has its own terminal («замечание
    // сохранено»), and the rows below would otherwise all be notes.
    interventionKind: 'document',
    premise: false,
    status: 'applied',
    frame: 'untouched',
    reason: null,
    createdAt: '2026-10-28T09:08:00Z',
    decidedAt: '2026-10-28T10:00:00Z',
    changeId: 'chg_1',
    // A receipt belongs to a landing only: the states below are each their own row's fact.
    applied: null,
    refusal: null,
    attempt: null,
    // BOOK-221 — the number a row prints is the linked change's own `seq`.
    changeSeq: 14,
    ...extra,
  };
}

const FILINGS: MyFilingsDto = {
  items: [
    filing('cmt_A7K', 12, 8, 'Он вошёл в регистратуру.', {
      disposition: 'through_paper',
      carrierKind: 'document',
    }),
    filing('cmt_B2C', 13, 3, 'Дверь осталась открытой.', { changeSeq: null }),
  ],
};

let root: Root | null = null;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
  } as unknown as Response;
}

function answerFilings(items: CommentDto[]): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/authors/me')) return json(TRACE);
    if (url.endsWith('/api/me/filings')) return json({ items });
    return json({ code: 'NOT_FOUND', message: 'not found' }, 404);
  });
}

beforeEach(() => {
  unfollow('chg_1');
  dismissNotice();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/authors/me')) return json(TRACE);
    if (url.endsWith('/api/me/filings')) return json(FILINGS);
    return json({ code: 'NOT_FOUND', message: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  // jsdom has no layout and a real `scrollTo` is not implemented: the mode's landing is a spy.
  vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(signedIn: boolean): Promise<void> {
  await act(async () => {
    root?.render(<TrailPage viewer={{ signedIn, displayName: signedIn ? 'Аня' : null }} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const row = (): HTMLElement | null => container.querySelector('.sled-row');

describe('«ваш след»', () => {
  it('asks a signed-out reader to sign in, and reads nothing', async () => {
    await mount(false);
    expect(container.textContent).toContain('войдите, чтобы увидеть свой след');
    expect(container.querySelector('a[href="/auth/yandex/start"]')?.textContent).toBe('войти через Яндекс');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('.sled-head')?.textContent).toBe('ваш след');
    expect(container.querySelector('a[href="#toc"]')?.textContent).toBe('к оглавлению');
  });

  it('opens on the way back: the exit is the section’s first focusable, before the head and the rows', async () => {
    await mount(true);
    const section = container.querySelector<HTMLElement>('.sled');
    expect(section?.firstElementChild?.className).toBe('screen-exit');
    // Scoped to the screen, not the document: the running head above the section keeps its own
    // controls (the ribbon, `a.ribbon-ch` / `button.ribbon-open`), and they stay tabbable.
    const focusables = [...(section?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const exit = focusables[0] ?? null;
    expect(exit?.closest('.screen-exit')).not.toBeNull();
    expect(exit?.getAttribute('href')).toBe('#toc');
    // Before the head and before every row's door: nothing of the screen is reachable first.
    expect(precedes(exit, section?.querySelector('.sled-head') ?? null)).toBe(true);
    expect(precedes(exit, section?.querySelector('.sled-quote a') ?? null)).toBe(true);
    expect(precedes(exit, section?.querySelector('button') ?? null)).toBe(true);
    // One copy of the exit, at the top: the bottom one is gone.
    expect(section?.querySelectorAll('a[href="#toc"]')).toHaveLength(1);
  });

  it('says «вы ещё ничего не написали» for a signed-in reader with no filings', async () => {
    answerFilings([]);
    await mount(true);
    expect(container.textContent).toContain('вы ещё ничего не написали');
    expect(container.textContent).toContain(
      `ваши слова в книге: главы правили 12 раз, а слова остались. сейчас это 0,4 % текста книги — ${CHARS}.`,
    );
    expect(container.querySelector('a[href="#toc"]')).not.toBeNull();
  });

  it('prints two rows, newest first, each quote a door to its sentence', async () => {
    await mount(true);
    const rows = [...container.querySelectorAll('.sled-row')];
    expect(rows).toHaveLength(2);
    // The row's number, its chapter and its moment — never a record code.
    expect(rows[0]?.querySelector('.sled-meta')?.textContent).toMatch(
      /^правка 014 · глава 12 · 28\.10, \d{2}:\d{2}$/u,
    );
    // No change holds the second filing, so it is named by its chapter, not by a made-up ordinal.
    expect(rows[1]?.querySelector('.sled-meta')?.textContent).toMatch(
      /^правка по главе 13 · 28\.10, \d{2}:\d{2}$/u,
    );
    // The quote is the way back to the text.
    const links = rows.map((row) => row.querySelector<HTMLAnchorElement>('.sled-quote a'));
    expect(links[0]?.getAttribute('href')).toBe('#ch-12-b8');
    expect(links[1]?.getAttribute('href')).toBe('#ch-13-b3');
    expect(links[0]?.textContent).toBe('«Он вошёл в регистратуру.»');
    // The row's word is the deck's, and the sentence it was filed on stays its door (BOOK-218).
    expect(rows[0]?.textContent).toContain('внесено');
    // The page prints no total, only the trace's own line.
    expect(container.textContent).not.toContain('всего');
    expect(container.textContent).not.toContain('50');
  });

  it('says one reader’s sentence per state, and none of our words', async () => {
    const cases: Array<[Partial<CommentDto>, string]> = [
      [{ status: 'new' }, 'ждёт · её ещё не читали'],
      // BOOK-206 — the attempt came back empty: the row still waits, and says so.
      [{ status: 'new', attempt: 'failed' }, 'попытка не удалась — правка ждёт'],
      [{ status: 'accepted', attempt: 'failed' }, 'попытка не удалась — правка ждёт'],
      // BOOK-218 line 1 — the filing was delivered to the reading.
      [{ status: 'batched' }, 'идёт · её читают'],
      [{ status: 'delivered' }, 'идёт · её читают'],
      // BOOK-218 line 6 — the chapter's turn has not come.
      [{ status: 'accepted', changeStatus: 'pending' }, 'принято · впишется, когда машина возьмёт главу'],
      // BOOK-218 line 7 — the chapter is being drafted (the start moment is the change's, not
      // this row's).
      [{ status: 'accepted', changeStatus: 'processing', chapter: 7 }, 'пишется · глава 7'],
      // BOOK-218 line 10 — one sentence, the sink word in front of its own fact.
      [{ status: 'applied', applied: { chapter: 12, rev: 4 } }, 'внесено · глава 12 · редакция 4'],
      // A landed row keeps its receipt whatever became of an earlier attempt.
      [{ status: 'applied', applied: { chapter: 12, rev: 4 }, attempt: 'failed' }, 'внесено · глава 12 · редакция 4'],
      [{ status: 'applied', applied: null }, 'внесено'],
      // A note is never «внесено · глава N»: it moved no text (BOOK-190).
      [{ status: 'applied', applied: { chapter: 12, rev: 4 }, interventionKind: null }, 'замечание сохранено'],
      [{ status: 'registered' }, 'рассмотрено · оформление · фраза не изменилась'],
      // The mode is derived, not assumed: a filing entered as «поправка» says so.
      [
        { status: 'registered', reason: 'принято как поправка: рамка книги — фраза не меняется' },
        'рассмотрено · поправка · фраза не изменилась',
      ],
      // The mode helper answers a failed attempt first, and that line still names a queue: a row
      // whose attempt came back empty keeps the bare word here.
      [{ status: 'registered', attempt: 'failed' }, 'рассмотрено'],
      [{ status: 'quarantined' }, 'проверяется · ждёт человека'],
      [
        { status: 'rejected', refusal: 'rights', reason: 'не принято: чужая цитата без источника' },
        'не принято · чужая цитата без источника',
      ],
      [
        { status: 'rejected', refusal: 'auditor', reason: 'вне рамок: форма книги' },
        'не принято · вне рамок: форма книги',
      ],
      [{ status: 'rejected', refusal: 'auditor', reason: null }, 'не принято'],
      [{ status: 'superseded' }, 'снято · текст успел измениться'],
      [{ status: 'expired' }, 'снято · правка не состоялась'],
      [{ status: 'hidden' }, 'скрыто'],
      [{ status: 'escalated' }, 'ждёт решения автора'],
      [{ status: 'accepted', premise: true }, 'принято в основу · до первой редакции'],
    ];
    answerFilings(cases.map(([patch], index) => filing(`cmt_${String(index)}`, 12, index, 'цитата', patch)));
    await mount(true);
    const rows = [...container.querySelectorAll('.sled-row')];
    expect(rows).toHaveLength(cases.length);
    expect(rows.map((row) => row.querySelector('.sled-state')?.textContent)).toEqual(
      cases.map(([, sentence]) => sentence),
    );
    // The reason is inside the refused sentence once, and no machinery is printed at all.
    const text = container.textContent ?? '';
    expect(text.split('чужая цитата без источника')).toHaveLength(2);
    // A row is never named «замечание №A7K» any more: the word survives only as the note's own
    // terminal («замечание сохранено»), never in a row's meta line.
    for (const row of rows) expect(row.querySelector('.sled-meta')?.textContent).not.toContain('замечание');
    for (const gone of ['очеред', 'лейн', 'пасс', 'проход', 'триаж', 'вердикт', 'гейт']) {
      expect(text).not.toContain(gone);
    }
    // No record code either: the row's number is the change's own.
    expect(text).not.toMatch(/№/u);
  });

  it('lands at the page’s top on entry, with the head focused', async () => {
    await mount(false);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(document.activeElement).toBe(container.querySelector('.sled-head'));
  });

  it('carries «к оглавлению» to the contents once the book has mounted them', async () => {
    await mount(false);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const link = container.querySelector<HTMLAnchorElement>('a[href="#toc"]');
    expect(link?.textContent).toBe('к оглавлению');
    await act(async () => link?.click());
    // The browser makes the mode change by itself — nothing here calls `preventDefault`.
    expect(window.location.hash).toBe('#toc');
    // …and the landing waits for the contents to exist.
    expect(frames).toHaveLength(1);
    await act(async () => {
      frames.shift()?.(0);
    });
    const toc = document.createElement('div');
    toc.id = 'toc';
    const into = vi.fn();
    toc.scrollIntoView = into;
    document.body.append(toc);
    await act(async () => {
      frames.shift()?.(16);
    });
    expect(into).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  });

  it('needs no handler: a click on the bare exit still lands on #toc', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    const plain = createRoot(host);
    window.history.replaceState(null, '', '/');
    await act(async () => {
      plain.render(<ScreenExit />);
    });
    const link = host.querySelector<HTMLAnchorElement>('.screen-exit a');
    expect(link?.getAttribute('href')).toBe('#toc');
    await act(async () => link?.click());
    expect(window.location.hash).toBe('#toc');
    await act(async () => plain.unmount());
  });

  it('augments only a plain click: a modified click is the browser’s own', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    const plain = createRoot(host);
    const onFollow = vi.fn();
    await act(async () => {
      plain.render(<ScreenExit href="#toc" onFollow={onFollow} />);
    });
    const link = host.querySelector<HTMLAnchorElement>('.screen-exit a');
    // A new tab: the reader is not leaving this page, so the landing must not scroll it.
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    expect(onFollow).not.toHaveBeenCalled();
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onFollow).toHaveBeenCalledTimes(1);
    await act(async () => plain.unmount());
  });

  it('moves a row by its frame, with no second read', async () => {
    answerFilings([
      filing('cmt_1', 4, 0, 'цитата из текста', {
        status: 'new',
        applied: null,
        interventionKind: null,
        changeSeq: null,
      }),
    ]);
    await mount(true);
    expect(row()?.textContent ?? '').toContain('ждёт');
    const before = fetchMock.mock.calls.length;

    const update: FilingUpdatePayload = {
      commentId: 'cmt_1',
      chapter: 4,
      state: 'refused',
      attempts: 1,
      attemptsLeft: 2,
      changeId: 'chg_2',
      at: 1_764_000_000_000,
    };
    await act(async () => {
      root?.render(
        <TrailPage viewer={{ signedIn: true, displayName: 'Аня' }} updates={{ cmt_1: update }} />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(row()?.textContent ?? '').toContain('не принято');
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('polls nothing while the page sits still', async () => {
    await mount(true);
    const before = fetchMock.mock.calls.length;
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    vi.useRealTimers();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('says «след не прочитался» and offers «повторить» when the read fails', async () => {
    fetchMock.mockImplementation(async () => json({ code: 'INTERNAL', message: 'nope' }, 500));
    await mount(true);
    expect(container.textContent).toContain('след не прочитался');
    const retry = container.querySelector<HTMLButtonElement>('.sled-retry button');
    expect(retry?.textContent).toBe('повторить');
  });
});
