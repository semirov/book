import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { appendStage, StageInputError } from '../src/stages/repo.ts';
import type { Db } from '../src/db/db.ts';
import { createEngineFixture, type Fixture } from './engine/helpers.ts';

/**
 * BOOK-DOC-84 §10.8 — the ladder's own columns on a stage: the gate, its round, the answer, the
 * widening code and the desperate sixth. Split from `stages.test.ts` at the arch bound.
 */

let fixture: Fixture | null = null;
let db: Db;

beforeEach(() => {
  fixture = createEngineFixture({});
  db = fixture.db;
});

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function stageInput(overrides: Record<string, unknown> = {}): Parameters<typeof appendStage>[1] {
  return {
    chapter: 8,
    passId: 'stp_a',
    stage: 'read',
    at: 1_793_091_600_123,
    actor: { process: 'writer', model: 'deepseek-flash' },
    summary: 'собрано: канон, соседи, задание',
    ...overrides,
  } as Parameters<typeof appendStage>[1];
}

function refusalOf(run: () => unknown): StageInputError {
  try {
    run();
  } catch (error) {
    if (error instanceof StageInputError) return error;
    throw error;
  }
  throw new Error('the store accepted an input it must refuse');
}

describe('§10.8 — the stage store’s ladder columns', () => {
  it('stores the gate, its round and the answer as columns, never as prose', () => {
    const event = appendStage(
      db,
      stageInput({
        stage: 'verdict',
        gate: 'editor',
        round: 2,
        verdict: 'GAP',
        summary: 'редактор: GAP · замечаний 3',
      }),
    );
    expect(event).toMatchObject({ gate: 'editor', round: 2, verdict: 'GAP' });
    // The stored row is the source: a reader replaying the table sees the same three facts.
    const row = db.prepare(`SELECT gate, round, verdict FROM pass_stages WHERE pass_id = 'stp_a'`).get();
    expect(row).toEqual({ gate: 'editor', round: 2, verdict: 'GAP' });
  });

  it('stores the widening as a code and refuses an invented one', () => {
    const event = appendStage(
      db,
      stageInput({ stage: 'widening', widened: 'wider-edit', attempt: 4, maxAttempts: 5 }),
    );
    expect(event).toMatchObject({
      stage: 'widening',
      attempt: 4,
      widened: { code: 'wider-edit', sentence: 'правим шире: не строку, а абзац' },
    });
    expect(refusalOf(() => appendStage(db, stageInput({ widened: 'переписывание' }))).code).toBe('INVALID_STAGE');
  });

  it('a desperate stage is 6 of 6, whatever the caller sends', () => {
    const event = appendStage(db, stageInput({ stage: 'drafting', desperate: true, attempt: 2 }));
    expect(event).toMatchObject({ attempt: 6, maxAttempts: 6, desperate: true });
  });

});
