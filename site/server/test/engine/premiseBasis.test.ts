import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, PREMISE_FROZEN_REASON, TOTAL_CHAPTERS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { admitPremise } from '../../src/engine/premise.ts';
import { reconcile as ingestReconcile } from '../../src/ingest/reconcile.ts';
import { newChangeId } from '../../src/util/ulid.ts';
import { AT, acceptResult, change, codeOf, fixtureOf, seed } from './premiseHelpers.ts';

/**
 * BOOK-137 — a basis-only slot (the opening and the finale) is its frame sentence and nothing else.
 *
 * All three creators of a `changes` row — the engine's queue, the acceptance path and the premise
 * sweep — say the same thing about it: the frame is the whole text, so a filing there has no prose
 * to rewrite and is refused with `FROZEN_FRAME`, never filed as a premise that waits for a first
 * draft which cannot touch the sentence. The freeze is the slot's shape, never its number.
 */
describe('BOOK-137 — a basis slot refuses a filing in every writer of `changes`', () => {
  it('refuses a chapter-level acceptance on a basis slot, as the queue does — never a premise', () => {
    const fixture = fixtureOf();
    try {
      // The real basis files: the ingest projects ch01/ch42 as rows (rev 0, one block).
      fixture.seedChapter(1, FRAME_FIRST_SENTENCE);
      fixture.seedChapter(TOTAL_CHAPTERS, FRAME_LAST_SENTENCE);
      ingestReconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
      expect(
        fixture.db
          .prepare('SELECT n, rev, basis, block_count FROM chapters WHERE n IN (1, ?) ORDER BY n')
          .all(TOTAL_CHAPTERS),
      ).toEqual([
        { n: 1, rev: 0, basis: 1, block_count: 1 },
        { n: TOTAL_CHAPTERS, rev: 0, basis: 1, block_count: 1 },
      ]);

      const answers = [
        acceptResult(fixture.db, seed(fixture.db, { chapter: 1 }), 'переписать первую фразу'),
        acceptResult(
          fixture.db,
          seed(fixture.db, { chapter: 1, proposedText: 'Начать иначе.', kind: 'decision' }),
          'переписать начало',
        ),
        acceptResult(fixture.db, seed(fixture.db, { chapter: TOTAL_CHAPTERS }), 'переписать финал'),
      ];
      expect(answers).toEqual([
        { code: 'FROZEN_FRAME', error: PREMISE_FROZEN_REASON },
        { code: 'FROZEN_FRAME', error: PREMISE_FROZEN_REASON },
        { code: 'FROZEN_FRAME', error: PREMISE_FROZEN_REASON },
      ]);

      // No premise was created and neither sentence moved.
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
      expect(
        fixture.db
          .prepare('SELECT n, rev, basis, block_count FROM chapters WHERE n IN (1, ?) ORDER BY n')
          .all(TOTAL_CHAPTERS),
      ).toEqual([
        { n: 1, rev: 0, basis: 1, block_count: 1 },
        { n: TOTAL_CHAPTERS, rev: 0, basis: 1, block_count: 1 },
      ]);

      // The engine's own admission path gives the same answer for the same reason.
      const basisRefusal = (n: number): string | null =>
        codeOf(() => fixture.engine.enqueue({ kind: 'reader_edit', chapter: n, intent: 'иначе' }));
      expect([1, TOTAL_CHAPTERS].map(basisRefusal)).toEqual(['FROZEN_FRAME', 'FROZEN_FRAME']);
    } finally {
      fixture.close();
    }
  });

  it('settles a premise left on a basis slot at reconcile, and keeps an empty chapter’s', () => {
    const fixture = fixtureOf();
    try {
      fixture.seedChapter(1, FRAME_FIRST_SENTENCE);
      fixture.seedChapter(TOTAL_CHAPTERS, FRAME_LAST_SENTENCE);
      ingestReconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
      // Rows from before the refusal existed: a premise is filed straight onto a basis slot and
      // onto an empty ch05, which is what BOOK-7 keeps waiting for its first draft.
      const premiseOn = (chapter: number): string =>
        admitPremise(fixture.db, {
          id: newChangeId(Date.parse(AT)),
          kind: 'reader_edit',
          chapter,
          intent: 'иначе',
          interventionKind: null,
          sourceComment: null,
          sourceSession: null,
          at: AT,
        }).id;
      const basis = premiseOn(1);
      const empty = premiseOn(5);

      expect(fixture.engine.reconcile()).toMatchObject({ premisesSettled: 1 });
      expect(change(fixture.db, basis)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: PREMISE_FROZEN_REASON,
      });
      expect(change(fixture.db, empty)).toMatchObject({ status: 'pending', premise: 1 });
    } finally {
      fixture.close();
    }
  });
});
