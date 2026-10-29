// @vitest-environment jsdom
import type { CatalogEntry, ChangeSummaryDto, CommentDto, ParagraphChainDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { closeRecord, resetRecordMemory } from '../lib/record.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { hideWord } from '../lib/useWord.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-68, as BOOK-128 comment #3815 re-sites it — the word's margin may not claim a paragraph's
 * history it does not have.
 *
 * The old panel printed «написан целиком; читательских правок в нём не было» whenever the chain
 * was missing or had failed; the facts are read once, the block mounts only with the answer, and
 * a failure is one line — «история не прочиталась» — never three invented facts. A block whose
 * answer the client already holds is not asked about twice.
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

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const BLOCK_ID = 'ch08#68deed01';

function answer(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

const notFound = (): Response => answer({ code: 'NOT_FOUND', message: 'no such paragraph' }, 404);

let root: Root | null = null;

beforeEach(() => {
  resetParagraphChainCache();
  resetRecordMemory();
  hideFiling();
  hideWord();
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  closeSeam();
  closeRecord();
  hideFiling();
  hideWord();
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  resetParagraphChainCache();
});

/** One act around the act and its whole promise chain: no state lands after the test leaves. */
async function actAndSettle(action: () => void): Promise<void> {
  await act(async () => {
    action();
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });
}

/** The paragraph with its seam open inside the first sentence — the strip and its body. */
async function openParagraph(): Promise<void> {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 3 });
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        blockCount={1}
        comments={[]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
        history
      />,
    );
  });
  await act(async () => {
    openSeam({ chapter: ENTRY.n, blockId: BLOCK_ID, key: seamKey(ENTRY.n, BLOCK_ID, anchor!.sentence, ENTRY.rev), anchor, origin: document.body });
  });
}

const openWord = async (): Promise<void> => {
  await actAndSettle(() => (document.querySelector('.seam-prov') as HTMLElement).click());
};

const block = (): string => document.querySelector('.prov-block')?.textContent ?? '';

