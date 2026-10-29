import {
  AUTHOR_COLORS,
  partOf,
  type AuthorsDto,
  type CatalogEntry,
  type ChangeDto,
  type ChangeSummaryDto,
  type CommentDto,
  type FrontDto,
  type HistoryRecordDto,
  type MyDecisionsDto,
  type PassStageEvent,
  type StateSnapshot,
} from '@book/shared';

import type { PremiseRow as PremiseRowData } from '../src/lib/premise.ts';

/**
 * BOOK-128 comment #3900 §2 — the fixtures of the one-line gallery.
 *
 * Every value is fixed: no clock, no random, no network. The gallery exists to be measured,
 * so a fixture that changed between two runs would make the measurement a different page.
 * Shapes are copied from the components' own tests (`readingCopy.test.tsx` for the snapshot,
 * `changeCard.test.tsx` for the change, `recordRow.test.tsx` for the record, `filingPanel.test.tsx`
 * for a filing), because those are the fixtures the components are already known to render.
 */

export const FIXED_NOW = 1_764_000_000_000; // 2025-11-25T17:20:00Z, one fixed instant.

export const IMPRINT = { author: 'Филипп Семиров', copyright: '© Филипп Семиров' };

export const STATE: StateSnapshot = {
  version: 1,
  at: '2026-10-27T12:00:00Z',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: '2026-10-27T10:00:00Z' },
  chapters: { total: 42, written: [7, 9], empty: [], count: 2, totalChars: 24_434, basis: [42] },
  cursors: {
    forward: { lane: 'forward', from: 1, to: 21, cursor: 9, next: 10, status: 'idle', lastPassAt: null, lastPass: null },
    backward: { lane: 'backward', from: 42, to: 22, cursor: 42, next: 41, status: 'idle', lastPassAt: null, lastPass: null },
  },
  toc: [],
  meeting: { forwardFront: 9, backwardFront: 42, gap: 32, converged: false, seam: 'not_reached' },
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
  history: { live: true, readerChanges: 4, started: true },
};

/** One written chapter with a title line (ch 7), one untitled (ch 9), the rest untouched. */
export const CATALOG: CatalogEntry[] = Array.from({ length: 42 }, (_, index) => {
  const n = index + 1;
  const written = n === 7 || n === 9;
  return {
    n,
    part: partOf(n),
    title: n === 7 ? 'Ночная смена' : null,
    rev: written ? 2 : 0,
    chars: written ? 12_217 : 0,
    blocks: written ? 6 : 0,
    written,
    basis: n === 42,
    opening: n === 9 ? 'Свет был включён до меня…' : null,
    writtenAt: written ? '2026-10-25T09:20:00Z' : null,
    updatedAt: written ? '2026-10-27T09:20:00Z' : null,
    direction: n <= 21 ? 'forward' : 'backward',
  };
});

export const ENTRY: CatalogEntry = {
  ...(CATALOG[0] as CatalogEntry),
  n: 1,
  written: true,
  title: 'Комната',
  rev: 3,
  chars: 24_434,
  blocks: 7,
  basis: false,
  opening: null,
};

export const FRONT: FrontDto = {
  title: 'Бланк',
  about: 'Книга о том, как текст пишется сам, пока его читают.',
  rev: 4,
  toc: [],
  imprint: IMPRINT,
  authors: { count: 3, measuredAt: '2026-10-27T09:00:00Z' },
  exportBytes: 1_048_576,
  donateUrl: null,
  revision: 12,
};

const ANCHOR = {
  blockId: 'ch07#aa11bb22',
  blockIndex: 0,
  quote: 'Её освещал яркий свет, и на столе лежал лист бумаги.',
  prefix: null,
  suffix: null,
  resolved: true,
};

export const COMMENT: CommentDto = {
  id: 'cmt_01J9Z8K5A4Q7',
  chapter: 7,
  anchor: ANCHOR,
  author: 'Аня',
  authorColor: AUTHOR_COLORS[0],
  body: 'Тут дважды «слово» — оставить одно упоминание.',
  proposedText: null,
  interventionKind: 'document',
  status: 'new',
  frame: 'untouched',
  reason: null,
  createdAt: '2026-10-27T12:04:11Z',
  decidedAt: null,
  changeId: 'chg_12',
  applied: null,
  refusal: null,
  attempt: null,
  premise: false,
};

