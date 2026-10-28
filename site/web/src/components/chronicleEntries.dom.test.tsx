// @vitest-environment jsdom
import {
  PASS_RECORD_PREFIX,
  type CatalogEntry,
  type HistoryRecordDto,
  type HistoryTimelineDto,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordHeading } from '../lib/history.ts';
import { Chronicle } from './Chronicle.tsx';

/**
 * The chronicle lists **changes to the book**, whoever caused them (the owner's defect: «я с
 * кареткой попал в историю которой нет в хрониках»).
 *
 * The server's union is proven in `server/test/history/recordMerged.test.ts`; this file proves
 * the page reads that answer as one row per entry — a reader's change and a pass alike, marks
 * each by its cause, and gives each row the same id the record behind its door uses. It also
 * pins the one sentence the empty answer earns, and that the sentence is a fact about the
 * server's list, never a client guess about the chapters.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The same three acts the server test seeds: a reader's change, a pass with a change, a bare pass. */
const ENTRIES: HistoryRecordDto[] = [
  {
    id: 'pass:stp_bare',
    hseq: 9,
    at: '2026-10-27T12:40:00Z',
    seq: null,
    chapter: 4,
    chapterTitle: 'Дорога',
    premise: false,
    premiseLanded: false,
    alias: null,
    cause: 'pass',
    status: null,
    outcome: null,
    reason: null,
    changeId: null,
    recordHref: `#${PASS_RECORD_PREFIX}stp_bare`,
    span: { before: 'было так', after: 'стало иначе' },
  },
  {
    id: 'chg_m',
    hseq: 7,
    at: '2026-10-26T06:00:00Z',
    seq: 12,
    chapter: 3,
    chapterTitle: null,
    premise: false,
    premiseLanded: false,
    alias: null,
    cause: 'pass',
    status: 'done',
    outcome: 'applied',
    reason: null,
    changeId: 'chg_m',
    recordHref: `#${PASS_RECORD_PREFIX}chg_m`,
    span: null,
  },
  {
    id: 'chg_9',
    hseq: 4,
    at: '2026-10-21T06:12:00Z',
    seq: 9,
    chapter: 9,
    chapterTitle: 'Тестовая глава',
    premise: false,
    premiseLanded: false,
    alias: 'Аня',
    cause: 'reader',
    status: 'void',
    outcome: 'dropped',
    reason: 'текст успел измениться',
    changeId: 'chg_9',
    recordHref: `#правка-chg_9`,
    span: null,
  },
];

const CATALOG: CatalogEntry[] = [
  {
    n: 4,
    part: 1,
    title: 'Дорога',
    rev: 2,
    chars: 1_200,
    blocks: 8,
    written: true,
    basis: false,
    opening: null,
    writtenAt: '2026-10-26T09:00:00Z',
    updatedAt: '2026-10-27T12:40:00Z',
    direction: 'forward',
  },
];

function page(items: HistoryRecordDto[], firstAt: string | null = '2026-10-21T06:12:00Z'): HistoryTimelineDto {
  return {
    lastHseq: items[0]?.hseq ?? 0,
    lastAt: items[0]?.at ?? firstAt,
    firstAt,
    at: '2026-10-27T12:40:00Z',
    items,
    nextBefore: null,
  };
}

function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let root: Root | null = null;
/** Every URL the page asked for while it was mounted. */
let asked: string[] = [];

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  asked = [];
});

/** The chronicle with `history.live` off: the list must not depend on the reader-driven flag. */
async function mount(timeline: HistoryTimelineDto): Promise<HTMLElement> {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    asked.push(String(input));
    return Promise.resolve(answer(timeline));
  });
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => {
    root?.render(<Chronicle catalog={CATALOG} frontRev={1} tick={0} started live={false} />);
  });
  await flush();
  return container;
}

