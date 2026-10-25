import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { dailyTokens, nextDraftChapter } from '../../src/engine/draft.ts';
import { chapterText, createEngineFixture } from './helpers.ts';

const set = (...chapters: number[]): Set<number> => new Set(chapters);
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe('nextDraftChapter — two fronts, one meeting point (§6A.9, §6A.10)', () => {
  it('starts at the two fixed points', () => {
    expect(nextDraftChapter(set(), 'fwd')).toBe(1);
    expect(nextDraftChapter(set(), 'bwd')).toBe(67);
  });

  it('writes contiguously away from its fixed point', () => {
    expect(nextDraftChapter(set(1, 2), 'fwd')).toBe(3);
    expect(nextDraftChapter(set(67, 66), 'bwd')).toBe(65);
    // A hole is not skipped: the lane fills the first missing slot.
    expect(nextDraftChapter(set(1, 2, 4), 'fwd')).toBe(3);
  });

  it('stops a lane at its half of the book', () => {
    expect(nextDraftChapter(new Set(range(1, 34)), 'fwd')).toBeNull();
    expect(nextDraftChapter(new Set(range(35, 67)), 'bwd')).toBeNull();
  });

  it('never lets the fronts cross', () => {
    const all = new Set(range(1, 67));
    expect(nextDraftChapter(all, 'fwd')).toBeNull();
    expect(nextDraftChapter(all, 'bwd')).toBeNull();
    // The backward lane has run to 35: the forward lane may not take 34 or below 35.
    expect(nextDraftChapter(new Set(range(35, 67)), 'bwd')).toBeNull();
    expect(nextDraftChapter(new Set([...range(1, 30), ...range(35, 67)]), 'fwd')).toBe(31);
  });
});

describe('dailyTokens — the input to the throttled state (§6A.12)', () => {
  it('counts only the current UTC day', () => {
    const fixture = createEngineFixture();
    try {
      const write = (id: string, at: string, tokensIn: number, tokensOut: number): void => {
        fixture.db
          .prepare(
            `INSERT INTO steps (step_id, seq, wave, pass, chapter, boundary, at, tokens_in, tokens_out)
             VALUES (?, 0, 0, 'draft', 1, 'front', ?, ?, ?)`,
          )
          .run(id, at, tokensIn, tokensOut);
      };
      const now = Date.UTC(2026, 9, 25, 12, 0, 0);
      write('stp_today', '2026-10-25T00:30:00Z', 100, 20);
      write('stp_today2', '2026-10-25T11:59:00Z', 5, 5);
      write('stp_yesterday', '2026-10-24T23:59:00Z', 9_999, 9_999);
      expect(dailyTokens(fixture.db, now)).toBe(130);
    } finally {
      fixture.close();
    }
  });

  it('keeps drafting out of the way when the day is spent', () => {
    const fixture = createEngineFixture({ env: { BUDGET_DAILY_TOKENS: '100' } });
    try {
      fixture.db
        .prepare(
          `INSERT INTO steps (step_id, seq, wave, pass, chapter, boundary, at, outcome, tokens_in, tokens_out)
           VALUES ('stp_spent', 0, 0, 'draft', 1, 'front', ?, 'rewritten', 90, 20)`,
        )
        .run(new Date(fixture.clock.now()).toISOString().replace(/\.\d{3}Z$/u, 'Z'));
      expect(fixture.engine.next({ for: 'fwd', session: 'fwd-1' })).toBeNull();
      expect(fixture.engine.state().status).toBe('throttled');
    } finally {
      fixture.close();
    }
  });

  it('a draft keeps the title line and writes into an empty slot', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment | null;
      expect(assignment).toMatchObject({ pass: 'draft', chapter: 2 });
      if (!assignment) throw new Error('expected a writer assignment');
      fixture.engine.start(assignment.leaseId);
      expect(() => fixture.engine.land(assignment.leaseId, { noWrite: true })).toThrow(/must write its slot/u);
    } finally {
      fixture.close();
    }
  });
});
