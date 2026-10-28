/**
 * BOOK-7 — a broken pass is not a refusal.
 *
 * The first real production pass wrote chapter 65, took both gates, revised once, landed the
 * revision — and then the editor's re-ask died on `PROVIDER_SHAPE`. The park went out as an
 * ordinary escalation, the owner's premise took the refusal branch, and the `changes` row went
 * `void / dropped` with the transport string as its public reason: the reader was told their
 * intervention was declined because a gate call failed.
 *
 * `cause` separates the two facts. On the same fixture, and with the same escalation, only the
 * cause decides what the premise becomes.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { settleDraftPremise } from '../../src/engine/premise.ts';
import * as store from '../../src/engine/store.ts';
import { accept, change, fixtureOf, fourWritten, seed } from './premiseHelpers.ts';

/** The park sentence the production pass carried: a provider code, no prose of its own. */
const BROKEN = 'модель не ответила: PROVIDER_SHAPE';

function premiseOf(fixture: ReturnType<typeof fixtureOf>, chapter = 5): string {
  const id = seed(fixture.db, { chapter, proposedText: 'Документ о допуске.', kind: 'document' });
  const accepted = accept(fixture.db, id, `в главе ${String(chapter)} появляется документ о допуске`);
  if ('error' in accepted) throw new Error(accepted.error);
  return accepted.changeId;
}

describe('BOOK-7 — a broken pass settles the premise by cause, never by accident', () => {
  it('applies the premise of a chapter the broken pass wrote, whatever killed the gate afterwards', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const changeId = premiseOf(fixture);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.premise).not.toBeNull();
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(5, 'Глава 5', ['Пятая глава начинается с документа о допуске.', 'Служебный абзац.']);
      fixture.engine.land(assignment.leaseId);
      // The chapter is on disk and landed; the editor's re-ask is what broke.
      const escalated = fixture.engine.escalate(assignment.leaseId, BROKEN, { cause: 'failed' });
      expect(escalated.outcome).toBe('escalated');

      const row = change(fixture.db, changeId);
      expect(row).toMatchObject({ status: 'done', outcome: 'applied', reason: 'вошло в первую редакцию главы 5' });
      expect(typeof row.finished_at).toBe('string');
    } finally {
      fixture.close();
    }
  });

  it('neither takes nor refuses an intervention when a broken pass wrote nothing', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const changeId = premiseOf(fixture);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.premise).not.toBeNull();
      fixture.engine.start(assignment.leaseId);
      // The answer never arrived: nothing was written, so the premise is not taken.
      fixture.engine.escalate(assignment.leaseId, BROKEN, { cause: 'failed' });
      expect(change(fixture.db, changeId)).toMatchObject({ status: 'pending', premise: 1, reason: null });

      // Nor is it refused: the next first pass still carries it.
      const next = fixture.engine.next({ for: 'fwd', session: 'writer-fwd-2' }) as WriterAssignment;
      expect(next.chapter).toBe(5);
      expect(next.premise?.intent.value).toBe('в главе 5 появляется документ о допуске');
      expect(change(fixture.db, changeId)).toMatchObject({ status: 'pending' });
    } finally {
      fixture.close();
    }
  });

  const REFUSALS: Array<['the default cause' | 'an explicit refusal', 'refused' | undefined]> = [
    ['the default cause', undefined],
    ['an explicit refusal', 'refused'],
  ];
  it.each(REFUSALS)('still drops the premise for %s, with the writer’s own words', (_label, cause) => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const changeId = premiseOf(fixture);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.premise).not.toBeNull();
      fixture.engine.start(assignment.leaseId);
      fixture.engine.escalate(assignment.leaseId, 'не беру: документ не из этой сцены', cause === undefined ? {} : { cause });

      expect(change(fixture.db, changeId)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: 'не беру: документ не из этой сцены',
      });
    } finally {
      fixture.close();
    }
  });

  it('leaves a step that is not a draft alone, whatever the cause says', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const changeId = premiseOf(fixture);
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      const step = store.getStep(fixture.db, assignment.stepId) as store.StepRow;

      // A change step never carries a first edition: the settle is a no-op even under `failed`.
      expect(
        settleDraftPremise(fixture.deps, { ...step, pass: 'change' }, 'escalated', null, BROKEN, fixture.clock.now(), 'failed'),
      ).toBeNull();
      expect(change(fixture.db, changeId)).toMatchObject({ status: 'pending', premise: 1 });
    } finally {
      fixture.close();
    }
  });
});
