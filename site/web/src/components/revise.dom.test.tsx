// @vitest-environment jsdom
import type { CatalogEntry, CommentDto, CommentRevise } from '@book/shared';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { upsertFiling } from '../lib/filings.ts';
import { REVISE_BUDGET_LINE, reviseDraft } from '../lib/revise.ts';
import { SUBMIT_LINE } from '../lib/terms.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { closeSeam } from '../lib/useSeam.ts';
import { ChapterArticle } from './ChapterArticle.tsx';
import { Discussion } from './Discussion.tsx';
import { InterventionForm } from './InterventionForm.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-158 — a refusal is a place to come back to, on every surface that owns the filing.
 *
 * The reader is told three things and given one act: why it was refused (the row's own line),
 * what would make it pass (`hint`), and whether they may try now (`revise`). «исправить» then
 * reopens the strip with the filing's own text already in it and sends a **revision** of that
 * row — `POST /api/comments/:id/revise` — so the page shows one filing with one history
 * instead of a pile of near-duplicates.
 *
 * The fixtures are the page's own shapes: a written chapter's premise row (`ChapterArticle`)
 * for a premise, and the paragraph + register pair for a filing about a line of prose. The
 * pages hold their rows in state and write a posted DTO back with the very function the feed
 * uses (`upsertFiling`, which is what `acceptComment` is), so «updated in place» is tested on
 * the page and not on a mock.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 40,
  part: 4,
  title: 'Перевод смены',
  rev: 7,
  chars: 1_200,
  blocks: 3,
  written: true,
  basis: false,
  writtenAt: '2026-10-26T09:00:00Z',
  updatedAt: '2026-10-26T09:00:00Z',
  direction: 'backward',
};

const HINT = 'приведите название и дату источника цитаты';
const REASON = 'не принято: цитата без источника';
const EXHAUSTED = 'исчерпаны попытки — в следующий раз';

function revise(overrides: Partial<CommentRevise> = {}): CommentRevise {
  return { allowed: true, at: null, attemptsLeft: 2, closed: false, blocked: null, ...overrides };
}

/**
 * A premise the rights gate refused: the exact shape BOOK-158 exists for, and one a POST could
 * store — a chapter-level filing is a note, so it carries no kind without a proposed wording
 * (BOOK-16; a kind with `proposedText: null` is a row the posting path refuses).
 */
function refusedPremise(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01M5Z8HKWHPHZQDHP5MCXS5RB4',
    chapter: 40,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'смена переходит на ночь',
    proposedText: null,
    interventionKind: null,
    premise: true,
    status: 'rejected',
    frame: 'untouched',
    reason: REASON,
    hint: HINT,
    revise: revise(),
    refusal: 'rights',
    createdAt: '2026-10-27T18:04:17Z',
    decidedAt: '2026-10-27T18:20:00Z',
    changeId: null,
    applied: null,
    attempt: null,
    ...overrides,
  };
}

const BLOCK_ID = 'ch40#aa11bb22';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

/** A filing about a line of prose: the register's own kind of entry. */
function refusedBlock(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    ...refusedPremise(),
    id: 'cmt_block',
    premise: false,
    interventionKind: 'testimony',
    anchor: { blockId: BLOCK_ID, blockIndex: 1, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    ...overrides,
  };
}

class IdleObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IdleObserver);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => closeSeam());
  // The page's one panel is module state: a card left open here would render into the next test.
  await act(async () => hideFiling());
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** A controlled field needs the native setter, or React never sees the change. */
function typeInto(selector: string, value: string): void {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

/** What a stubbed `fetch` is, for this file: the calls, and nothing else. */
type FetchSpy = { mock: { calls: Array<[string, RequestInit?]> } };

/** Answers a revise with the same row, reopened — what the server sends after a revision. */
function respondWith(comment: CommentDto): FetchSpy {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify({ comment }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', spy);
  return spy as unknown as FetchSpy;
}

/** The one revise request the page made. */
function reviseCall(spy: FetchSpy): { url: string; method: string | undefined; payload: Record<string, unknown> } {
  const call = spy.mock.calls[0];
  if (call === undefined) throw new Error('no request was made');
  const [url, init] = call;
  return { url, method: init?.method, payload: JSON.parse(String(init?.body)) as Record<string, unknown> };
}

/** A written chapter's row, the register and the page's own acceptance — App, in one file. */
function ChapterPage({ initial }: { initial: readonly CommentDto[] }): ReactElement {
  const [rows, setRows] = useState<readonly CommentDto[]>(initial);
  return (
    <>
      <ChapterArticle
        entry={ENTRY}
        revision={null}
        revising={null}
        caret={null}
        fresh={false}
        history={false}
        comments={rows}
        changes={[]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Аня' }}
        onPosted={(comment) => setRows((current) => upsertFiling(current, comment) ?? current)}
      />
      <Discussion depth={0} comments={rows} changes={[]} live />
    </>
  );
}

/** One paragraph of prose with the register below it: the block filing's own page. */
function ProsePage({ initial }: { initial: readonly CommentDto[] }): ReactElement {
  const [rows, setRows] = useState<readonly CommentDto[]>(initial);
  return (
    <>
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={1}
        baseRev={ENTRY.rev}
        text={TEXT}
        blockCount={3}
        comments={rows}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Аня' }}
        onPosted={(comment) => setRows((current) => upsertFiling(current, comment) ?? current)}
        history={false}
      />
      <Discussion depth={0} comments={rows} changes={[]} live />
    </>
  );
}

describe('a refused premise (BOOK-158)', () => {
  it('a refused premise shows its reason, hint and revise, and the revise reopens the prefilled form', async () => {
    const refused = refusedPremise();
    await act(async () => root?.render(<ChapterPage initial={[refused]} />));

    // The row: the chapter's own line, the reason, the hint and the one door.
    expect(container.querySelector('#ch-40 .premise-note')?.textContent).toBe(REASON);
    expect(container.querySelector('#ch-40 .revise-hint')?.textContent).toBe(HINT);
    const door = container.querySelector<HTMLButtonElement>('#ch-40 .revise .seam-inline-action');
    expect(door?.textContent).toBe('исправить');
    expect(door?.disabled).toBe(false);

    // The card is the second surface the owner named: the same hint and the same door.
    await act(async () => container.querySelector<HTMLElement>('#ch-40 .premise-row')?.click());
    const panel = container.querySelector<HTMLElement>('.filing-panel');
    expect(panel?.querySelector('.revise-hint')?.textContent).toBe(HINT);
    expect(panel?.querySelector('.revise .seam-inline-action')?.textContent).toBe('исправить');
    // The refusal's own sentence is the card's fact line, and it is printed once.
    expect(panel?.querySelectorAll('.filing-fact')).toHaveLength(1);

    // One tap: the card closes and the strip opens with the filing's text already in it.
    const fetchSpy = respondWith({
      ...refused,
      status: 'new',
      body: 'смена переходит на вечер',
      reason: null,
      hint: null,
      revise: revise({ attemptsLeft: 1 }),
    });
    const cardDoor = panel?.querySelector<HTMLButtonElement>('.revise .seam-inline-action');
    await act(async () => cardDoor?.click());

    expect(container.querySelector('.filing-panel')).toBeNull();
    const form = container.querySelector<HTMLFormElement>('#ch-40 .seam-form');
    expect(form).not.toBeNull();
    // No retyping: the premise's own text sits in its one field, and the reader edits it there.
    expect(container.querySelector<HTMLTextAreaElement>('#seam-text-40')?.value).toBe('смена переходит на ночь');
    typeInto('#seam-text-40', 'смена переходит на вечер');

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // The row is revised, not filed again: the words go to the revise endpoint, the anchor does not.
    expect(fetchSpy.mock.calls).toHaveLength(1);
    const { url, method, payload } = reviseCall(fetchSpy);
    expect(url).toBe(`/api/comments/${refused.id}/revise`);
    expect(method).toBe('POST');
    // A note sends one text: the wording the reader typed, and no kind (BOOK-16).
    expect(payload).toEqual({ body: 'смена переходит на вечер' });
    expect(payload).not.toHaveProperty('blockId');
    expect(payload).not.toHaveProperty('quote');
    expect(payload).not.toHaveProperty('baseRev');

    // The same row, updated in place: new words, and the refusal's line and door are gone.
    expect(container.querySelector('#ch-40 .premise-quote')?.textContent).toBe('«смена переходит на вечер»');
    expect(container.querySelector('#ch-40 .premise-note')).toBeNull();
    expect(container.querySelector('#ch-40 .revise')).toBeNull();
    expect(container.querySelectorAll(`#ch-40 [data-comment-id="${refused.id}"]`)).toHaveLength(1);
  });

  it('a cooldown disables revise and says how long', async () => {
    const at = new Date(Date.now() + 7 * 60_000).toISOString();
    await act(async () =>
      root?.render(
        <ChapterPage initial={[refusedPremise({ id: 'cmt_cooling', revise: revise({ allowed: false, at, blocked: 'cooldown' }) })]} />,
      ),
    );

    const door = container.querySelector<HTMLButtonElement>('#ch-40 .revise .seam-inline-action');
    expect(door?.disabled).toBe(true);
    expect(container.querySelector('#ch-40 .revise-why')?.textContent).toBe('можно повторить через 7 минут');
    // The hint stays: the reader still knows what would make it pass.
    expect(container.querySelector('#ch-40 .revise-hint')?.textContent).toBe(HINT);
  });

  it('an exhausted filing says so', async () => {
    await act(async () =>
      root?.render(
        <ChapterPage
          initial={[
            refusedPremise({ id: 'cmt_spent', revise: revise({ allowed: false, closed: true, attemptsLeft: 0, blocked: 'attempts' }) }),
          ]}
        />,
      ),
    );
    expect(container.querySelector<HTMLButtonElement>('#ch-40 .revise .seam-inline-action')?.disabled).toBe(true);
    expect(container.querySelector('#ch-40 .revise-why')?.textContent).toBe(EXHAUSTED);
  });
});

/**
 * BOOK-156 renamed the register's section to `id="discussion"` and kept a zero-height `#talks`
 * span for the old deep link, so the header's own `#talks` no longer wraps an entry: the
 * register's filings are reached through `#discussion`. The assertions are unchanged.
 */
describe('a refused filing in the register (BOOK-158)', () => {
  it('a non-premise refusal gets the same hint and revise in the register', async () => {
    const refused = refusedBlock();
    const fetchSpy = respondWith({ ...refused, status: 'new', reason: null, hint: null, revise: revise({ attemptsLeft: 1 }) });
    await act(async () => root?.render(<ProsePage initial={[refused]} />));

    const entry = container.querySelector('#discussion .comment');
    expect(entry?.getAttribute('data-comment-id')).toBe(refused.id);
    // The register's state line keeps the rule's sentence; the block under it adds the hint and
    // the door. BOOK-189: the gate's word heads that line, so it is stripped from the reason and
    // printed once — the sentence itself stays whole.
    expect(entry?.querySelector('.comment-reason')?.textContent).toContain('цитата без источника');
    expect(entry?.querySelector('.comment-revise .revise-hint')?.textContent).toBe(HINT);
    const door = entry?.querySelector<HTMLButtonElement>('.comment-revise .seam-inline-action');
    expect(door?.textContent).toBe('исправить');

    // One tap opens the strip **at the paragraph the filing belongs to**, with its words in it.
    await act(async () => door?.click());
    const form = container.querySelector<HTMLFormElement>('.seam-form');
    expect(form).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('.seam-input')?.value).toBe(
      'в комнате должен быть свет, но не от лампы',
    );
    expect(container.querySelector<HTMLTextAreaElement>('.seam-text')?.value).toBe('Свет был включён до меня.');

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const { url, payload } = reviseCall(fetchSpy);
    expect(url).toBe(`/api/comments/${refused.id}/revise`);
    expect(payload).toEqual({
      body: 'в комнате должен быть свет, но не от лампы',
      proposedText: 'Свет был включён до меня.',
      interventionKind: 'testimony',
    });

    // The answer is the same entry, updated where it stood — one filing, one history.
    expect(container.querySelectorAll('#discussion .comment')).toHaveLength(1);
    expect(container.querySelector('#discussion .comment-revise')).toBeNull();
  });
});

describe('the revise form (BOOK-158)', () => {
  it('the form states where the daily edit is spent', () => {
    const draft = reviseDraft(refusedBlock());
    act(() =>
      root?.render(
        <InterventionForm
          entry={ENTRY}
          draft={draft}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
          onChange={() => undefined}
          onPosted={() => undefined}
        />,
      ),
    );

    const line = container.querySelector('p.fine.seam-revise');
    expect(line?.textContent).toBe(REVISE_BUDGET_LINE);
    expect(REVISE_BUDGET_LINE).toContain('списывается только за принятую');
    // The submit says what the act is, and the licence line is still the one under it.
    expect(container.querySelector('button.seam-submit')?.textContent).toBe('исправить');
    expect(container.querySelector('p.fine.seam-licence')?.textContent).toContain(SUBMIT_LINE);
  });

  it('says nothing about a revision on a new filing', () => {
    const draft = { ...reviseDraft(refusedBlock()), revisesId: null };
    act(() =>
      root?.render(
        <InterventionForm
          entry={ENTRY}
          draft={draft}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
          onChange={() => undefined}
          onPosted={() => undefined}
        />,
      ),
    );
    expect(container.querySelector('.seam-revise')).toBeNull();
    expect(container.querySelector('button.seam-submit')?.textContent).toBe('передать');
  });

  it('a held filing gets the hint and no revise button at all', async () => {
    const held = refusedBlock({
      id: 'cmt_held',
      status: 'quarantined',
      refusal: 'held',
      hint: 'уберите из текста указания в адрес модели',
      revise: revise({ allowed: false, attemptsLeft: 2 }),
    });
    await act(async () => root?.render(<ProsePage initial={[held]} />));

    const entry = container.querySelector('#discussion .comment');
    expect(entry?.querySelector('.comment-revise .revise-hint')?.textContent).toBe(
      'уберите из текста указания в адрес модели',
    );
    // Nothing to wait out, so no door and no sentence about a limit the server did not name.
    expect(entry?.querySelector('.comment-revise .seam-inline-action')).toBeNull();
    expect(entry?.querySelector('.comment-revise .revise-why')).toBeNull();
  });
});
