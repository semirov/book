/**
 * BOOK-DOC-84 §11.1 — the head's test fixtures, shared by its two DOM suites.
 *
 * The same page, the same catalogue and the same frames build the line in both: `headLine.dom`
 * asserts what the line says per state, `headConnection.dom` asserts the connection's own word
 * and the reconnect. Split at the file bound (500 lines), not at a fact: every constant here is
 * one of the fixtures the two files used to copy.
 */

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

import { initialClientState, withLive, type ClientState } from '../lib/clientState.ts';
import { apply } from '../lib/framesFixtures.ts';

/** 17:04 in Moscow — the contract's example time. */
export const T = Date.parse('2026-10-29T14:04:00Z');
export const MINUTE = 60_000;

export const STATE: StateSnapshot = {
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

export const CATALOG: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  return {
    n,
    part: partOf(n),
    // A real title on the chapter under the reader: the head's three facts are asserted in both
    // states, number and name together.
    title: n === 1 ? 'Ночная смена' : null,
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

export const LIVE: LivePayload = {
  at: '2026-10-29T14:04:00Z',
  passes: [],
  applied: null,
  queue: { depth: 0, pending: [] },
  filings: [
    { commentId: 'cmt_012', chapter: 4, state: 'accepted', attempts: 1, attemptsLeft: 3, changeId: 'chg_12', at: '2026-10-29T14:04:00Z' },
  ],
  lane: { passesToday: 1, maxPasses: 4, writerAt: null },
  lastCost: { kind: 'pass', usd: 0.05, at: T, estimated: false, dayUsd: 0.05 },
};

export function page(overrides: Partial<LivePayload> = {}): ClientState {
  return withLive(initialClientState(), { ...LIVE, ...overrides });
}

export const queued: ChangeQueuedPayload = {
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
export const base = (): ClientState => apply(page(), 'change:queued', queued).state;

export const reading = (overrides: Partial<FilingReadingPayload> = {}): FilingReadingPayload => ({
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

export const accepted: PassAcceptedPayload = {
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

export const stage = (name: PassStageEvent['stage'], overrides: Partial<PassStageEvent> = {}): PassStageEvent => ({
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

export const applied: ChapterAppliedPayload = {
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
