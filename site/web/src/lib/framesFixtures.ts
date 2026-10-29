/**
 * Fixtures for `frames.test.ts`: one real payload per frame domain, in the wire shape
 * BOOK-DOC-84 §2.1 names. Kept out of the test so the test is the transitions and nothing else.
 */

import {
  directionOf,
  partOf,
  STAGE_DEADLINE_MS,
  TOTAL_CHAPTERS,
  type CatalogEntry,
  type ChangeDecidedPayload,
  type ChapterAppliedPayload,
  type ChapterRevisionPayload,
  type FilingUpdatePayload,
  type LivePayload,
  type PassClosedPayload,
  type StateSnapshot,
} from '@book/shared';

import type { BookData } from './bookState.ts';
import type { ClientState } from './frames.ts';
import { applyFrame, initialClientState } from './frames.ts';

export const NOW = '2026-10-29T12:00:00Z';
export const AT = 1_764_000_000_000;

export const catalog: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  return {
    n,
    part: partOf(n),
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: n === 1 || n === TOTAL_CHAPTERS,
    opening: null,
    writtenAt: null,
    updatedAt: null,
    direction: directionOf(n),
  };
});

export const STATE: StateSnapshot = {
  version: 1,
  at: NOW,
  engine: { status: 'running', heartbeatAt: NOW, laneId: 'forward' },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: NOW },
  chapters: { total: TOTAL_CHAPTERS, written: [3], empty: [], count: 1, totalChars: 100, basis: [1, TOTAL_CHAPTERS] },
  cursors: {} as StateSnapshot['cursors'],
  toc: catalog.map((row) => ({ part: row.part, n: row.n, title: null, written: false, rev: 0 })),
  meeting: { forwardFront: 3, backwardFront: TOTAL_CHAPTERS, gap: 0, converged: false, seam: 'not_reached' },
  cascade: null,
  queue: {
    depth: 2,
    byState: { pending: 2, processing: 0, stale: 0, escalated: 0, done24h: 0 },
    head: null,
    processing: null,
    lastDecidedAt: null,
    pending: [],
  },
  revising: [],
  current: null,
  unresolved: [],
  activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
  history: { live: true, readerChanges: 1, started: true },
};

export const BOOK: BookData = {
  state: STATE,
  catalog,
  front: {
    title: 'Бланк',
    about: null,
    rev: 1,
    toc: STATE.toc,
    imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
    authors: { count: 1, measuredAt: NOW },
  },
};

export const LIVE: LivePayload = {
  at: NOW,
  passes: [
    {
      chapter: 3,
      passId: 'stp_1',
      changeId: 'chg_1',
      lane: 'forward',
      stage: 'drafting',
      stageSeq: 3,
      since: AT,
      deadlineAt: AT + STAGE_DEADLINE_MS,
    },
  ],
  applied: null,
  queue: {
    depth: 1,
    pending: [{ id: 'chg_2', chapter: 4, seq: 2, ahead: 0, kind: 'edit', enqueuedAt: NOW }],
  },
  filings: [
    { commentId: 'cmt_1', chapter: 4, state: 'accepted', attempts: 1, attemptsLeft: 2, changeId: 'chg_2', at: NOW },
  ],
  lane: { passesToday: 2, maxPasses: 4, writerAt: NOW },
};

export const start = (): ClientState => ({ ...initialClientState(BOOK), seq: 0 });

let seq = 0;
export function frame(type: string, data: unknown): { v: 1; type: never; seq: number; ts: string; data: unknown } {
  seq += 1;
  return { v: 1, seq, ts: NOW, data, type: type as never };
}

export const apply = (state: ClientState, type: string, data: unknown) =>
  applyFrame(state, frame(type, data) as never);

export const chapterRevision: ChapterRevisionPayload = {
  n: 3,
  rev: 2,
  hseq: 7,
  title: 'Третья',
  chars: 120,
  delta: 20,
  kind: 'edit',
  cause: { changeId: null, cascadeId: null, wave: null, lane: 'forward', direction: 'forward', stepId: null, seamsIn: [], seamsOut: [] },
  patch: [{ op: 'replace', id: 'ch03#a', i: 0, newId: 'ch03#b', text: 'Новый абзац' }],
  patchTruncated: false,
  attributed: true,
  updatedAt: NOW,
};

export const applied: ChapterAppliedPayload = {
  n: 3,
  rev: 2,
  hseq: 7,
  appliedAt: AT,
  createdAt: NOW,
  kind: 'edit',
  cause: { stepId: 'stp_1', changeId: null, cascadeId: null, lane: 'forward', direction: 'forward' },
  patch: chapterRevision.patch,
  patchTruncated: false,
  span: [{ blockId: 'ch03#a', before: 'Старый абзац', after: 'Новый абзац', truncated: false }],
  chars: 120,
  delta: 20,
  blocksTouched: 1,
  attributed: true,
};

export const filing: FilingUpdatePayload = {
  commentId: 'cmt_1',
  chapter: 4,
  state: 'refused',
  attempts: 2,
  attemptsLeft: 1,
  changeId: 'chg_2',
  at: AT,
};

export const passClosed: PassClosedPayload = {
  stepId: 'stp_1',
  changeId: 'chg_1',
  chapter: 3,
  pass: 'change',
  outcome: 'refused',
  sentence: 'текст не менялся',
  at: AT,
  closeFailed: false,
  costUsd: null,
  tokens: null,
};

export const decided: ChangeDecidedPayload = {
  id: 'chg_2',
  commentId: 'cmt_1',
  outcome: 'applied',
  reason: null,
  chapters: [4],
  cascade: null,
  relevance: null,
  tokens: { total: 10 },
  decidedAt: NOW,
  at: AT,
  eventSeq: 4,
};


export const resetSeq = (): void => {
  seq = 0;
};
