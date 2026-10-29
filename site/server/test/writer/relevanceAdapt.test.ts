/**
 * A base that moved is the normal case, not a silent stall (BOOK-219, §6A.7).
 *
 * Strict FIFO guarantees that by the time the second change on a chapter is processed, the first
 * one has rewritten the text it was recorded against. The engine refuses `start` with
 * `RELEVANCE_DECISION` and hands the judgement to the writer; before this fix the lane parked
 * the pass there, so an ordinary filing was escalated without a single model call.
 *
 * Now the lane answers the engine itself — `adapt`, the change's own intent, a public sentence
 * naming the moved base — and the pass goes on to write, gate and close. No prompt changed and no
 * model call was added to make that decision.
 */

import { describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import { listStages } from '../../src/stages/repo.ts';
import { EngineRefusalError } from '../../src/writer/client.ts';
import { startWriting } from '../../src/writer/relevance.ts';
import { accept, seed } from '../engine/premiseHelpers.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

/**
 * The seam these tests prove is the close and the way back, so they write a whole chapter:
 * `WRITER_MODE_DEFAULT=rewrite` is the owner's switch, and the patch default has its own
 * files (`patchPass.test.ts`, `noOpPass.test.ts`).
 */
const REWRITE = { env: { WRITER_MODE_DEFAULT: 'rewrite' } };

const CHAPTER = 40;
const AT = '2026-10-25T09:00:00Z';

/** A change assignment: no intent of its own, the premise's goal instead. */
function assignment(): WriterAssignment {
  return {
    leaseId: 'lease',
    stepId: 'step',
    chapter: CHAPTER,
    pass: 'change',
    session: 'writer-test',
    intent: null,
    premise: { intent: { value: 'замысел главы 40', untrusted: true }, kind: 'document' },
    verdicts: { editor: false, consultant: false, rights: false },
  } as unknown as WriterAssignment;
}

/** The reader the engine's filings belong to (`premiseHelpers` names them by hand). */
function viewer(harness: Harness): void {
  harness.fixture.db
    .prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_viewer', 'yandex-viewer', 'Аня', ?, ?)`,
    )
    .run(AT, AT);
}

function changeRow(harness: Harness, id: string): Record<string, unknown> | undefined {
  return harness.fixture.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

describe('the writer answers a moved base itself', () => {
  it('adapts the second change on a chapter and closes it `done` as `adapted`', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      viewer(harness);
      // Two filings against the same revision: the first rewrite makes the second one's base move.
      const firstComment = seed(harness.fixture.db, { chapter: CHAPTER });
      const secondComment = seed(harness.fixture.db, { chapter: CHAPTER });
      const first = accept(harness.fixture.db, firstComment, 'в главе 40 появляется документ о допуске');
      const second = accept(harness.fixture.db, secondComment, 'в главе 40 появляется второй документ');

      harness.script.push(chapterAnswer('Глава сорок', 'первый'), 'HOLDS', 'HOLDS');
      const one = await harness.run({ lanes: ['filing'] });
      expect(one.status).toBe('closed');
      expect(changeRow(harness, first.changeId)?.status).toBe('done');

      // The second start would be refused: the text it was recorded against is gone.
      harness.script.push(chapterAnswer('Глава сорок', 'второй'), 'HOLDS', 'HOLDS');
      const two = await harness.run({ lanes: ['filing'] });

      // It is written, not parked: the pass produced a `done` change, never an escalation.
      expect(two.status).toBe('closed');
      const change = changeRow(harness, second.changeId);
      expect(change?.status).toBe('done');
      expect(change?.outcome).toBe('adapted');
      expect(stepRow(harness.fixture, two.stepId ?? '')?.outcome).toBe('rewritten');
      // The writer's answer is recorded as one: the base it was re-anchored to, in its own words.
      const relevance = JSON.parse(String(change?.relevance)) as {
        grade: string;
        decidedBy: string;
        applies: string;
        reason: string;
      };
      expect(relevance.grade).toBe('unknown');
      expect(relevance.decidedBy).toBe('writer');
      expect(relevance.applies).toBe('partial');
      expect(relevance.reason).toBe('основание сдвинулось: заявка применена к текущей редакции главы 40');
      // The adapted change keeps its own intent — nothing was narrowed for it.
      expect(change?.intent).toBe('в главе 40 появляется второй документ');
      // One log line names the revision it was re-anchored to; no new stage word was invented.
      expect(harness.logs.join('\n')).toContain('[writer] relevance: adapt к редакции 2');
      const stages = listStages(harness.fixture.db, CHAPTER).map((stage) => stage.stage);
      expect(stages.at(-1)).toBe('landed');
    } finally {
      await harness.close();
    }
  });

  it('returns any other refusal as a failure, and the pass parks on it as before', async () => {
    const refusal = new EngineRefusalError('LEASE_RELEASED', 'lease released by the engine', 409);
    const opened = await startWriting({
      engine: { start: async () => { throw refusal; } },
      lane: { loadText: async () => undefined },
      job: assignment(),
      chapter: CHAPTER,
      log: () => undefined,
    });
    expect(opened).toEqual({
      ok: false,
      failure: { code: 'LEASE_RELEASED', detail: 'движок отказал: LEASE_RELEASED: lease released by the engine' },
    });
  });

  it('parks the pass when the second start is refused (any other code)', async () => {
    let calls = 0;
    const opened = await startWriting({
      engine: {
        start: async () => {
          calls += 1;
          // The base moved, and the engine still will not take the adapted answer.
          throw calls === 1
            ? new EngineRefusalError('RELEVANCE_DECISION', 'the base moved', 409)
            : new EngineRefusalError('INVALID_INTENT', 'an adapted change carries its narrowed intent', 422);
        },
      },
      lane: { loadText: async () => undefined },
      job: assignment(),
      chapter: CHAPTER,
      log: () => undefined,
    });
    expect(calls).toBe(2);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.failure.code).toBe('INVALID_INTENT');
  });

  it('names the current revision when the engine reports none, and takes a premise’s intent', async () => {
    const lines: string[] = [];
    let asked: { intent?: string; reason?: string } = {};
    const opened = await startWriting({
      engine: {
        start: async (_lease, input) => {
          if (input === undefined) throw new EngineRefusalError('RELEVANCE_DECISION', 'the base moved', 409);
          asked = input;
          return { leaseId: 'lease', sha: 'a'.repeat(64), chars: 0 };
        },
      },
      lane: { loadText: async () => undefined },
      job: assignment(),
      chapter: CHAPTER,
      log: (line) => lines.push(line),
    });
    expect(opened.ok).toBe(true);
    // The change carries no intent of its own: the premise's is the goal the next pass receives.
    expect(asked.intent).toBe('замысел главы 40');
    expect(asked.reason).toBe('основание сдвинулось: заявка применена к текущей редакции главы 40');
    expect(lines).toEqual(['[writer] relevance: adapt к текущей редакции главы 40']);
  });
});
