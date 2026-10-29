import {
  STAGE_DEADLINE_MS,
  type ChangeQueuedPayload,
  type ChapterAppliedPayload,
  type FilingReadingPayload,
  type LivePayload,
  type PassAcceptedPayload,
  type PassStageEvent,
  visibleLineWord,
} from '@book/shared';
import { createRoot } from 'react-dom/client';

import { Header } from '../src/components/Header.tsx';
import { initialClientState, withLive, type ClientState } from '../src/lib/clientState.ts';
import { applyFrame } from '../src/lib/frames.ts';
import { BOOK, resetSeq } from '../src/lib/framesFixtures.ts';
import { nowStateOf } from '../src/lib/nowState.ts';

import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/chrome.css';
import '../src/styles/running-head.css';
import '../src/styles/head-status.css';
import '../src/styles/book.css';
import '../src/styles/live.css';

/**
 * BOOK-DOC-84 §11.1 — the CDP harness entry for the head's status line.
 *
 * Seven states, each built from the page's own frame fold (never from a hand-written string):
 * the reading of a filing, its widening, the wait in the queue, the writing, a gate round, an
 * iteration and the landing. `?state=` picks one; `window.__head` hides and shows the line so
 * the same page can be measured with and without it, and answers the expected visible line for
 * a width (the phone drops the number, the clock and — under 360 — the gate's word).
 *
 * `scripts/head-cdp.mjs` measures; nothing here is measured.
 */

/** 17:04 in Moscow — the contract's own example time. */
const T = Date.parse('2026-10-29T14:04:00Z');
const MINUTE = 60_000;

const live: LivePayload = {
  at: new Date(T).toISOString(),
  passes: [],
  applied: null,
  queue: { depth: 2, pending: [] },
  filings: [
    { commentId: 'cmt_012', chapter: 4, state: 'accepted', attempts: 1, attemptsLeft: 3, changeId: 'chg_12', at: new Date(T).toISOString() },
  ],
  lane: { passesToday: 2, maxPasses: 4, writerAt: null },
  lastCost: { kind: 'pass', usd: 0.05, at: T, estimated: false, dayUsd: 0.4 },
};

let seq = 0;
function applied(state: ClientState, type: string, data: unknown): ClientState {
  seq += 1;
  return applyFrame(state, { v: 1, type, seq, ts: new Date(T).toISOString(), data } as never).state;
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

const write: ChapterAppliedPayload = {
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

/** The page: a book, the live block and the viewer — everything the head reads. */
function start(): ClientState {
  resetSeq();
  seq = 0;
  return withLive(initialClientState(BOOK), live);
}

/** The seven states, each as the frames build it (never as a string). */
const STATES: Record<string, () => ClientState> = {
  reading: () => applied(applied(start(), 'change:queued', queued), 'filing:reading', reading()),
  approach: () =>
    applied(
      applied(start(), 'change:queued', queued),
      'filing:reading',
      reading({ phase: 'widened', attempt: 3, at: Date.parse('2026-10-29T14:06:00Z') }),
    ),
  waiting: () => applied(start(), 'change:queued', queued),
  writing: () => applied(applied(applied(start(), 'change:queued', queued), 'pass:accepted', accepted), 'pass:stage', stage('drafting')),
  checking: () =>
    applied(
      applied(applied(start(), 'change:queued', queued), 'pass:accepted', accepted),
      'pass:stage',
      stage('verdict', { at: Date.parse('2026-10-29T14:08:00Z'), gate: 'editor', round: 1, stageSeq: 2 }),
    ),
  fixing: () =>
    applied(
      applied(applied(start(), 'change:queued', queued), 'pass:accepted', accepted),
      'pass:stage',
      stage('revising', { at: Date.parse('2026-10-29T14:09:00Z'), iteration: 2, maxIterations: 5, stageSeq: 2 }),
    ),
  applied: () => applied(start(), 'chapter:applied', write),
};

/** The frame's own moment, so the line prints the state's clock and not the machine's. */
const AT: Record<string, number> = {
  reading: T,
  approach: Date.parse('2026-10-29T14:06:00Z'),
  waiting: T,
  writing: T,
  checking: Date.parse('2026-10-29T14:08:00Z'),
  fixing: Date.parse('2026-10-29T14:09:00Z'),
  applied: write.appliedAt,
};

const mount = document.getElementById('mount');
if (mount === null) throw new Error('the harness has no mount');
const root = createRoot(mount);

let shown: string | null = new URLSearchParams(window.location.search).get('state');
/** The author's own line, on demand: the two-row case the phone must still hold. */
let author = false;

function render(): void {
  const name = shown;
  const client = name === null ? null : (STATES[name] ?? null);
  root.render(
    <Header
      state={BOOK.state}
      ribbon={null}
      catalog={BOOK.catalog}
      markers={[]}
      onOpenChange={() => undefined}
      live={false}
      client={
        client === null ? null : author ? { ...client(), viewer: { signedIn: true, displayName: 'Аня', isAuthor: true } } : client()
      }
      {...(name === null ? {} : { nowMs: AT[name] ?? T })}
      reading={{ n: 1, page: 1 }}
    />,
  );
}

render();

declare global {
  interface Window {
    __head: {
      ready: () => boolean;
      hide: () => void;
      show: (name: string) => void;
      author: (on: boolean) => void;
      /** The line the reader should see at this width, from the same derived state. */
      expected: (name: string, width: number) => string | null;
    };
  }
}

window.__head = {
  ready: () => document.querySelector('.top-row') !== null && document.querySelector('#first') !== null,
  hide: () => {
    shown = null;
    render();
  },
  show: (name: string) => {
    shown = name;
    render();
  },
  author: (on: boolean) => {
    author = on;
    render();
  },
  expected: (name: string, width: number, withAuthor = false) => {
    const build = STATES[name];
    if (build === undefined) return null;
    const client = build();
    const state = nowStateOf({
      state: withAuthor ? { ...client, viewer: { signedIn: true, displayName: 'Аня', isAuthor: true } } : client,
      nowMs: AT[name] ?? T,
    });
    if (state.line === null) return null;
    // §11.1's phone step: the id and the clock go at ≤599, the gate's word only under 360.
    const line =
      width <= 359
        ? visibleLineWord(state.parts, ['filing', 'time', 'gate'])
        : width <= 599
          ? visibleLineWord(state.parts, ['filing', 'time'])
          : state.line;
    return withAuthor && state.author !== null ? `${line} · ${state.author}` : line;
  },
};
