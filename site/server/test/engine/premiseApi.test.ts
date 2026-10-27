import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import { premiseOfStep } from '../../src/engine/premise.ts';
import * as store from '../../src/engine/store.ts';
import { reconcile as ingestReconcile } from '../../src/ingest/reconcile.ts';
import { AT, accept, change, fixtureOf, fourWritten, seed } from './premiseHelpers.ts';

/**
 * BOOK-7 — the premise's edges: the public driver shapes, the rule that a comment left on
 * an empty chapter is judged against the chapter as it stands at acceptance, and the link
 * between a draft step and a real premise row.
 */

describe('BOOK-7 — premise links and the driver surface', () => {
  it('reads no premise from an unknown or an ordinary change link', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      const step = store.getStep(fixture.db, assignment.stepId) as store.StepRow;
      expect(premiseOfStep(fixture.db, { ...step, premise_change: 'chg_missing' })).toBeNull();
      store.insertChange(fixture.db, {
        id: 'chg_ordinary',
        kind: 'operator',
        interventionKind: null,
        chapter: 9,
        anchor: null,
        intent: 'обычная правка',
        proposedText: null,
        sourceComment: null,
        sourceSession: null,
        baseRev: 0,
        baseSha: '',
        baseBlocks: '[]',
        scopeHint: 'chapter',
        premise: 0,
        enqueuedAt: AT,
      });
      expect(premiseOfStep(fixture.db, { ...step, premise_change: 'chg_ordinary' })).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('records the standing revision when a comment left on an empty chapter is accepted after it was written', () => {
    const fixture = fixtureOf();
    try {
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      // Posted while the chapter had no text: the comment carries the premise base 0.
      fixture.db.prepare('UPDATE comments SET base_rev = 0 WHERE id = ?').run(id);
      fixture.writeChapterBlocks(5, 'Глава 5', ['Пятая глава уже написана.', 'Служебный абзац.']);
      ingestReconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);
      // A written chapter is an ordinary change, against the revision that stands — never 0.
      expect(change(fixture.db, accepted.changeId)).toMatchObject({ premise: 0, base_rev: 1 });
    } finally {
      fixture.close();
    }
  });

  it('hands the premise out on `next` and names it in `trace` — the driver’s shapes are unchanged', async () => {
    const fixture = fixtureOf();
    const app = await buildControl({ engine: fixture.engine, token: 'test-token', logger: false });
    try {
      fourWritten(fixture);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      const nextResponse = await app.inject({
        method: 'POST',
        url: '/internal/next',
        headers: { authorization: 'Bearer test-token' },
        payload: { for: 'fwd', session: 'writer-fwd' },
      });
      expect(nextResponse.statusCode).toBe(200);
      const assignment = nextResponse.json().data as Record<string, unknown>;
      // The same assignment shape, with one additive field: the premise.
      expect(assignment).toMatchObject({
        pass: 'draft',
        chapter: 5,
        premise: { intent: 'в главе 5 появляется документ о допуске', kind: 'document' },
      });
      expect(typeof assignment.stepId).toBe('string');
      expect(typeof assignment.leaseId).toBe('string');

      const traceResponse = await app.inject({
        method: 'POST',
        url: '/internal/trace',
        headers: { authorization: 'Bearer test-token' },
        payload: { id: accepted.changeId },
      });
      expect(traceResponse.statusCode).toBe(200);
      const trace = traceResponse.json().data as {
        kind: string;
        change: { change: { premise: boolean; status: string }; cascade: unknown };
      };
      expect(trace.kind).toBe('change');
      expect(trace.change.change.premise).toBe(true);
      expect(trace.change.change.status).toBe('pending');
      expect(trace.change.cascade).toBeNull();
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
