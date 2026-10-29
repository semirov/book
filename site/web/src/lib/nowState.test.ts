import {
  type ChangeQueuedPayload,
  type ChapterAppliedPayload,
  type CommentDecisionPayload,
  type FilingReadingPayload,
  type LivePayload,
  type PassAcceptedPayload,
  type PassClosedPayload,
  type PassStageEvent,
  type StateSnapshot,
} from '@book/shared';
import { describe, expect, it } from 'vitest';

import { initialClientState, withLive, type ClientState } from './clientState.ts';
import { apply, LIVE, resetSeq } from './framesFixtures.ts';
import { LINGER_MS, nowStateOf, shortReason, type NowState } from './nowState.ts';

/**
 * BOOK-DOC-84 §11.1 — **one derived state**, asserted per frame sequence.
 *
 * The line is not a string a surface composes: it is the fold of the frames the page heard, so
 * every case here starts from the frames and asserts the exact rendered line. The same call
 * answers the record's sentence (the same parts without the clock), which is the one-state rule
 * §11.4 asks for: a second derivation would drift from this one.
 */

/** 17:04 in Moscow: the contract's own example time. */
const T = Date.parse('2026-10-29T14:04:00Z');
const MINUTE = 60_000;

function line(state: ClientState, nowMs = T, offlineAt: number | null = null): string | null {
  return nowStateOf({ state, nowMs, offlineAt }).line;
}

function now(state: ClientState, nowMs = T, offlineAt: number | null = null): NowState {
  return nowStateOf({ state, nowMs, offlineAt });
}

/** The page after `hello`: the live block and the viewer, with no frame of its own yet. */
function page(live: Partial<LivePayload> = {}, viewer: StateSnapshot['engine'] | null = null): ClientState {
  void viewer;
  return withLive(initialClientState(), {
    ...LIVE,
    passes: [],
    queue: { depth: 0, pending: [] },
    filings: [],
    applied: null,
    ...live,
  });
}

/** A filing whose change the page already knows: the number comes from `change:queued`. */
function withChange(state: ClientState, changeId = 'chg_12', seq = 12, ahead = 0): ClientState {
  const queued: ChangeQueuedPayload = {
    id: changeId,
    seq,
    kind: 'reader_edit',
    chapter: 4,
    intent: 'поправить',
    source: { commentId: 'cmt_012', author: 'Аня' },
    queue: { depth: ahead + 1, ahead },
    base: { rev: 1 },
    scopeHint: 'phrase',
    at: T - 5 * MINUTE,
    eventSeq: 1,
  };
  return apply(state, 'change:queued', queued).state;
}

function reading(phase: FilingReadingPayload['phase'], overrides: Partial<FilingReadingPayload> = {}): FilingReadingPayload {
  return {
    commentId: 'cmt_012',
    chapter: 4,
    phase,
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
  };
}

function accepted(overrides: Partial<PassAcceptedPayload> = {}): PassAcceptedPayload {
  return {
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
    ...overrides,
  };
}

function stage(name: PassStageEvent['stage'], overrides: Partial<PassStageEvent> = {}): PassStageEvent {
  return {
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
    ...overrides,
  };
}

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

const closed: PassClosedPayload = {
  stepId: 'stp_1',
  changeId: 'chg_12',
  chapter: 1,
  pass: 'change',
  outcome: 'interrupted',
  sentence: 'шаг не закрылся за отведённое время — проход остановлен',
  at: Date.parse('2026-10-29T14:12:00Z'),
  closeFailed: true,
  costUsd: null,
  tokens: null,
};

const refused: CommentDecisionPayload = {
  id: 'cmt_012',
  chapter: 4,
  status: 'rejected',
  reason: 'не нашли места, где эта фраза стоит в тексте',
  decidedAt: '2026-10-29T14:12:00Z',
  changeId: 'chg_12',
  attemptsLeft: 1,
  at: Date.parse('2026-10-29T14:12:00Z'),
  queue: { depth: 0, ahead: 0 },
};

