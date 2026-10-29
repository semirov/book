// @vitest-environment jsdom
import {
  partOf,
  STAGE_DEADLINE_MS,
  TOTAL_CHAPTERS,
  type CatalogEntry,
  type ChangeQueuedPayload,
  type ChapterAppliedPayload,
  type FilingReadingPayload,
  type LivePayload,
  type PassAcceptedPayload,
  type PassStageEvent,
  type StateSnapshot,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initialClientState, withLive, type ClientState } from '../lib/clientState.ts';
import { apply, resetSeq } from '../lib/framesFixtures.ts';
import { LINGER_MS } from '../lib/nowState.ts';
import { Header } from './Header.tsx';
import { firstDeclarations } from './cssRules.ts';

/**
 * BOOK-DOC-84 §11.1 — the head's status line, mounted in the real head.
 *
 * What is asserted here is the DOM contract: the line is its own row under the brand row (not a
 * node in `.top-row`, not a badge), it is one real `<a>` to the place it names (or no link at
 * all), it rests four seconds after an ending and then the node is gone, the author's line
 * exists only for the author, and no rendered word is machinery. The **pixel** check — the
 * first paragraph's top moving ≤1 px, and two rows at 390 / one at 1440 — needs a layout engine
 * and lives in `scripts/head-cdp.mjs`; jsdom has none, so the reserved height is asserted as the
 * style that makes it zero (`position: absolute` inside the head's own box).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** 17:04 in Moscow — the contract's example time. */
const T = Date.parse('2026-10-29T14:04:00Z');
const MINUTE = 60_000;

const STATE: StateSnapshot = {
  version: 1,
  at: '2026-10-29T14:04:00Z',
  engine: { status: 'running', heartbeatAt: '2026-10-29T14:03:30Z', laneId: 'forward' },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: '2026-10-29T10:00:00Z' },
  chapters: { total: TOTAL_CHAPTERS, written: [1], empty: [], count: 1, totalChars: 12_000, basis: [] },
  cursors: {} as StateSnapshot['cursors'],
  toc: [],
  meeting: { forwardFront: 1, backwardFront: TOTAL_CHAPTERS, gap: 0, converged: false, seam: 'not_reached' },
  cascade: null,
  queue: {
    depth: 0,
    byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
    head: null,
    processing: null,
    lastDecidedAt: null,
  },
  revising: [],
  current: null,
  unresolved: [],
  activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
  history: { live: false, readerChanges: 0, started: false },
};

const CATALOG: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  return {
    n,
    part: partOf(n),
    title: null,
    rev: n === 1 ? 2 : 0,
    chars: n === 1 ? 600 : 0,
    blocks: n === 1 ? 1 : 0,
    written: n === 1,
    basis: false,
    opening: null,
    writtenAt: n === 1 ? '2026-10-29T12:00:00Z' : null,
    updatedAt: n === 1 ? '2026-10-29T12:00:00Z' : null,
    direction: n <= 21 ? 'forward' : 'backward',
  } as CatalogEntry;
});

const LIVE: LivePayload = {
  at: '2026-10-29T14:04:00Z',
  passes: [],
  applied: null,
  queue: { depth: 0, pending: [] },
  filings: [{ commentId: 'cmt_012', chapter: 4, state: 'accepted', attempts: 1, attemptsLeft: 3, changeId: 'chg_12', at: '2026-10-29T14:04:00Z' }],
  lane: { passesToday: 1, maxPasses: 4, writerAt: null },
  lastCost: { kind: 'pass', usd: 0.05, at: T, estimated: false, dayUsd: 0.05 },
};

function page(overrides: Partial<LivePayload> = {}): ClientState {
  return withLive(initialClientState(), { ...LIVE, ...overrides });
}

const queued: ChangeQueuedPayload = {
  id: 'chg_12',
  seq: 12,
  kind: 'reader_edit',
  chapter: 4,
  intent: 'поправить',
  source: { commentId: 'cmt_012', author: 'Аня' },
  queue: { depth: 3, ahead: 2 },
  base: { rev: 1 },
  scopeHint: 'phrase',
  at: T - 5 * MINUTE,
  eventSeq: 1,
};

/** The page after a change was accepted: its number is the change's own `seq`. */
const base = (): ClientState => apply(page(), 'change:queued', queued).state;

const reading = (overrides: Partial<FilingReadingPayload> = {}): FilingReadingPayload => ({
  commentId: 'cmt_012',
  chapter: 4,
  phase: 'claimed',
  attempt: 1,
  maxAttempts: 5,
  widened: null,
  desperate: false,
  at: T,
  deadlineAt: T + 900_000,
  retryAt: null,
  reason: null,
  costUsd: null,
  estimated: false,
  readingSeq: 1,
  ...overrides,
});

