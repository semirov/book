// @vitest-environment jsdom
import { FAILED_ATTEMPT_LINE, type CatalogEntry, type ChangeSummaryDto, type CommentDto } from '@book/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { closeSeam } from '../lib/useSeam.ts';
import { ChapterArticle } from './ChapterArticle.tsx';
import { Discussion } from './Discussion.tsx';

/**
 * BOOK-137 — **one filing is one entry**, on the page and not in a fixture.
 *
 * The prod page showed the premise `cmt_01M5Z8HKWHPHZQDHP5MCXS5RB4` twice: as a comment block
 * in `ОБСУЖДЕНИЕ` and as the chapter's own premise row — the same words, two numbers, two
 * states, and «в очереди пусто» printed above an entry that looked queued. The owner's phone
 * shows the pair; this file pins the single entry and counts it three ways: by
 * `data-comment-id`, by the attempt's number and by the `прицел` link.
 *
 * The chapter is **written** in the fixture: the premise entered the first edition, which is
 * exactly the case where the old page lost the row and kept the duplicate block.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 65,
  part: 3,
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

const PREMISE: CommentDto = {
  attempt: null,
  id: 'cmt_01M5Z8HKWHPHZQDHP5MCXS5RB4',
  chapter: 65,
  anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: 'смена переходит на ночь, а не на утро',
  proposedText: null,
  interventionKind: 'document',
  premise: true,
  // BOOK-136's matrix: a premise whose chapter has text is «внесено», whatever the change row
  // went on to say after a failed attempt.
  status: 'applied',
  frame: 'untouched',
  reason: null,
  refusal: null,
  createdAt: '2026-10-27T18:04:17Z',
  decidedAt: null,
  changeId: 'chg_premise',
  applied: { chapter: 65, rev: 7 },
};

const ATTEMPT: ChangeSummaryDto = {
  premiseLanded: true,
  sourceCommentId: PREMISE.id,
  id: 'chg_premise',
  seq: 1,
  chapter: 65,
  intent: 'смена переходит на ночь, а не на утро',
  premise: true,
  status: 'done',
  frame: 'untouched',
  frameMode: null,
  outcome: 'applied',
  reason: null,
  position: null,
  enqueuedAt: '2026-10-27T18:04:20Z',
  decidedAt: '2026-10-27T18:20:00Z',
  chapters: [65],
  rewritten: [65],
  steps: 1,
  modes: [],
  cascade: null,
};

/** A filing about a line of prose: the thread's own kind of entry. */
const NOTE: CommentDto = {
  ...PREMISE,
  id: 'cmt_note',
  chapter: 9,
  premise: false,
  interventionKind: null,
  body: 'тут дважды «слово»',
  changeId: null,
  applied: null,
  status: 'new',
  createdAt: '2026-10-27T19:00:00Z',
};

class IdleObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IdleObserver);
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