describe('the word’s margin and a missing paragraph history (BOOK-68)', () => {
  it('prints nothing while the chain is read, then the pass’s facts — never a rewrite claim', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/history/paragraphs/')) return pending;
      return Promise.resolve(notFound());
    });
    vi.stubGlobal('fetch', fetchMock);
    await openParagraph();

    await openWord();
    // No answer yet: the block does not exist, and nothing is guessed in its place.
    expect(document.querySelector('.prov-block')).toBeNull();

    await actAndSettle(() => release(notFound()));
    // A 404 is an answer: the pass wrote the chapter, and the log holds no change on it.
    expect(block()).toContain('машина');
    expect(block()).toContain('вне правок');
    expect(block()).toContain('следа нет');
    expect(block()).not.toContain('написан целиком');
    expect(block()).not.toContain('читательских правок');
    // The one sentence is the gloss of the hand, and it is the owner's, word for word.
    expect(block()).toContain('машина внесла правку; рамку держит автор.');
  });

  it('asks once when the reader reopens the block on the same historyless block', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) => Promise.resolve(notFound()));
    vi.stubGlobal('fetch', fetchMock);
    const chainCalls = (): number =>
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/history/paragraphs/')).length;
    await openParagraph();

    await openWord();
    expect(block()).toContain('машина');
    expect(chainCalls()).toBe(1);

    await actAndSettle(() => (document.querySelector('.seam-prov') as HTMLElement).click());
    expect(document.querySelector('.prov-block')).toBeNull();

    await openWord();
    expect(block()).toContain('машина');
    expect(chainCalls()).toBe(1);
  });

  it('says the read failed — one line, no facts — and the door asks again', async () => {
    let attempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (!String(input).startsWith('/api/history/paragraphs/')) return Promise.resolve(notFound());
      attempts += 1;
      return Promise.resolve(attempts === 1 ? answer({ code: 'BOOM' }, 500) : notFound());
    });
    vi.stubGlobal('fetch', fetchMock);
    await openParagraph();

    await openWord();
    expect(block()).toBe('история не прочиталась');
    expect(block()).not.toContain('машина');

    // A failure is not memoised: closing and reopening asks again and prints the answer.
    await actAndSettle(() => (document.querySelector('.seam-prov') as HTMLElement).click());
    await openWord();
    expect(attempts).toBe(2);
    expect(block()).toContain('машина');
  });

  it('a filing standing on the word names the change it became, in the change’s noun', async () => {
    // The filing's own number is its latest attempt's change number (the schema has no filing
    // sequence), printed `№12` — the owner's spec, never the record's suffix and never `012`.
    const filing: CommentDto = {
      id: 'cmt_01J9Z8K4Q7',
      number: 1,
      chapter: 8,
      anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: 'Я вошёл в пустую комнату.', prefix: null, suffix: null, resolved: false },
      author: 'Аня',
      authorColor: '#6f9bb5',
      body: 'в комнате должен быть свет, но не от лампы',
      proposedText: null,
      interventionKind: 'testimony',
      status: 'new',
      frame: 'untouched',
      premise: false,
      reason: null,
      decidedAt: null,
      changeId: null,
      applied: null,
      refusal: null,
      attempt: null,
      createdAt: '2026-10-28T09:20:00Z',
    };
    const change: ChangeSummaryDto = {
      id: 'chg_12',
      seq: 12,
      chapter: 8,
      intent: 'свет',
      premise: false,
      premiseLanded: false,
      sourceCommentId: filing.id,
      status: 'done',
      outcome: 'applied',
      reason: null,
      position: null,
      enqueuedAt: '2026-10-28T09:20:00Z',
      decidedAt: '2026-10-28T10:40:00Z',
      chapters: [8],
      rewritten: [8],
      steps: 1,
      frame: 'untouched',
      frameMode: null,
      modes: [],
      cascade: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => notFound()));
    const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 3 });
    await act(async () => {
      root?.render(
        <ProseParagraph
          entry={ENTRY}
          blockId={BLOCK_ID}
          blockIndex={0}
          baseRev={ENTRY.rev}
          text={TEXT}
          blockCount={1}
          comments={[filing]}
          changes={[change]}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Филипп' }}
          onPosted={() => undefined}
          history
        />,
      );
    });
    await act(async () => {
      openSeam({ chapter: ENTRY.n, blockId: BLOCK_ID, key: seamKey(ENTRY.n, BLOCK_ID, anchor!.sentence, ENTRY.rev), anchor, origin: document.body });
    });

    await openWord();
    // BOOK-218 — the change keeps its own padded number under its own noun; a filing would be
    // «замечание 12», and no id ever appears.
    expect(block()).toContain('правка 012');
    expect(block()).toContain('правка 012 · ждёт');
    expect(block()).not.toContain('замечание');
    expect(block()).not.toContain('4Q7');
  });

  it('a real chain names the hand by the log, not by the pass’s default', async () => {
    const chain: ParagraphChainDto = {
      blockUid: 'blk_1',
      blockId: BLOCK_ID,
      chapter: 8,
      alive: true,
      line: '',
      versions: [
        {
          blockUid: 'blk_1',
          ver: 1,
          blockId: BLOCK_ID,
          chapter: 8,
          rev: 5,
          at: '2026-10-28T09:08:00Z',
          op: 'revised',
          textHash: 'aa11bb22',
          chars: 112,
          changeId: 'chg_12',
          changeSeq: 12,
          stepId: 'stp_12',
          actor: { kind: 'reader', identityId: 'idt_1', label: 'Аня' },
          replacedBy: null,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('/api/history/paragraphs/')) return answer(chain, 200);
        return notFound();
      }),
    );
    await openParagraph();

    await openWord();
    expect(block()).toContain('Аня');
    expect(block()).toContain('с 28.10.2026, 12:08');
    // No public number and no borrowed curve: the viewer is not this reader's own page.
    expect(block()).not.toContain('доля в книге');
    expect(block()).not.toContain('пережила');
    // And no gloss: only the pass's own hand is explained.
    expect(block()).not.toContain('смена, которая пишет книгу');
  });
});
