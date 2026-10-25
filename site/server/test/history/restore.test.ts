import { describe, expect, it } from 'vitest';

import { readRestoreSource, recordOperatorRestore } from '../../src/history/restore.ts';
import { listEventRows } from '../../src/history/events.ts';
import { historyFixture, ingest, lastHseq } from './helpers.ts';

describe('operator restore (§6F.1 rule 3, §13.3)', () => {
  it('reads a past revision back for the operator, without touching the manuscript', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch01.md', 'Первая\n\nПервый абзац: половик намок ещё в четверг.');
      const first = lastHseq(fixture.db);
      ingest(fixture, 'ch01.md', 'Первая\n\nВторой абзац: половик давно выбросили.');

      const source = readRestoreSource(fixture.db, fixture.dataDir, 1, 1);
      expect(source?.rev).toBe(1);
      expect(source?.text).toContain('половик намок ещё в четверг');
      expect(source?.text).not.toContain('выбросили');
      expect(source?.snapshot).toMatch(/^versions\/ch01\//u);
      expect(first).toBeLessThan(lastHseq(fixture.db));

      // Absence is absence: no revision, no restore.
      expect(readRestoreSource(fixture.db, fixture.dataDir, 1, 9)).toBeNull();
      expect(readRestoreSource(fixture.db, fixture.dataDir, 2, 1)).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('records the operator’s mark as one new fact, never a second text event', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch01.md', 'Первая\n\nПервый абзац.', new Date('2026-10-25T09:00:00Z'));
      ingest(fixture, 'ch01.md', 'Первая\n\nДругой абзац.', new Date('2026-10-25T10:00:00Z'));
      const before = lastHseq(fixture.db);

      const recorded = recordOperatorRestore(fixture.db, {
        chapter: 1,
        sourceRev: 1,
        newRev: 3,
        because: 'restore rev 1',
        nowMs: Date.parse('2026-10-25T11:00:00Z'),
      });
      expect(recorded.hseq).toBe(before + 1);

      // One row, and it is the operator's act — `chapter.restored` belongs to the ingest,
      // which writes it in the same transaction as the revision (§6F.1).
      const events = listEventRows(fixture.db, { limit: 1 });
      expect(events.map((row) => row.kind)).toEqual(['operator.restore']);
      expect(events[0]).toMatchObject({ chapter: 1, rev: 3, author_kind: 'operator', author_label: 'оператор' });
      const payload = JSON.parse(events[0]?.payload ?? '{}') as { sourceRev: number; because: string };
      expect(payload.sourceRev).toBe(1);
      expect(payload.because).toBe('restore rev 1');

      // The mark can be written without a reason or a new revision: both are optional.
      const bare = recordOperatorRestore(fixture.db, { chapter: 1, sourceRev: 1 });
      const bareRow = listEventRows(fixture.db, { limit: 1 })[0];
      expect(bare.hseq).toBe(bareRow?.hseq);
      expect(JSON.parse(bareRow?.payload ?? '{}')).toEqual({ sourceRev: 1, rev: null });

      // The past was not rewritten: both revisions are still there.
      const revisions = fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = 1').get() as { n: number };
      expect(revisions.n).toBe(2);
    } finally {
      fixture.close();
    }
  });
});
