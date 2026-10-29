// @vitest-environment jsdom
import type { ChangeDto, ChapterDto, CommentDto } from '@book/shared';
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChangeCache } from './lib/changeCache.ts';
import {
  closeRecord,
  currentChapterChange,
  currentRecord,
  resetRecordMemory,
} from './lib/record.ts';
import { useChangeDoor } from './useChangeDoor.ts';

/**
 * The one door to a change: `?change=<id>` (and every button that calls the same door) lands on
 * the change's chapter, waits for its paragraph, jumps to the block and opens the record there
 * with `changeId` set — the record then expands its `правка` section. A change with no sentence
 * lands on the chapter and hands it to the chapter's row. Nothing here mounts a dialog.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BLOCK_ID = 'ch08#door';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

const CHANGE: ChangeDto = {
  premiseLanded: false,
  id: 'chg_1',
  seq: 9,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'в комнате должен быть ровный свет',
  premise: false,
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: null,
  cascade: null,
  modes: [],
  steps: [],
  appliedRevs: [],
  cost: null,
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

const FILING: CommentDto = {
  attempt: null,
  id: 'cmt_1',
  chapter: 8,
  // The filing was made on the sentence **before** the change rewrote it: the stored quote is
  // gone from the text, and the prefix names the place the live sentence stands at now.
  anchor: {
    blockId: BLOCK_ID,
    blockIndex: 0,
    quote: 'Её освещал тусклый свет.',
    prefix: 'Я вошёл в пустую комнату. ',
    suffix: ' Свет был включён до меня.',
    resolved: true,
  },
  author: 'Аня',
  authorColor: '#2e6274',
  body: 'в комнате должен быть свет',
  interventionKind: null,
  proposedText: null,
  premise: false,
  status: 'applied',
  frame: 'untouched',
  reason: null,
  createdAt: '2026-10-25T12:04:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
  changeId: 'chg_1',
  applied: { chapter: 8, rev: 4 },
  refusal: null,
};

const CHAPTER: ChapterDto = {
  n: 8,
  title: 'Комната на восьмом',
  rev: 4,
  chars: TEXT.length,
  basis: false,
  blocks: [{ id: BLOCK_ID, i: 0, text: TEXT, hash: 'h' }],
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
};

let root: Root | null = null;
let container: HTMLDivElement;
let failed: string | null = null;

function Harness({ ready, open }: { ready: boolean; open: string | null }) {
  const door = useChangeDoor({ ready, loadChapter: () => undefined });
  failed = door.failed;
  const asked = useRef(false);
  useEffect(() => {
    if (open === null || asked.current) return;
    asked.current = true;
    door.open(open);
  }, [open, door]);
  return <span data-failed={door.failed ?? ''} />;
}

function chapterDom(): void {
  const article = document.createElement('article');
  article.id = 'ch-8';
  const paragraph = document.createElement('p');
  paragraph.id = 'ch-8-b0';
  paragraph.setAttribute('data-block-id', BLOCK_ID);
  paragraph.textContent = TEXT;
  article.append(paragraph);
  document.body.append(article);
}

function answer(map: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(map).find((path) => url.includes(path));
      if (key === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(map[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

async function settle(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  resetChangeCache();
  resetRecordMemory();
  failed = null;
  chapterDom();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  vi.stubGlobal('scrollTo', vi.fn());
  // jsdom has no layout: the chapter and its paragraph report a box a browser would give them.
  Element.prototype.getBoundingClientRect = () =>
    ({ top: 10, left: 0, width: 100, height: 40, bottom: 50, right: 100, x: 0, y: 10, toJSON: () => ({}) }) as DOMRect;
});

afterEach(async () => {
  await act(async () => closeRecord());
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetChangeCache();
  resetRecordMemory();
});

describe('a change lands in the record, never in a dialog', () => {
  it('?change= opens the record at the change’s sentence with the change id on it', async () => {
    window.history.replaceState(null, '', '/?change=chg_1');
    answer({ '/api/changes/chg_1': CHANGE, '/api/comments/cmt_1': FILING, '/api/chapters/8': CHAPTER });
    await act(async () => root?.render(<Harness ready open={null} />));
    await settle();
    const record = currentRecord();
    expect(record).not.toBeNull();
    expect(record?.changeId).toBe('chg_1');
    expect(record?.chapter).toBe(8);
    expect(record?.blockId).toBe(BLOCK_ID);
    expect(record?.start).toBe(TEXT.indexOf('Её'));
    expect(record?.end).toBe(TEXT.indexOf('Её') + 'Её освещал яркий свет.'.length);
    expect(record?.anchor?.quote).toBe('Её освещал яркий свет.');
    // The filing's own sentence travels with the door as the «было»; the record's anchor is
    // the sentence as it stands — the «стало».
    expect(record?.changeQuote).toBe('Её освещал тусклый свет.');
    // The read is the page's own: chapter first, then the paragraph it lands on.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a change with no sentence hands the chapter to its own row', async () => {
    answer({ '/api/changes/chg_1': { ...CHANGE, source: { commentId: null, author: null } }, '/api/chapters/8': CHAPTER });
    await act(async () => root?.render(<Harness ready open="chg_1" />));
    await settle();
    expect(currentRecord()).toBeNull();
    expect(currentChapterChange()).toEqual({ chapter: 8, changeId: 'chg_1' });
  });

  it('says so when the change cannot be read, and opens nothing', async () => {
    answer({});
    await act(async () => root?.render(<Harness ready open="chg_1" />));
    await settle();
    expect(currentRecord()).toBeNull();
    expect(currentChapterChange()).toBeNull();
    expect(failed).toBe('правка не прочиталась');
  });

  it('lands once per address: a re-render does not open the record a second time', async () => {
    window.history.replaceState(null, '', '/?change=chg_1');
    answer({ '/api/changes/chg_1': CHANGE, '/api/comments/cmt_1': FILING, '/api/chapters/8': CHAPTER });
    await act(async () => root?.render(<Harness ready open={null} />));
    await settle();
    const first = currentRecord();
    await act(async () => root?.render(<Harness ready open={null} />));
    await settle(3);
    expect(currentRecord()).toBe(first);
  });
});
