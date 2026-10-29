import type { PassClosedPayload } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { CHANGE_STALE_LINE } from './changeStatus.ts';
import type { ChangeLine } from './clientState.ts';
import {
  STAGE_WORDS,
  changeLineOf,
  closedPassOf,
  liveChangeFacts,
  liveLineOf,
  passLineOf,
  publishLiveChange,
  resetLiveChange,
} from './liveChange.ts';

const AT = 1_764_000_000_000;

const closed = (overrides: Partial<PassClosedPayload> = {}): PassClosedPayload => ({
  stepId: 'stp_1',
  changeId: 'chg_2',
  chapter: 4,
  pass: 'change',
  outcome: 'refused',
  sentence: '',
  at: AT,
  closeFailed: false,
  costUsd: null,
  tokens: null,
  ...overrides,
});

/**
 * BOOK-220 B2/M3 — the words the record's `правка` section prints for a frame, and the two
 * lookups that find them. The frames themselves are `frames.test.ts`'s; this file is the
 * vocabulary, so a missing branch is a missing sentence a reader would never see.
 */

describe('the change’s last line, in the reader’s words', () => {
  it('names the queue place, the claim, the narrowing and the moved basis', () => {
    expect(liveLineOf({ kind: 'queued', at: AT, eventSeq: 1, ahead: 2, depth: 3 })).toBe('в очереди · впереди 2');
    // The head of the lane has no «впереди»: it is the next one.
    expect(liveLineOf({ kind: 'queued', at: AT, eventSeq: 1, ahead: 0, depth: 1 })).toBe('в очереди · следующая');
    expect(liveLineOf({ kind: 'processing', at: AT, eventSeq: 2, ahead: 0, attempt: 3 })).toBe('идёт · попытка 3');
    expect(liveLineOf({ kind: 'adapted', at: AT, eventSeq: 3, intent: 'ровный свет', reason: '' })).toBe(
      'сужено · ровный свет',
    );
    expect(liveLineOf({ kind: 'adapted', at: AT, eventSeq: 3, intent: 'ровный свет', reason: 'не про эту сцену' })).toBe(
      'сужено · ровный свет · не про эту сцену',
    );
    // A narrowing with no intent of its own: the reason stands alone, never «сужено · ».
    expect(liveLineOf({ kind: 'adapted', at: AT, eventSeq: 3, intent: '', reason: 'не про эту сцену' })).toBe(
      'сужено · не про эту сцену',
    );
    expect(liveLineOf({ kind: 'adapted', at: AT, eventSeq: 3, intent: '', reason: '' })).toBe('сужено');
    expect(liveLineOf({ kind: 'stale', at: AT, eventSeq: 4, grade: 'weak', evidence: [], options: [] })).toBe(
      CHANGE_STALE_LINE,
    );
    // A decision has its verdict rows on the record: the live line adds no second word. The
    // payload is never read for this branch, so the empty shape is the honest fixture.
    const decided = { kind: 'decided', at: AT, eventSeq: 5, payload: {} } as unknown as ChangeLine;
    expect(liveLineOf(decided)).toBeNull();
  });
});

describe('the pass’s own sentence', () => {
  it('prints the writer’s line, a failed close and the price, and nothing when it has none', () => {
    expect(passLineOf(closed({ sentence: 'текст не менялся' }))).toBe('текст не менялся');
    expect(passLineOf(closed({ sentence: 'текст не менялся', costUsd: 0.42 }))).toBe('текст не менялся · 0,42 $');
    expect(passLineOf(closed({ sentence: '', closeFailed: true }))).toBe('правка прервана — текст не менялся');
    // The writer's own line stands beside the interruption, never in its place.
    expect(passLineOf(closed({ sentence: 'сверял абзац', closeFailed: true }))).toBe(
      'сверял абзац · правка прервана — текст не менялся',
    );
    // The close that failed is still priced: the interruption does not hide what it cost.
    expect(passLineOf(closed({ sentence: '', closeFailed: true, costUsd: 0.42 }))).toBe(
      'правка прервана — текст не менялся · 0,42 $',
    );
    // No sentence, no failure, no money: the record prints no empty line.
    expect(passLineOf(closed())).toBeNull();
  });
});

describe('the facts store', () => {
  it('answers the line and the newest closed pass of one change only', () => {
    const line: ChangeLine = { kind: 'stale', at: AT, eventSeq: 4, grade: 'weak', evidence: [], options: [] };
    const facts = {
      lines: { chg_2: line },
      passes: {
        stp_old: closed({ stepId: 'stp_old', at: AT, sentence: 'старый' }),
        stp_new: closed({ stepId: 'stp_new', at: AT + 1_000, sentence: 'новый' }),
        stp_other: closed({ stepId: 'stp_other', changeId: 'chg_9', at: AT + 2_000 }),
      },
    };
    expect(changeLineOf(facts, 'chg_2')).toBe(line);
    expect(changeLineOf(facts, 'chg_9')).toBeNull();
    expect(changeLineOf(facts, null)).toBeNull();
    expect(closedPassOf(facts, 'chg_2')?.stepId).toBe('stp_new');
    expect(closedPassOf(facts, 'chg_9')?.stepId).toBe('stp_other');
    expect(closedPassOf(facts, null)).toBeNull();
  });

  it('keeps one object per publish: the same maps are the same snapshot', () => {
    resetLiveChange();
    const empty = liveChangeFacts();
    // A frame that changed neither map is not a new fact: the record is not re-rendered.
    publishLiveChange(empty);
    expect(liveChangeFacts()).toBe(empty);
    const line: ChangeLine = { kind: 'queued', at: AT, eventSeq: 1, ahead: 1, depth: 2 };
    publishLiveChange({ lines: { chg_2: line }, passes: {} });
    const first = liveChangeFacts();
    publishLiveChange(first);
    expect(liveChangeFacts()).toBe(first);
    expect(liveChangeFacts().lines.chg_2).toBe(line);
    expect(STAGE_WORDS.landed).toBe('записано');
    resetLiveChange();
    expect(liveChangeFacts().lines).toEqual({});
  });
});