async function mount(comments: CommentDto[], changes: ChangeSummaryDto[]): Promise<void> {
  const page: ReactElement = (
    <>
      <ChapterArticle
        entry={ENTRY}
        revision={null}
        revising={null}
        caret={null}
        fresh={false}
        history
        comments={comments}
        changes={changes}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Аня' }}
      />
      <Discussion depth={0} comments={comments} changes={changes} live />
    </>
  );
  await act(async () => root?.render(page));
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('one filing, one entry (BOOK-137)', () => {
  it('renders a written chapter’s premise once: one id, one number, one state word, one прицел', async () => {
    await mount([PREMISE], [ATTEMPT]);
    const text = container.textContent ?? '';

    // Exactly one element carries the filing's id — the chapter's row.
    expect(container.querySelectorAll(`[data-comment-id="${PREMISE.id}"]`)).toHaveLength(1);
    // Exactly one attempt number, one state word and one link, all on that entry.
    expect(container.querySelectorAll('.premise-attempt')).toHaveLength(1);
    expect(container.querySelector('.premise-attempt')?.textContent).toBe('001');
    expect(count(text, '001')).toBe(1);
    expect(count(text, 'внесено')).toBe(1);
    expect(container.querySelector('.premise-label')?.textContent).toBe('внесено');
    expect(container.querySelectorAll('.premise-open')).toHaveLength(1);
    expect(count(text, 'прицел')).toBe(1);
    expect(container.querySelector('.premise-open')?.getAttribute('href')).toBe('#правка-chg_premise');
    // The link is a sibling of the row's button, never inside it: one tap, one act.
    expect(container.querySelector('.premise-row .premise-open')).toBeNull();

    // The register prints no block for it — the premise has one home, the chapter.
    expect(container.querySelector('#discussion .comment')).toBeNull();
    expect(container.querySelector('#discussion [data-comment-id]')).toBeNull();
    expect(container.querySelector('#discussion')?.textContent ?? '').not.toContain('смена переходит на ночь');

    // No contradiction with the queue line: the premise holds no queue place, and nothing on
    // the page presents it as queued.
    expect(container.querySelector('#discussion .qline')?.textContent).toContain('в очереди пусто');
    expect(count(text, 'ждёт')).toBe(0);
  });

  it('renders a premise and an unrelated filing as two entries, each once', async () => {
    await mount([PREMISE, NOTE], [ATTEMPT]);
    const text = container.textContent ?? '';

    expect(container.querySelectorAll(`[data-comment-id="${PREMISE.id}"]`)).toHaveLength(1);
    expect(container.querySelectorAll(`[data-comment-id="${NOTE.id}"]`)).toHaveLength(1);
    // One entry from the chapter's row, one from the register: two blocks, not three.
    expect(container.querySelectorAll('#discussion .comment')).toHaveLength(1);
    expect(container.querySelector('#discussion .comment')?.getAttribute('data-comment-id')).toBe(NOTE.id);
    // The number belongs to the premise's attempt and appears once on the page.
    expect(count(text, '001')).toBe(1);
    expect(container.querySelectorAll('.premise-open')).toHaveLength(1);
    expect(count(text, 'прицел')).toBe(1);
    // One queued filing, and the line counts exactly it.
    expect(container.querySelector('#discussion .qline')?.textContent).toContain('в очереди 1 правка');
  });

  it('keeps the attempts inside the premise’s card: one number on the row, none in the panel', async () => {
    // BOOK-137 — a change is never a row beside its filing. The row names the latest attempt
    // once; the card carries what the row cannot (the derived reading) and the earlier
    // attempts, without a second number or a second link.
    const attempt = (overrides: Partial<ChangeSummaryDto>): ChangeSummaryDto => ({
      premiseLanded: false,
      sourceCommentId: PREMISE.id,
      id: 'chg_1',
      seq: 1,
      chapter: 65,
      intent: 'смена переходит на ночь',
      premise: true,
      status: 'pending',
      frame: 'untouched' as const,
      frameMode: null,
      outcome: null,
      reason: null,
      position: null,
      enqueuedAt: '2026-10-27T18:05:00Z',
      decidedAt: null,
      chapters: [65],
      rewritten: [],
      steps: 0,
      modes: [],
      cascade: null,
      ...overrides,
    });
    const changes = [
      attempt({ id: 'chg_1', seq: 1, status: 'void', outcome: 'dropped', reason: 'основа сдвинулась' }),
      attempt({ id: 'chg_2', seq: 2, intent: 'смена переходит на ночь, а не на утро' }),
    ];
    // The chapter still waits for its first pass: the row is the same entry, and the card is
    // where the attempts before the latest one live.
    const waiting: CommentDto = { ...PREMISE, status: 'new', applied: null, changeId: 'chg_2' };
    const empty: CatalogEntry = { ...ENTRY, written: false, title: null, rev: 0, chars: 0, blocks: 0 };

    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={empty}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          firstEmpty
          history={false}
          comments={[waiting]}
          changes={changes}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
        />,
      );
    });

    const row = container.querySelector<HTMLElement>('#ch-65 .premise-row');
    expect(row?.getAttribute('data-comment-id')).toBe(waiting.id);
    expect(row?.querySelector('.premise-label')?.textContent).toBe('ждёт');
    const meta = container.querySelector('#ch-65 .premise-meta');
    expect(meta?.querySelector('.premise-attempt')?.textContent).toBe('002');
    expect(meta?.querySelectorAll('.premise-open')).toHaveLength(1);
    expect(meta?.querySelector('.premise-open')?.getAttribute('href')).toBe('#правка-chg_2');

    await act(async () => row?.click());
    const panel = container.querySelector<HTMLElement>('.filing-panel');
    expect(panel).not.toBeNull();
    // The derived reading: what was accepted into the basis, in the change's own words.
    expect(panel?.querySelector('.filing-fact')?.textContent).toBe(
      'принято в основу: смена переходит на ночь, а не на утро',
    );
    // The earlier attempt, inside the entry: one line, no number and no link.
    const earlier = panel?.querySelectorAll('.filing-attempt') ?? [];
    expect(earlier).toHaveLength(1);
    expect(earlier[0]?.textContent).toContain('основа сдвинулась');
    expect(panel?.querySelectorAll('a')).toHaveLength(0);
    expect(panel?.textContent ?? '').not.toContain('002');
    expect(panel?.textContent ?? '').not.toContain('прицел');
  });

  it('prints the failed attempt’s sentence under the row and in the card (BOOK-136)', async () => {
    // The measured fixture: a chapter-level filing on ch65 with no text, its one attempt came
    // back empty. The row said «ждёт» and nothing else, so the wait read as an ordinary one.
    const failed: CommentDto = {
      ...PREMISE,
      status: 'new',
      applied: null,
      attempt: 'failed',
      changeId: 'chg_failed',
    };
    const attempt: ChangeSummaryDto = {
      ...ATTEMPT,
      id: 'chg_failed',
      premiseLanded: false,
      status: 'void',
      outcome: 'dropped',
      reason: 'PROVIDER_SHAPE',
    };
    const empty: CatalogEntry = { ...ENTRY, written: false, title: null, rev: 0, chars: 0, blocks: 0 };

    await act(async () => {
      root?.render(
        <ChapterArticle
          entry={empty}
          revision={null}
          revising={null}
          caret={null}
          fresh={false}
          firstEmpty
          history={false}
          comments={[failed]}
          changes={[attempt]}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
        />,
      );
    });

    const text = container.textContent ?? '';
    // One state word, one human sentence — and the engine's own code never on the page.
    expect(count(text, 'ждёт')).toBe(1);
    expect(count(text, FAILED_ATTEMPT_LINE)).toBe(1);
    expect(container.querySelector('#ch-65 .premise-note')?.textContent).toBe(FAILED_ATTEMPT_LINE);
    expect(container.querySelector('.premise-row .premise-note')).toBeNull();
    expect(text).not.toContain('PROVIDER_SHAPE');

    const row = container.querySelector<HTMLElement>('#ch-65 .premise-row');
    await act(async () => row?.click());
    const panel = container.querySelector<HTMLElement>('.filing-panel');
    // The card says the same sentence, beside the derived reading of what was accepted.
    expect(panel?.textContent).toContain(FAILED_ATTEMPT_LINE);
    expect(panel?.querySelector('.filing-fact')?.textContent).toBe(
      `${FAILED_ATTEMPT_LINE} · принято в основу: смена переходит на ночь, а не на утро`,
    );
    expect(panel?.textContent ?? '').not.toContain('PROVIDER_SHAPE');
  });
});