export const COMMENT_TWO: CommentDto = {
  ...COMMENT,
  id: 'cmt_01J9Z8K5A4R1',
  author: 'Филипп',
  authorColor: AUTHOR_COLORS[3],
  body: 'Свет должен быть не от лампы, а от окна.',
  interventionKind: null,
  status: 'applied',
  createdAt: '2026-10-26T09:12:00Z',
  decidedAt: '2026-10-27T10:00:00Z',
  applied: { chapter: 7, rev: 2 },
  changeId: 'chg_11',
};

export const COMMENTS: CommentDto[] = [COMMENT, COMMENT_TWO];

export const ATTEMPT: ChangeSummaryDto = {
  id: 'chg_12',
  seq: 12,
  chapter: 7,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  premise: false,
  premiseLanded: false,
  sourceCommentId: COMMENT.id,
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  enqueuedAt: '2026-10-27T12:05:00Z',
  decidedAt: '2026-10-27T12:30:00Z',
  chapters: [7],
  rewritten: [7],
  steps: 2,
  frame: 'untouched',
  frameMode: null,
  modes: [],
  cascade: null,
};

export const CHANGE: ChangeDto = {
  premiseLanded: false,
  id: 'chg_12',
  seq: 12,
  kind: 'accepted_comment',
  interventionKind: 'document',
  chapter: 7,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  premise: false,
  source: { commentId: COMMENT.id, author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: {
    grade: 'rebased',
    revAtRecord: 3,
    revNow: 4,
    anchor: 'moved',
    applies: 'yes',
    overlap: 0.93,
    chapterRewritten: false,
    evidence: ['абзац сдвинулся на две позиции'],
    reason: null,
  },
  cascade: {
    id: 'csc_1',
    status: 'closed',
    outcome: 'consistent',
    wave: 2,
    depth: { forward: 1, backward: 1 },
    chaptersChecked: [8],
    chaptersRewritten: [7],
    seams: [{ boundary: 7, reason: 'в главе 7 сказано иначе', resolved: false }],
    wings: {
      down: { frontier: 6, wave: 1, state: 'settled', reached: [6] },
      up: { frontier: 8, wave: 1, state: 'settled', reached: [8] },
    },
    modes: ['оформление'],
    gates: { cycles: 2, findingSurvived: true },
    tokens: { total: 150_572 },
    ms: 41_000,
  },
  steps: [
    {
      seq: 1,
      wave: 0,
      wing: null,
      chapter: 7,
      pass: 'change',
      boundary: 7,
      outcome: 'published_with_finding',
      revBefore: 3,
      revAfter: 4,
      seamsIn: [],
      seamsOut: [{ boundary: 7, reason: 'в главе 7 сказано иначе' }],
      charsDelta: -9,
      note: 'правка 3 · замечание сохранено',
      at: '2026-10-27T12:10:00Z',
      cycles: 3,
      findingSurvived: true,
    },
    {
      seq: 2,
      wave: 1,
      wing: 'upward',
      chapter: 8,
      pass: 'cascade',
      boundary: 8,
      outcome: 'holds',
      revBefore: 1,
      revAfter: 1,
      seamsIn: [],
      seamsOut: [],
      charsDelta: 0,
      note: null,
      at: '2026-10-27T12:20:00Z',
      cycles: 0,
      findingSurvived: false,
    },
  ],
  appliedRevs: [{ chapter: 7, rev: 4 }],
  cost: { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 30_572, rub: 0.04 },
  scienceCheck: 'passed',
  modes: ['оформление'],
  history: { fromHseq: 10, toHseq: 14 },
  enqueuedAt: '2026-10-27T12:05:00Z',
  startedAt: '2026-10-27T12:06:00Z',
  decidedAt: '2026-10-27T12:30:00Z',
};

export const READER_RECORD: HistoryRecordDto = {
  id: 'chg_12',
  hseq: 12,
  at: '2026-10-27T12:30:00Z',
  seq: 12,
  chapter: 7,
  chapterTitle: 'Ночная смена',
  premise: false,
  premiseLanded: false,
  alias: 'Аня',
  cause: 'reader',
  status: 'done',
  outcome: 'applied',
  reason: null,
  changeId: 'chg_12',
  recordHref: '#правка-chg_12',
  span: { before: 'старый фонарь', after: 'новый фонарь' },
};

export const PASS_RECORD: HistoryRecordDto = {
  ...READER_RECORD,
  id: 'pass:stp_7',
  hseq: 7,
  at: '2026-10-26T06:00:00Z',
  seq: null,
  chapterTitle: null,
  alias: null,
  cause: 'pass',
  status: null,
  outcome: null,
  changeId: null,
  recordHref: '#проход-9-stp_7',
  span: null,
};

export const RECORDS: HistoryRecordDto[] = [READER_RECORD, PASS_RECORD];

export const AUTHORS: AuthorsDto = {
  totalChars: 24_434,
  measuredAt: '2026-10-27T09:00:00Z',
  measured: 4,
  author: { label: 'Филипп Семиров', share: 0.612, chars: 14_953 },
  contributors: [
    { identityId: 'id-anya', label: 'Аня', edits: 3, chars: 5_481, share: 0.224, firstAt: '2026-09-01T10:00:00Z' },
    { identityId: 'id-boris', label: 'Борис', edits: 1, chars: 4_000, share: 0.164, firstAt: '2026-09-14T10:00:00Z' },
  ],
  sum: 1,
};

export const DECISIONS: MyDecisionsDto = {
  items: [
    {
      commentId: COMMENT.id,
      changeId: 'chg_12',
      chapter: 7,
      premise: false,
      intent: 'в абзаце дважды «слово» — оставить одно упоминание',
      outcome: 'applied',
      reason: null,
      chapters: [7],
      waves: 2,
      blocks: 1,
      shareAtDecision: { share: 0.224, day: '2026-10-27' },
      decidedAt: '2026-10-27T12:30:00Z',
    },
  ],
  open: [],
  share: 0.224,
};

export const PREMISE: PremiseRowData = {
  n: 2,
  commentId: COMMENT.id,
  quote: 'смена переходит на ночь',
  word: 'ждёт',
  note: null,
  reason: null,
  revise: null,
  attempt: { id: 'chg_12', number: '012', seq: 12 },
  actionable: true,
};

export const PASS_EVENTS: PassStageEvent[] = [
  {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 1,
    stageSeq: 1,
    stage: 'queued',
    at: FIXED_NOW - 240_000,
    actor: { process: 'writer', model: null },
    changeId: null,
    summary: 'глава поставлена в очередь',
    span: null,
    tokens: null,
    costUsd: null,
  },
  {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 1,
    stageSeq: 2,
    stage: 'read',
    at: FIXED_NOW - 200_000,
    actor: { process: 'writer', model: null },
    changeId: null,
    summary: 'глава прочитана',
    span: null,
    tokens: null,
    costUsd: null,
  },
  {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 1,
    stageSeq: 3,
    stage: 'drafting',
    at: FIXED_NOW - 120_000,
    actor: { process: 'writer', model: null },
    changeId: null,
    summary: 'абзац пишется',
    span: null,
    tokens: { in: 1_200, out: 320 },
    costUsd: null,
  },
];

/** The paragraph the revision object resolves «стало» against. */
export const PARAGRAPH =
  'Её освещал яркий свет, и на столе лежал лист бумаги, на нём не было ни строки. ' +
  'Свет был включён до меня — и никто не сказал об этом.';

/**
 * The record's own rows, as `rowWindow` hands them to `RowsList` (BOOK-128 §2, audit #14): the
 * facts on one mono 12 line, the pair the book wrote under it, and the fold line with its door
 * (`показаны N из M` + `ещё K →`, BOOK-199 m3) — a count never stands without the control that
 * opens the rest. `rest` is what the window still hides; `RowsList` derives M from it.
 */
export const REC_WINDOW = {
  rows: [
    { id: 'rec-1', facts: '28.10.2026 · 14:42 · Аня', specimen: '«старый фонарь» → «новый фонарь»' },
    { id: 'rec-2', facts: '27.10.2026 · 09:15 · Филипп', specimen: '«свет был включён» → «свет горел»' },
  ],
  rest: 2,
};