describe('§11.1 — idle is nothing at all', () => {
  it('prints no line with no frames', () => {
    resetSeq();
    expect(line(page())).toBeNull();
    expect(now(page()).door).toBeNull();
  });

  it('ends the line four seconds after a terminal frame', () => {
    resetSeq();
    const written = apply(page(), 'chapter:applied', applied).state;
    expect(line(written, applied.appliedAt + LINGER_MS - 1)).toBe('внесено · глава 1, редакция 13 · 17:12');
    expect(line(written, applied.appliedAt + LINGER_MS)).toBeNull();
  });
});

describe('§11.1 — a filing is read, waited for, widened or given up', () => {
  it('reads the filing with its number, its try and the frame’s clock', () => {
    resetSeq();
    const state = apply(withChange(page()), 'filing:reading', reading('claimed')).state;
    expect(line(state)).toBe('машина читает правку 012 · попытка 1 из 5 · 17:04');
    expect(now(state).door).toEqual({ commentId: 'cmt_012', chapter: 4 });
  });

  it('carries the frame’s own attempt and its own moment (a retry, never a default)', () => {
    resetSeq();
    const at = T - MINUTE;
    const state = apply(withChange(page()), 'filing:reading', reading('claimed', { attempt: 2, at, readingSeq: 2 })).state;
    expect(line(state, at)).toBe('машина читает правку 012 · попытка 2 из 5 · 17:03');
  });

  it('never invents a number the page does not hold', () => {
    resetSeq();
    const state = apply(page(), 'filing:reading', reading('claimed')).state;
    expect(line(state)).toBe('машина читает правку · попытка 1 из 5 · 17:04');
  });

  it('waits, with the queue’s place, when the reading failed and a try is left', () => {
    resetSeq();
    const state = apply(withChange(page(), 'chg_12', 12, 2), 'filing:reading', reading('failed', { reason: 'таймаут', retryAt: T + 4 * MINUTE })).state;
    expect(line(state)).toBe('правка 012 ждёт · попытка 1 из 5 · 17:04');
    expect(now(state).door).toEqual({ commentId: 'cmt_012', chapter: 4 });
  });

  it('says not delivered when the last try failed — with the engine’s own class', () => {
    resetSeq();
    const state = apply(
      withChange(page()),
      'filing:reading',
      reading('failed', { attempt: 5, reason: 'не успели', retryAt: null, readingSeq: 4 }),
    ).state;
    expect(line(state)).toBe('не дошло: не успели · правка 012 · 17:04');
    expect(now(state).terminal).toBe(true);
    expect(line(state, T + LINGER_MS)).toBeNull();
  });

  it('names the widening as a changed approach, never as machinery', () => {
    resetSeq();
    const at = Date.parse('2026-10-29T14:06:00Z');
    const state = apply(
      withChange(page()),
      'filing:reading',
      reading('widened', { attempt: 3, at, widened: { code: 'wider-edit', sentence: 'правим шире: не строку, а абзац' } }),
    ).state;
    expect(line(state, at)).toBe('машина меняет подход к правке 012 · попытка 3 из 5 · 17:06');
  });

  it('labels the desperate sixth as 6 of 6', () => {
    resetSeq();
    const state = apply(
      withChange(page()),
      'filing:reading',
      reading('claimed', { attempt: 6, maxAttempts: 6, desperate: true }),
    ).state;
    expect(line(state)).toBe('машина читает правку 012 · попытка 6 из 6 · 17:04');
  });

  it('reads a stale claim as the wait, never as work — and the deadline invents no word', () => {
    resetSeq();
    const deadlineAt = T + 900_000;
    const state = apply(withChange(page()), 'filing:reading', reading('claimed', { deadlineAt })).state;
    expect(line(state, deadlineAt + 1)).toBe('правка 012 ждёт · 17:04');
    // A deadline that passes changes no word of its own: never «не дошло», never a defect.
    expect(now(state, deadlineAt + 10 * MINUTE).kind).toBe('waiting');
  });
});

