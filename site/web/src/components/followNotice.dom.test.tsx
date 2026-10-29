// @vitest-environment jsdom
import { partOf, type CatalogEntry, type ChangeDecidedPayload, type ChangeDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dismissNotice, landFrame, unfollow } from '../lib/follow.ts';
import { ChangeSection } from './ChangeSection.tsx';
import { ChapterHeader } from './ChapterHeader.tsx';

/**
 * BOOK-207 — the follow control in the record's `правка`, and its one place for a landing.
 *
 * The test takes the real surface: the section's last line is a `<button>` with the frozen
 * direction; a `change:decided` fixture for that change drops the follow and prints one mono
 * line at the head of the chapter the reader is in; `скрыть` removes it. An unfollowed change
 * leaves nothing behind.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CHANGE: ChangeDto = {
  id: 'chg_7',
  seq: 14,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 12,
  intent: 'убрать второе «слово» в абзаце',
  premise: false,
  premiseLanded: false,
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'processing',
  outcome: null,
  reason: null,
  position: null,
  relevance: null,
  cascade: {
    id: 'csc_7',
    status: 'open',
    outcome: null,
    wave: 2,
    depth: { forward: 10, backward: 4 },
    chaptersChecked: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    chaptersRewritten: [12],
    seams: [],
    wings: {
      down: { frontier: 12, wave: 0, state: 'waiting', reached: [] },
      up: { frontier: 21, wave: 2, state: 'moving', reached: [13, 14, 15, 16, 17, 18, 19, 20, 21] },
    },
    modes: [],
    gates: { cycles: 1, findingSurvived: false },
    tokens: { total: 100 },
    ms: 1_000,
  },
  modes: [],
  steps: [],
  appliedRevs: [],
  cost: null,
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-29T08:00:00Z',
  startedAt: '2026-10-29T08:10:00Z',
  decidedAt: null,
};

const DECIDED: ChangeDecidedPayload = {
  id: 'chg_7',
  commentId: 'cmt_1',
  outcome: 'applied',
  reason: null,
  chapters: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  cascade: null,
  relevance: null,
  tokens: { total: 100 },
  decidedAt: '2026-10-29T09:00:00Z',
};

const ENTRY: CatalogEntry = {
  n: 12,
  part: partOf(12),
  title: null,
  rev: 3,
  chars: 600,
  blocks: 1,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-29T07:00:00Z',
  updatedAt: '2026-10-29T07:00:00Z',
  direction: 'forward',
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  unfollow('chg_7');
  dismissNotice();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  // The chapter slot the notice is measured against (a landing keeps the prose in place).
  const article = document.createElement('article');
  article.id = 'ch-12';
  const paragraph = document.createElement('p');
  paragraph.className = 'p';
  article.append(paragraph);
  document.body.append(article);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function followButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button.follow-word');
  if (button === null) throw new Error('no follow control');
  return button;
}

function notice(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.ch-notice');
}

describe('the follow control and its landing notice', () => {
  it('prints the frozen direction in the record’s правка, then one notice at the read chapter', async () => {
    await act(async () => {
      root?.render(<ChangeSection change={CHANGE} before="дважды «слово»" after={null} />);
    });
    const button = followButton();
    expect(button.textContent).toBe('следить · вперёд · до главы 21');
    expect(button.getAttribute('aria-pressed')).toBeNull();
    await act(async () => button.click());
    expect(followButton().textContent).toBe('слежу · вперёд · до главы 21');
    expect(followButton().getAttribute('aria-pressed')).toBe('true');
    expect(followButton().getAttribute('data-follow')).toBe('on');

    // The frame lands while the reader is in chapter 12; the head prints one line there.
    await act(async () => {
      landFrame(DECIDED, 12);
    });
    await act(async () => {
      root?.render(<ChapterHeader entry={ENTRY} printing={false} status={null} basisSentence={null} />);
    });
    expect(notice()?.textContent).toBe('правка внесена · главы 12–21 · скрыть');
    expect(notice()?.getAttribute('role')).toBe('status');

    const hide = notice()?.querySelector<HTMLButtonElement>('button.ch-notice-hide');
    await act(async () => hide?.click());
    expect(notice()).toBeNull();
  });

  it('leaves nothing when the change was never followed', async () => {
    await act(async () => {
      landFrame(DECIDED, 12);
      root?.render(<ChapterHeader entry={ENTRY} printing={false} status={null} basisSentence={null} />);
    });
    expect(notice()).toBeNull();
  });

  it('ends the follow with the landing: a second frame does not bring the line back', async () => {
    await act(async () => {
      root?.render(<ChangeSection change={CHANGE} before={null} after={null} />);
    });
    await act(async () => followButton().click());
    await act(async () => {
      landFrame(DECIDED, 12);
    });
    await act(async () => {
      root?.render(<ChapterHeader entry={ENTRY} printing={false} status={null} basisSentence={null} />);
    });
    expect(notice()).not.toBeNull();
    await act(async () => {
      dismissNotice();
    });
    expect(notice()).toBeNull();
  });
});