describe('one row per change to the book, whoever caused it', () => {
  it('renders three rows with the server’s causes, with the reader-driven flag off', async () => {
    const container = await mount(page(ENTRIES));

    const rows = [...container.querySelectorAll('li.chr-row')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('.chr-cause')?.textContent)).toEqual([
      'проход',
      'проход',
      'правка читателя',
    ]);
    // The place is the entry's heading — the same function the record behind the door reads.
    expect(rows.map((row) => row.querySelector('.chr-place')?.textContent)).toEqual([
      recordHeading(ENTRIES[0]!),
      recordHeading(ENTRIES[1]!),
      recordHeading(ENTRIES[2]!),
    ]);
    // A landed entry prints the book's pair; a change the book did not take says so.
    expect(rows[0]?.querySelector('.chr-span')?.textContent).toBe('«было так» → «стало иначе»');
    expect(rows[1]?.querySelector('.chr-span')).toBeNull();
    expect(rows[2]?.querySelector('.chr-state')?.textContent).toBe('не внесено');
  });

  it('gives each row the id the door uses: #правка- for a reader, #проход- for a pass', async () => {
    const container = await mount(page(ENTRIES));
    const links = [...container.querySelectorAll<HTMLAnchorElement>('li.chr-row .chr-change')];

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `#${PASS_RECORD_PREFIX}stp_bare`,
      `#${PASS_RECORD_PREFIX}chg_m`,
      `#правка-chg_9`,
    ]);
    // The bare pass's door is the pass; the pass with a change row is keyed by that change —
    // exactly the id the entry carries, so row and record cannot name one entry two ways.
    expect(links[0]?.getAttribute('href')).toBe(`#${PASS_RECORD_PREFIX}${ENTRIES[0]!.id.replace('pass:', '')}`);
    expect(links[1]?.getAttribute('href')).toBe(`#${PASS_RECORD_PREFIX}${ENTRIES[1]!.changeId}`);
    expect(ENTRIES[2]!.id).toBe(ENTRIES[2]!.changeId);
  });

  it('never prints a number, an alias, a model or a raw field on a row', async () => {
    const container = await mount(page(ENTRIES));
    const rows = [...container.querySelectorAll('li.chr-row')];

    for (const row of rows) {
      const text = row.textContent ?? '';
      expect(text).not.toContain('правка 9');
      expect(text).not.toContain('Аня');
      expect(text).not.toContain('этап:');
      expect(text).not.toContain('цена');
    }
  });

  it('opens the record from a row’s link and never scrubs from it', async () => {
    const container = await mount(page(ENTRIES));

    expect(container.querySelectorAll('li.chr-row')).toHaveLength(3);
    expect(container.querySelector('.chr-row button')).toBeNull();
    // The link is a hash on this page: opening an entry asks the server for no moment, so the
    // chronicle does not scrub when a reader takes a door.
    expect(asked.filter((url) => url.startsWith('/api/history/at/'))).toEqual([]);
    expect(container.querySelector('.past')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('9');
  });
});

describe('the empty answer and its one sentence', () => {
  it('prints the quiet line exactly once when the record holds nothing', async () => {
    const container = await mount(page([], '2026-10-21T06:12:00Z'));

    const line = 'перематывать пока нечего: книга ещё не правила читателем';
    expect(container.textContent?.split(line)).toHaveLength(2);
    expect(container.querySelectorAll('li.chr-row')).toHaveLength(1);
    expect(container.querySelector('.chr-seq')?.textContent).toBe('начало книги');
    // The empty-log sentence is a different fact; the two never print together.
    expect(container.textContent).not.toContain('пока ничего не записано');
  });

  it('prints it for a written chapter whose record is empty: the rule is the list, not the shelf', async () => {
    // `server/test/history/recordMerged.test.ts` proves the server answers `items: []` over a
    // written chapter nobody changed through a pass. The page reads that answer and nothing
    // else — it must not ask the catalog whether a chapter exists and invent a row from it.
    const container = await mount(page([]));

    expect(CATALOG[0]?.written).toBe(true);
    expect(container.textContent?.split('перематывать пока нечего')).toHaveLength(2);
    expect(container.querySelectorAll('li.chr-row')).toHaveLength(1);
    expect(container.querySelector('.chr-change')).toBeNull();
  });

  it('prints nothing of an absence over an empty log', async () => {
    const container = await mount(page([], null));

    expect(container.textContent).toContain('пока ничего не записано');
    expect(container.textContent).not.toContain('перематывать пока нечего');
    expect(container.querySelectorAll('li.chr-row')).toHaveLength(0);
  });
});
