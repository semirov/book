// @vitest-environment jsdom
import type { ParagraphChainDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetParagraphChainCache } from './paragraphChainCache.ts';
import { useProvenance } from './useProvenance.ts';

/**
 * BOOK-DOC-34 §2.6 (BOOK-56, BOOK-68) — the one reader behind both of the panel's doors.
 *
 * The hook is the whole answer to «what may the DNA panel print now»: the chain's state, the
 * viewer's own trace and the public shares. The strip's «откуда это слово» and a filing card's
 * footer both call it, so the two can never ask the log different questions — and with history
 * off neither asks anything at all.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BLOCK_ID = 'ch08#provhook';

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: BLOCK_ID,
  chapter: 8,
  alive: true,
  line: 'переписано в 14:20 правкой 7 (Аня)',
  versions: [
    {
      blockUid: 'bkd_1',
      ver: 1,
      blockId: BLOCK_ID,
      chapter: 8,
      rev: 5,
      at: '2026-10-25T11:20:00Z',
      op: 'revised',
      textHash: '0b7e9c31',
      chars: 112,
      changeId: 'chg_7',
      changeSeq: 7,
      stepId: 'stp_2',
      actor: { kind: 'reader', identityId: 'idt_2', label: 'Аня' },
      replacedBy: null,
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetParagraphChainCache();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetParagraphChainCache();
});

/** Route a fetch by URL; an unrouted call is a 404, which is an answer here, not a failure. */
function stub(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    return route === undefined ? new Response('{}', { status: 404 }) : route[1]();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function probe(props: { word?: string | null; history?: boolean; signedIn?: boolean; viewerName?: string | null } = {}): void {
  act(() => {
    root?.render(
      <Probe
        word={props.word === undefined ? 'фонарь' : props.word}
        history={props.history ?? true}
        signedIn={props.signedIn ?? false}
        viewerName={props.viewerName ?? null}
      />,
    );
  });
}

function Probe({
  word,
  history,
  signedIn,
  viewerName,
}: {
  word: string | null;
  history: boolean;
  signedIn: boolean;
  viewerName: string | null;
}) {
  const state = useProvenance({ blockId: BLOCK_ID, chapter: 8, word, frozen: false, history, signedIn, viewerName });
  return (
    <div>
      <span data-role="word">{state.view?.word ?? '—'}</span>
      <span data-role="action">{state.view?.action.label ?? ''}</span>
      <span data-role="chain">{state.view?.chain.map((node) => node.label).join(',') ?? ''}</span>
      {state.view?.rows.map((row) => (
        <span key={row.label} data-row={row.label}>
          {row.value}
        </span>
      ))}
      <button type="button" onClick={() => void state.load()}>
        load
      </button>
    </div>
  );
}

async function load(): Promise<void> {
  const button = document.querySelector<HTMLElement>('button');
  if (button === null) throw new Error('no load button');
  await act(async () => {
    button.click();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

const row = (label: string): string => document.querySelector(`[data-row="${label}"]`)?.textContent ?? '';

describe('the word panel’s one reader (BOOK-56)', () => {
  it('asks nothing with history off, and keeps only the word, its place and «вмешаться»', async () => {
    const fetchMock = stub({});
    probe({ history: false });

    await load();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-role="word"]')?.textContent).toBe('фонарь');
    expect(document.querySelector('[data-role="action"]')?.textContent).toBe('вмешаться здесь');
    expect(document.querySelector('[data-role="chain"]')?.textContent).toBe('');
    expect(document.querySelectorAll('[data-row]')).toHaveLength(0);
  });

  it('says a 404 is «нет истории», and asks the block only once', async () => {
    const fetchMock = stub({});
    probe();

    await load();
    expect(row('абзац')).toBe('у этой строки нет истории');

    await load();
    const chainCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/history/paragraphs/')).length;
    expect(chainCalls).toBe(1);
  });

  it('says the read failed when the chain answers with an error', async () => {
    stub({ '/api/history/paragraphs/': () => json({ code: 'BOOM' }, 500) });
    probe();

    await load();

    expect(row('абзац')).toBe('история не прочиталась');
  });

  it('prints the viewer’s own curve for their own word, and no public number beside it', async () => {
    stub({
      '/api/history/paragraphs/': () => json(CHAIN),
      '/api/authors/me': () => json({ label: 'Аня', edits: 2, chars: 40, share: 0.002, series: [], hidden: false, survivedRevisions: 4 }),
    });
    probe({ signedIn: true, viewerName: 'Аня' });

    await load();

    // The viewer's own curve only: no public number is ever printed for their own word.
    expect(row('след')).toBe('пережила 4 ревизии, сейчас 0,2 %');
    expect(row('кто внёс')).toBe('Аня');
    expect(document.querySelector('[data-role="chain"]')?.textContent).toBe('кто,правка,эта страница');
  });

  it('prints the published share for somebody else’s word', async () => {
    stub({
      '/api/history/paragraphs/': () => json(CHAIN),
      '/api/authors': () => json({ contributors: [{ label: 'Аня', share: 0.12, edits: 3 }] }),
    });
    probe({ signedIn: true, viewerName: 'Филипп' });

    await load();

    expect(row('след')).toBe('доля в книге 12,0 % · правок 3');
  });

  it('falls back to «след не измерен» when neither list answers', async () => {
    stub({ '/api/history/paragraphs/': () => json(CHAIN) });
    probe({ signedIn: true, viewerName: 'Филипп' });

    await load();

    expect(row('след')).toBe('след не измерен для этой строки');
  });

  it('reads nothing when no word’s panel is open', () => {
    probe({ word: null });

    expect(document.querySelector('[data-role="word"]')?.textContent).toBe('—');
    expect(document.querySelectorAll('[data-row]')).toHaveLength(0);
  });
});
