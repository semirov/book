import {
  BACKWARD_FIRST,
  FORWARD_LAST,
  FRAME_FIRST_SENTENCE,
  FRAME_LAST_SENTENCE,
  TOTAL_CHAPTERS,
  type WriterAssignment,
} from '@book/shared';
import { describe, expect, it } from 'vitest';

import { dailyTokens, nextDraftChapter } from '../../src/engine/draft.ts';
import { chapterText, createEngineFixture } from './helpers.ts';

const set = (...chapters: number[]): Set<number> => new Set(chapters);
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe('nextDraftChapter — two fronts, one meeting point (§6A.9, §6A.10)', () => {
  it('starts at the two fixed points', () => {
    expect(nextDraftChapter(set(), 'fwd')).toBe(1);
    expect(nextDraftChapter(set(), 'bwd')).toBe(TOTAL_CHAPTERS);
  });

  it('writes contiguously away from its fixed point', () => {
    expect(nextDraftChapter(set(1, 2), 'fwd')).toBe(3);
    expect(nextDraftChapter(set(TOTAL_CHAPTERS, TOTAL_CHAPTERS - 1), 'bwd')).toBe(TOTAL_CHAPTERS - 2);
    // A hole is not skipped: the lane fills the first missing slot.
    expect(nextDraftChapter(set(1, 2, 4), 'fwd')).toBe(3);
  });

  it('stops a lane at its half of the book', () => {
    expect(nextDraftChapter(new Set(range(1, FORWARD_LAST)), 'fwd')).toBeNull();
    expect(nextDraftChapter(new Set(range(FORWARD_LAST + 1, TOTAL_CHAPTERS)), 'bwd')).toBeNull();
  });

  it('never lets the fronts cross', () => {
    const all = new Set(range(1, TOTAL_CHAPTERS));
    expect(nextDraftChapter(all, 'fwd')).toBeNull();
    expect(nextDraftChapter(all, 'bwd')).toBeNull();
    // The backward lane has run down to its first chapter: the forward lane takes the last
    // slot of its own half and never steps over the meeting point (BOOK-DOC-4).
    const meeting = new Set([...range(1, FORWARD_LAST - 1), ...range(BACKWARD_FIRST, TOTAL_CHAPTERS)]);
    expect(nextDraftChapter(meeting, 'fwd')).toBe(FORWARD_LAST);
    expect(nextDraftChapter(new Set([...meeting, FORWARD_LAST]), 'fwd')).toBeNull();
    expect(nextDraftChapter(meeting, 'bwd')).toBeNull();
  });
});

describe('the forward lane walks away from the opening (BOOK-155)', () => {
  it('offers chapter 8 once chapters 1–7 are written', () => {
    expect(nextDraftChapter(new Set(range(1, 7)), 'fwd')).toBe(8);
  });

  it('hands chapter 8 out as the next pass of a book with 1–7 written', () => {
    const chapters = Object.fromEntries(
      range(1, 7).map((n) => [n, chapterText(`Глава ${String(n)}`, [`Тестовый абзац главы ${String(n)}.`])]),
    );
    const fixture = createEngineFixture({ chapters });
    try {
      expect(fixture.engine.next({ for: 'fwd', session: 'fwd-1' })).toMatchObject({ pass: 'draft', chapter: 8 });
    } finally {
      fixture.close();
    }
  });
});

describe('the owner’s writing switch (§6A.9, BOOK-6)', () => {
  it('hands out no step for an empty book while drafting is off', () => {
    const fixture = createEngineFixture({ env: { DRAFTING: 'off' } });
    try {
      // The owner's state: ch01 and the last chapter hold only their basis sentence.
      fixture.writeChapter(1, FRAME_FIRST_SENTENCE);
      fixture.writeChapter(TOTAL_CHAPTERS, FRAME_LAST_SENTENCE);

      expect(fixture.engine.next({ for: 'fwd', session: 'fwd-1' })).toBeNull();
      expect(fixture.engine.next({ for: 'bwd', session: 'bwd-1' })).toBeNull();
      const steps = fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get() as { n: number };
      const leases = fixture.db.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number };
      expect(steps.n).toBe(0);
      expect(leases.n).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('drafts from the two fixed points once the owner turns it on', () => {
    const fixture = createEngineFixture({ env: { DRAFTING: 'on' } });
    try {
      expect(fixture.engine.next({ for: 'fwd', session: 'fwd-1' })).toMatchObject({ pass: 'draft', chapter: 1 });
      expect(fixture.engine.next({ for: 'bwd', session: 'bwd-1' })).toMatchObject({
        pass: 'draft',
        chapter: TOTAL_CHAPTERS,
      });
    } finally {
      fixture.close();
    }
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

  it('keeps drafting out of the way while the day is paused (BOOK-117)', () => {
    const fixture = createEngineFixture({ env: { BUDGET_DAILY_TOKENS: '100' } });
    try {
      const at = new Date(fixture.clock.now()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
      fixture.db
        .prepare(
          `INSERT INTO steps (step_id, seq, wave, pass, chapter, boundary, at, outcome, tokens_in, tokens_out)
           VALUES ('stp_spent', 0, 0, 'draft', 1, 'front', ?, 'rewritten', 90, 20)`,
        )
        .run(at);
      fixture.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
           VALUES (?, ?, 'stp_spent', 1, 'draft', 'deepseek/deepseek-v4-pro', 0, 0, 10.01, 1)`,
        )
        .run(at, at.slice(0, 10));

      // Tokens stay information — the engine still calls itself throttled — while the money is
      // the bound that refuses the pass, with the day's own sentence as the message.
      expect(fixture.engine.state()).toMatchObject({ status: 'throttled', tokens: { today: 110 } });
      expect(fixture.engine.state().budget.state).toBe('pause');
      expect(() => fixture.engine.next({ for: 'fwd', session: 'fwd-1' })).toThrowError(/^пауза · дневной потолок/u);
      // No draft was opened: the one step in the table is the seeded row.
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });

  it('a draft keeps the title line and writes into an empty slot', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
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
