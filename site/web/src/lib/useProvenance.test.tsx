// @vitest-environment jsdom
import type { ParagraphChainDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetParagraphChainCache } from './paragraphChainCache.ts';
import type { WordFiling } from './provenance.ts';
import { useProvenance } from './useProvenance.ts';

/**
 * BOOK-128 comment #3815 (BOOK-33, BOOK-56, BOOK-68) — the one reader behind the word's margin.
 *
 * The hook is the whole answer to «what may the word's block print now»: the chain's state, the
 * viewer's own trace and the hand. Nothing is printed before the log answers, a failure says so
 * in one line, and with history off nothing is asked at all (the door is not rendered either).
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

type ProbeProps = {
  word: string | null;
  history: boolean;
  signedIn: boolean;
  viewerName: string | null;
  frozenOf?: 'frame' | 'basis' | null;
  filing?: WordFiling | null;
};

function probe(props: Partial<ProbeProps> = {}): void {
  act(() => {
    root?.render(
      <Probe
        word={props.word === undefined ? 'фонарь' : props.word}
        history={props.history ?? true}
        signedIn={props.signedIn ?? false}
        viewerName={props.viewerName ?? null}
        frozenOf={props.frozenOf ?? null}
        filing={props.filing ?? null}
      />,
    );
  });
}

function Probe({ word, history, signedIn, viewerName, frozenOf = null, filing = null }: ProbeProps) {
  const state = useProvenance({ blockId: BLOCK_ID, word, frozenOf, history, signedIn, viewerName, filing });
  return (
    <div>
      <span data-role="hand">{state.view?.hand ?? '—'}</span>
      <span data-role="when">{state.view?.when ?? ''}</span>
      <span data-role="trace">{state.view?.trace ?? ''}</span>
      <span data-role="gloss">{state.view?.gloss ?? ''}</span>
      <span data-role="failed">{state.failed ? 'failed' : ''}</span>
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

const cell = (role: string): string => document.querySelector(`[data-role="${role}"]`)?.textContent ?? '';

describe('the word panel’s one reader (BOOK-56)', () => {
  it('asks nothing with history off — the door is not rendered either', async () => {
    const fetchMock = stub({});
    probe({ history: false });

    await load();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cell('hand')).toBe('—');
    expect(cell('trace')).toBe('');
  });

  it('prints no facts until the log answers, and a 404 is an answer', async () => {
    const fetchMock = stub({});
    probe();

    expect(cell('hand')).toBe('—');
    await load();
    expect(cell('hand')).toBe('машина');
    expect(cell('when')).toBe('вне правок');
    expect(cell('trace')).toBe('следа нет');
    expect(cell('gloss')).toBe('машина внесла правку; рамку держит автор.');

    await load();
    const chainCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/history/paragraphs/')).length;
    expect(chainCalls).toBe(1);
  });

  it('says the read failed when the chain answers with an error — and prints no fact', async () => {
    stub({ '/api/history/paragraphs/': () => json({ code: 'BOOM' }, 500) });
    probe();

    await load();

    expect(cell('failed')).toBe('failed');
    expect(cell('hand')).toBe('—');
  });

  it('prints the viewer’s own curve for their own word, and the reader’s name as the hand', async () => {
    stub({
      '/api/history/paragraphs/': () => json(CHAIN),
      '/api/authors/me': () => json({ label: 'Аня', edits: 2, chars: 40, share: 0.002, series: [], hidden: false, survivedRevisions: 4 }),
    });
    probe({ signedIn: true, viewerName: 'Аня' });

    await load();

    // The viewer's own curve only: no public number is ever printed for their own word.
    expect(cell('hand')).toBe('Аня');
    expect(cell('trace')).toBe('пережила 4 редакции');
    expect(cell('gloss')).toBe('');
  });

  it('prints «след не измерен» for somebody else’s word', async () => {
    stub({
      '/api/history/paragraphs/': () => json(CHAIN),
      '/api/authors': () => json({ contributors: [{ label: 'Аня', share: 0.12, edits: 3 }] }),
    });
    probe({ signedIn: true, viewerName: 'Филипп' });

    await load();

    expect(cell('hand')).toBe('Аня');
    expect(cell('trace')).toBe('след не измерен');
  });

  it('names the frozen surface the paragraph is, not the version behind it', async () => {
    stub({ '/api/history/paragraphs/': () => json(CHAIN) });
    probe({ frozenOf: 'basis' });

    await load();

    expect(cell('hand')).toBe('основание книги');
    expect(cell('when')).toBe('вне правок');
  });

  it('names the filing standing on the word, and its state, in line 3', async () => {
    stub({ '/api/history/paragraphs/': () => json(CHAIN) });
    probe({ filing: { number: '1', seq: null, state: 'ждёт', href: '#ch-8-b3' } });

    await load();

    expect(cell('hand')).toBe('замечание 1');
    expect(cell('trace')).toBe('замечание 1 · ждёт');
    expect(cell('gloss')).toBe('');
  });

  it('reads nothing when no word’s block is open', () => {
    probe({ word: null });

    expect(cell('hand')).toBe('—');
    expect(cell('trace')).toBe('');
  });
});