const accepted: PassAcceptedPayload = {
  stepId: 'stp_1',
  chapter: 1,
  lane: 'forward',
  pass: 'change',
  premiseChangeId: 'chg_12',
  at: T,
  ahead: 0,
  attempt: 1,
  maxAttempts: 5,
  widened: null,
  desperate: false,
  deadlineAt: T + 225 * MINUTE,
  retryAt: null,
};

const stage = (name: PassStageEvent['stage'], overrides: Partial<PassStageEvent> = {}): PassStageEvent => ({
  passId: 'stp_1',
  chapter: 1,
  stageSeq: 1,
  stage: name,
  at: T,
  actor: { process: 'writer', model: null },
  changeId: 'chg_12',
  summary: '',
  span: null,
  tokens: null,
  costUsd: null,
  attempt: 1,
  maxAttempts: 5,
  deadlineAt: T + STAGE_DEADLINE_MS,
  ...overrides,
});

const applied: ChapterAppliedPayload = {
  n: 1,
  rev: 13,
  hseq: 9,
  appliedAt: Date.parse('2026-10-29T14:12:00Z'),
  createdAt: '2026-10-29T14:12:00Z',
  kind: 'edit',
  cause: { stepId: 'stp_1', changeId: 'chg_12', cascadeId: null, lane: 'forward', direction: 'forward' },
  patch: [{ op: 'replace', id: 'ch01#a', i: 0, newId: 'ch01#b', text: 'Новый абзац' }],
  patchTruncated: false,
  span: [{ blockId: 'ch01#a', before: 'Старый абзац', after: 'Новый абзац', truncated: false }],
  chars: 120,
  delta: 20,
  blocksTouched: 1,
  attributed: true,
};

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(client: ClientState, options: { nowMs?: number | null; offlineAt?: number | null } = {}): Promise<void> {
  await act(async () => {
    root?.render(
      <Header
        state={STATE}
        ribbon={null}
        catalog={CATALOG}
        markers={[]}
        onOpenChange={() => undefined}
        live
        client={client}
        offlineAt={options.offlineAt ?? null}
        {...(options.nowMs === null ? {} : { nowMs: options.nowMs ?? T })}
        reading={{ n: 1, page: 1 }}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** The line's own text, with the separators' no-break space read as a space. */
function text(): string | null {
  const node = container.querySelector('.head-line');
  if (node === null) return null;
  return (node.textContent ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

beforeEach(async () => {
  resetSeq();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  await mount(page());
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('§11.1 — idle is no node at all', () => {
  it('renders nothing, and the head reserves no room for it', async () => {
    await mount(page());
    expect(container.querySelector('.head-line')).toBeNull();
    // The row is still one row, the brand and the folio as before; no placeholder, no word.
    expect(container.querySelectorAll('.top-row')).toHaveLength(1);
    expect(text()).toBeNull();
    // The reserved height is zero by construction: the line is absolutely placed in the head's
    // own box, so nothing below it is given a spacer (the pixel proof is the CDP harness).
    const css = sheets['../styles/head-status.css'] ?? '';
    expect(firstDeclarations(css, '.head-line')).toContain('position: absolute');
    expect(firstDeclarations(css, '.top-in')).toContain('position: relative');
  });
});

describe('§11.1 — the line, per state', () => {
  it('reads the filing with its try and the frame’s clock, as one link to its record', async () => {
    const client = apply(base(), 'filing:reading', reading()).state;
    await mount(client);
    expect(text()).toBe('машина читает правку 012 · попытка 1 из 5 · 17:04');
    const door = container.querySelector<HTMLAnchorElement>('.head-line a');
    expect(door).not.toBeNull();
    expect(door?.getAttribute('href')).toBe('#ch-4');
    expect(door?.textContent).toContain('машина читает правку 012');
    // The whole line is the door: the `<a>` carries every part of the state.
    expect(door?.querySelectorAll('.head-line-part').length).toBe(3);
  });

  it('waits with the queue’s place, and the door is still the filing', async () => {
    const client = apply(page(), 'change:queued', queued).state;
    await mount(client);
    expect(text()).toBe('правка 012 ждёт: впереди 2 · 16:59');
    expect(container.querySelector('.head-line a')?.getAttribute('href')).toBe('#ch-4');
  });

  it('writes a chapter, to the chapter’s own fragment', async () => {
    const client = apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state;
    await mount(client);
    expect(text()).toBe('машина пишет главу 1 · правка 012 · попытка 1 из 5 · 17:04');
    expect(container.querySelector('.head-line a')?.getAttribute('href')).toBe('#ch-1');
  });

  it('checks with the gate and its round', async () => {
    const at = Date.parse('2026-10-29T14:08:00Z');
    const client = apply(
      apply(base(), 'pass:accepted', accepted).state,
      'pass:stage',
      stage('verdict', { at, gate: 'editor', round: 1, stageSeq: 2 }),
    ).state;
    await mount(client, { nowMs: at });
    expect(text()).toBe('машина проверяет главу 1 · правка 012 · редактор, раунд 1 · 17:08');
  });

  it('fixes by a remark with the frame’s own iteration', async () => {
    const at = Date.parse('2026-10-29T14:09:00Z');
    const client = apply(
      apply(base(), 'pass:accepted', accepted).state,
      'pass:stage',
      stage('revising', { at, iteration: 2, maxIterations: 5, stageSeq: 2 }),
    ).state;
    await mount(client, { nowMs: at });
    expect(text()).toBe('машина правит по замечанию · правка 012 · поправка 2 из 5 · 17:09');
  });

  it('announces the write with its edition', async () => {
    const client = apply(page(), 'chapter:applied', applied).state;
    await mount(client, { nowMs: applied.appliedAt });
    expect(text()).toBe('внесено · глава 1, редакция 13 · 17:12');
    expect(container.querySelector('.head-line a')?.getAttribute('href')).toBe('#ch-1');
  });
});

describe('§11.1 — the ending rests four seconds, then the node is gone', () => {
  it('keeps the line for 4 s after a terminal frame and removes it without a transition', async () => {
    const client = apply(page(), 'chapter:applied', applied).state;
    await mount(client, { nowMs: applied.appliedAt + 3_999 });
    expect(container.querySelector('.head-line')).not.toBeNull();
    await act(async () => {
      root?.render(
        <Header
          state={STATE}
          ribbon={null}
          catalog={CATALOG}
          markers={[]}
          onOpenChange={() => undefined}
          live
          client={client}
          nowMs={applied.appliedAt + LINGER_MS}
          reading={{ n: 1, page: 1 }}
        />,
      );
    });
    expect(container.querySelector('.head-line')).toBeNull();
    const css = sheets['../styles/head-status.css'] ?? '';
    expect(firstDeclarations(css, '.head-line')).toContain('transition: none');
  });
});

describe('§11.1 — no link where there is nothing to open', () => {
  it('prints нет связи without a door', async () => {
    await mount(page(), { nowMs: T, offlineAt: T });
    expect(text()).toBe('нет связи · 17:04');
    expect(container.querySelector('.head-line a')).toBeNull();
    expect(container.querySelector('.head-line')?.getAttribute('data-kind')).toBe('offline');
  });
});

describe('§11.1 — the author’s own line', () => {
  it('is printed for an author and for nobody else', async () => {
    const client = apply(base(), 'filing:reading', reading()).state;
    await mount(client);
    expect(container.querySelector('.head-line-author')).toBeNull();

    const author: ClientState = { ...client, viewer: { signedIn: true, displayName: 'Аня', isAuthor: true } };
    await mount(author);
    // No place in the queue is «следом», never «впереди 0»: a count of nothing is not a count.
    // The leading separator belongs to the phone's row (jsdom paints no sheet, so it is read
    // here); above 767 the author's line is a row of its own and `head-status.css` hides it.
    const authorText = (container.querySelector('.head-line-author')?.textContent ?? '')
      .replace(/\u00a0/gu, ' ')
      .replace(/^\s*·\s*/u, '');
    expect(authorText).toBe('следом · 0,05 $');
    // The author's line is not the door: the link is the state alone.
    expect(container.querySelector('.head-line a')?.textContent).not.toContain('0,05');
  });
});

describe('§11.1 — the head prints no machinery', () => {
  it('carries no machine noun and no slash counter, in any state', async () => {
    const MACHINE_NOUNS = ['модель', 'LLM', 'триаж', 'вердикт', 'гейт', 'итерация', 'сокет', 'лейн', 'очередь'];
    const states: ClientState[] = [
      apply(base(), 'filing:reading', reading()).state,
      apply(page(), 'change:queued', queued).state,
      apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state,
      apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('verdict', { gate: 'consultant', round: 2 })).state,
      apply(page(), 'chapter:applied', applied).state,
    ];
    for (const client of states) {
      await mount(client, { nowMs: T });
      const shown = text() ?? '';
      expect(shown.length).toBeGreaterThan(0);
      for (const noun of MACHINE_NOUNS) expect(shown.toLowerCase()).not.toContain(noun.toLowerCase());
      expect(/\d\s*\/\s*\d/u.test(shown)).toBe(false);
    }
  });
});
