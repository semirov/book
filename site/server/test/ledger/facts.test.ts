import { afterEach, describe, expect, it } from 'vitest';

import { assertFact, factAsOf, invalidateFact } from '../../src/ledger/facts.ts';
import { advanceThread, getThread, openThread, ThreadTransitionError } from '../../src/ledger/threads.ts';
import { AT, ledgerFixture, seedChange, type LedgerFixture } from './helpers.ts';

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

describe('factAsOf — what the book believes in a chapter', () => {
  it('keeps a fact until the change that invalidated it, and reports the new one from then on', () => {
    fixture = ledgerFixture();
    const { db } = fixture;
    // Fact A is stated in chapter 1 and invalidated by a change filed at chapter 10.
    // Fact B is stated at chapter 10. Chapter 9 must see A, chapter 10 must see B.
    seedChange(db, { id: 'chg_ten', chapter: 10 });
    const a = assertFact(db, {
      id: 'fct_a',
      chapter: 1,
      kind: 'document',
      statement: 'Служебный документ существует.',
      term: 'служебный документ',
      at: AT,
    });
    invalidateFact(db, { id: a, changeId: 'chg_ten', at: AT });
    const b = assertFact(db, {
      id: 'fct_b',
      chapter: 10,
      kind: 'state',
      statement: 'Служебное состояние наступило.',
      term: null,
      at: AT,
    });

    expect(factAsOf(db, 9).map((fact) => fact.id)).toEqual([a]);
    expect(factAsOf(db, 10).map((fact) => fact.id)).toEqual([b]);
    // A row that was invalidated keeps its text and its chapter: it is history, not a deletion.
    expect(db.prepare('SELECT statement, invalidated_at FROM facts WHERE id = ?').get(a)).toEqual({
      statement: 'Служебный документ существует.',
      invalidated_at: AT,
    });
  });

  it('is never deleted, and an unknown fact is a caller error rather than silence', () => {
    fixture = ledgerFixture();
    const { db } = fixture;
    const id = assertFact(db, { chapter: 3, kind: 'decision', statement: 'Служебное решение.', at: AT });

    expect(() => db.prepare('DELETE FROM facts WHERE id = ?').run(id)).toThrow(/never deleted/u);
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 1 });
    expect(() => invalidateFact(db, { id: 'fct_missing', changeId: null, at: AT })).toThrow(/unknown fact/u);
    // A second invalidation is not a second fact: the first record stands.
    invalidateFact(db, { id, changeId: null, at: AT });
    expect(() => invalidateFact(db, { id, changeId: null, at: '2026-10-26T00:00:00Z' })).not.toThrow();
    expect(db.prepare('SELECT invalidated_at FROM facts WHERE id = ?').get(id)).toEqual({ invalidated_at: AT });
  });
});

describe('the thread state machine', () => {
  it('opens, advances, complicates and closes — and a closed thread never moves again', () => {
    fixture = ledgerFixture();
    const { db } = fixture;
    const id = openThread(db, { label: 'служебная линия', direction: 'forward', chapter: 2, at: AT });
    expect(getThread(db, id)?.state).toBe('opened');

    expect(advanceThread(db, { threadId: id, chapter: 5, kind: 'advanced', at: AT })).toBe('advanced');
    expect(advanceThread(db, { threadId: id, chapter: 7, kind: 'complicated', at: AT })).toBe('complicated');
    expect(advanceThread(db, { threadId: id, chapter: 9, kind: 'closed', at: AT })).toBe('closed');
    expect(getThread(db, id)).toMatchObject({ state: 'closed', closed_at_chapter: 9 });

    expect(() => advanceThread(db, { threadId: id, chapter: 10, kind: 'advanced', at: AT })).toThrow(
      ThreadTransitionError,
    );
    // The refused move wrote nothing: three events for three accepted moves, plus the opening.
    expect(db.prepare('SELECT COUNT(*) AS n FROM thread_events WHERE thread_id = ?').get(id)).toEqual({ n: 4 });
    expect(db.prepare('SELECT closed_at_chapter FROM threads WHERE id = ?').get(id)).toEqual({
      closed_at_chapter: 9,
    });
  });

  it('refuses a move of a thread that does not exist', () => {
    fixture = ledgerFixture();
    expect(() =>
      advanceThread(fixture.db, { chapter: 2, threadId: 'thr_missing', kind: 'advanced', at: AT }),
    ).toThrow(ThreadTransitionError);
  });
});