describe('§11.1 — a change waits, a chapter is written, checked and fixed', () => {
  it('waits with the queue’s place', () => {
    resetSeq();
    // The clock is the frame's own: the change was accepted five minutes ago.
    expect(line(withChange(page(), 'chg_12', 12, 2))).toBe('правка 012 ждёт: впереди 2 · 16:59');
  });

  it('writes a chapter with the filing and the pass’s own try', () => {
    resetSeq();
    const state = apply(apply(withChange(page()), 'pass:accepted', accepted()).state, 'pass:stage', stage('drafting')).state;
    expect(line(state)).toBe('машина пишет главу 1 · правка 012 · попытка 1 из 5 · 17:04');
    expect(now(state).door).toEqual({ chapter: 1 });
  });

  it('writes an empty slot with no filing to name', () => {
    resetSeq();
    const state = apply(
      apply(page(), 'pass:accepted', accepted({ chapter: 7, pass: 'draft', premiseChangeId: null })).state,
      'pass:stage',
      stage('drafting', { chapter: 7, changeId: null }),
    ).state;
    expect(line(state)).toBe('машина пишет главу 7 · попытка 1 из 5 · 17:04');
  });

  it('checks with the gate and its round', () => {
    resetSeq();
    const at = Date.parse('2026-10-29T14:08:00Z');
    const state = apply(
      apply(withChange(page()), 'pass:accepted', accepted()).state,
      'pass:stage',
      stage('verdict', { at, gate: 'editor', round: 1, stageSeq: 2 }),
    ).state;
    expect(line(state, at)).toBe('машина проверяет главу 1 · правка 012 · редактор, раунд 1 · 17:08');
  });

  it('fixes by a remark, with the iteration that fixes text', () => {
    resetSeq();
    const at = Date.parse('2026-10-29T14:09:00Z');
    const state = apply(
      apply(withChange(page()), 'pass:accepted', accepted()).state,
      'pass:stage',
      stage('revising', { at, iteration: 2, maxIterations: 5, stageSeq: 2 }),
    ).state;
    expect(line(state, at)).toBe('машина правит по замечанию · правка 012 · поправка 2 из 5 · 17:09');
  });

  it('prefers the newest work over a resting ending', () => {
    resetSeq();
    const written = apply(withChange(page()), 'chapter:applied', applied).state;
    const running = apply(apply(written, 'pass:accepted', accepted({ chapter: 2, at: applied.appliedAt + MINUTE })).state, 'pass:stage', stage('drafting', { chapter: 2, at: applied.appliedAt + MINUTE })).state;
    expect(line(running, applied.appliedAt + 2 * MINUTE)).toBe('машина пишет главу 2 · правка 012 · попытка 1 из 5 · 17:13');
  });
});

describe('§11.1 — the three endings', () => {
  it('announces the write with its edition', () => {
    resetSeq();
    const state = apply(page(), 'chapter:applied', applied).state;
    expect(line(state, applied.appliedAt)).toBe('внесено · глава 1, редакция 13 · 17:12');
    expect(now(state, applied.appliedAt).door).toEqual({ chapter: 1 });
  });

  it('refuses a filing with the book’s own reason', () => {
    resetSeq();
    const state = apply(withChange(page()), 'comment:decision', refused).state;
    const at = Date.parse(refused.decidedAt);
    expect(line(state, at)).toBe('не принято: не нашли места, где эта фраза… · правка 012 · 17:12');
    expect(now(state, at).door).toEqual({ commentId: 'cmt_012', chapter: 4 });
    expect(line(state, at + LINGER_MS)).toBeNull();
  });

  it('does not read a defect as normal work', () => {
    resetSeq();
    const state = apply(page(), 'pass:closed', closed).state;
    expect(line(state, closed.at)).toBe('не дошло: шаг не закрылся за отведённое… · глава 1 · 17:12');
    expect(now(state, closed.at).kind).toBe('defect');
  });

  it('cuts the engine’s sentence at a word, never mid-word', () => {
    expect(shortReason('шаг не закрылся за отведённое время — проход остановлен', 32)).toBe('шаг не закрылся за отведённое…');
    expect(shortReason('коротко', 32)).toBe('коротко');
    expect(shortReason('  много   пробелов  ', 32)).toBe('много пробелов');
  });
});

describe('§11.1 — no link where there is nothing to open', () => {
  it('says the connection is gone, and it is not a door', () => {
    resetSeq();
    const state = page();
    expect(line(state, T, T)).toBe('нет связи · 17:04');
    expect(now(state, T, T).door).toBeNull();
    expect(now(state, T, T).terminal).toBe(false);
  });

  it('outranks every word while it is set', () => {
    resetSeq();
    const state = apply(withChange(page()), 'pass:accepted', accepted()).state;
    expect(line(state, T, T)).toBe('нет связи · 17:04');
  });
});

describe('§11.4 — one state feeds the line and the record’s sentence', () => {
  it('the sentence is the line without its clock, for every state', () => {
    resetSeq();
    const cases: Array<[ClientState, number]> = [
      [apply(withChange(page()), 'filing:reading', reading('claimed')).state, T],
      [withChange(page(), 'chg_12', 12, 2), T],
      [apply(apply(withChange(page()), 'pass:accepted', accepted()).state, 'pass:stage', stage('drafting')).state, T],
      [apply(page(), 'chapter:applied', applied).state, applied.appliedAt],
      [apply(withChange(page()), 'comment:decision', refused).state, Date.parse(refused.decidedAt)],
      [apply(page(), 'pass:closed', closed).state, closed.at],
    ];
    for (const [state, at] of cases) {
      const derived = now(state, at);
      expect(derived.line).not.toBeNull();
      expect(derived.sentence).toBe(derived.line?.split(' · ').slice(0, -1).join(' · '));
    }
  });
});

describe('§11.1 — the author’s own line', () => {
  it('is absent for a reader and present for the author', () => {
    resetSeq();
    const reader = page({ lastCost: { kind: 'pass', usd: 0.05, at: T, estimated: false, dayUsd: 0.4 }, queue: { depth: 2, pending: [] } });
    expect(now(reader).author).toBeNull();

    const author: ClientState = {
      ...reader,
      viewer: { signedIn: true, displayName: 'Аня', isAuthor: true },
    };
    expect(now(author).author).toBe('впереди 2 · 0,05 $');
  });
});

describe('§11.1 — the vocabulary holds on every line', () => {
  const MACHINE_NOUNS = ['модель', 'LLM', 'триаж', 'вердикт', 'гейт', 'итерация', 'сокет', 'лейн', 'очередь'];
  const SLASH = /\d\s*\/\s*\d/u;

  it('prints no machine noun and no slash counter, in any state', () => {
    resetSeq();
    const lines = [
      line(apply(withChange(page()), 'filing:reading', reading('claimed')).state),
      line(apply(withChange(page()), 'filing:reading', reading('widened', { attempt: 3 })).state, T),
      line(withChange(page(), 'chg_12', 12, 2)),
      line(apply(apply(withChange(page()), 'pass:accepted', accepted()).state, 'pass:stage', stage('drafting')).state),
      line(apply(apply(withChange(page()), 'pass:accepted', accepted()).state, 'pass:stage', stage('verdict', { gate: 'editor', round: 1 })).state),
      line(apply(apply(withChange(page()), 'pass:accepted', accepted()).state, 'pass:stage', stage('revising', { iteration: 2 })).state),
      line(apply(page(), 'chapter:applied', applied).state, applied.appliedAt),
      line(apply(withChange(page()), 'comment:decision', refused).state, Date.parse(refused.decidedAt)),
      line(apply(page(), 'pass:closed', closed).state, closed.at),
      line(page(), T, T),
    ];
    for (const text of lines) {
      expect(text).not.toBeNull();
      for (const noun of MACHINE_NOUNS) expect(text?.toLowerCase()).not.toContain(noun.toLowerCase());
      expect(SLASH.test(text ?? '')).toBe(false);
    }
  });
});
