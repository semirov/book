/**
 * BOOK-166 (owner, 2026-10-28) — the book is written only on interventions.
 *
 * A draft pass exists only to serve a filing (a reader's premise on an empty chapter), the work
 * is taken in the filings' own order, and a filing that can never be written is closed with its
 * reason instead of blocking the queue behind it. With no filings the lane has no work and spends
 * nothing — that is the whole point: the book waits for readers.
 */

import { describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import { FRAME_LAST_SENTENCE } from '@book/shared';

import type { Db } from '../../src/db/db.ts';
import { createEngineFixture, type Fixture } from './helpers.ts';
import { codeOf, accept, change, seed } from './premiseHelpers.ts';

/** A fixture that does not file for the test: the rule itself is what is being read here. */
function manualFixture(): Fixture {
  const fixture = createEngineFixture({ filings: 'manual' });
  fixture.db
    .prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_viewer', 'yandex-viewer', 'Аня', '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    )
    .run();
  return fixture;
}

/** Chapters 1..4 written, so the forward lane's next draft slot is chapter 5. */
function written(fixture: Fixture): void {
  for (let n = 1; n <= 4; n += 1) {
    fixture.writeChapterBlocks(n, `Глава ${n}`, [`Служебный абзац главы ${n}. Он не является текстом книги.`]);
  }
}

/** One admitted filing: the fixture records the audit and rights verdicts, so this always lands. */
function filing(fixture: { db: Db }, chapter: number, intent: string): { changeId: string } {
  return accept(fixture.db, seed(fixture.db, { chapter }), intent) as { changeId: string };
}

describe('the engine writes only on a filing', () => {
  it('hands out nothing and spends nothing when there are no filings', () => {
    const fixture = manualFixture();
    try {
      written(fixture);
      expect(fixture.engine.next({ for: 'fwd', session: 'w1' })).toBeNull();
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM pass_spend').get()).toEqual({ n: 0 });
      // And a named pass speaks the code instead of inventing a chapter.
      expect(codeOf(() => fixture.engine.openChapterPass(5, 'w1'))).toBe('NO_FILING_FOR_CHAPTER');
    } finally {
      fixture.close();
    }
  });

  it('opens exactly one draft step, bound to the filing it serves', () => {
    const fixture = manualFixture();
    try {
      written(fixture);
      const filed = filing(fixture, 5, 'глава 5 начинается с документа');
      const head = change(fixture.db, filed.changeId);
      expect(head.premise).toBe(1);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'w1' }) as WriterAssignment;
      expect(assignment.chapter).toBe(5);
      const step = fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(assignment.stepId) as {
        pass: string;
        premise_change: string | null;
      };
      expect(step.pass).toBe('draft');
      expect(step.premise_change).toBe(filed.changeId);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });

  it('takes the older filing first, even when the later one is a smaller chapter', () => {
    const fixture = manualFixture();
    try {
      written(fixture);
      const older = filing(fixture, 7, 'замысел для главы 7');
      const newer = filing(fixture, 5, 'замысел для главы 5');
      expect(older.changeId).not.toBe(newer.changeId);

      const first = fixture.engine.next({ for: 'fwd', session: 'w1' }) as WriterAssignment;
      expect(first.chapter).toBe(7);
      const second = fixture.engine.next({ for: 'fwd', session: 'w2' }) as WriterAssignment;
      expect(second.chapter).toBe(5);
    } finally {
      fixture.close();
    }
  });

  it('closes a filing on a frozen chapter with its reason and serves the next one', () => {
    const fixture = manualFixture();
    try {
      written(fixture);
      // ch67 is the book's last sentence, the frame slot no reader writes.
      // ch67 as the book's last sentence: a basis-only slot, never prose (BOOK-6).
      fixture.writeChapter(67, FRAME_LAST_SENTENCE);
      const frozen = filing(fixture, 67, 'перепиши последнюю главу');
      const later = filing(fixture, 5, 'глава 5 начинается с документа');

      const assignment = fixture.engine.next({ for: 'fwd', session: 'w1' }) as WriterAssignment;
      expect(assignment.chapter).toBe(5);
      const dropped = change(fixture.db, frozen.changeId);
      expect(dropped.status).toBe('void');
      expect(dropped.outcome).toBe('dropped');
      expect(String(dropped.reason ?? '')).toMatch(/неподвижна/u);
      expect(change(fixture.db, later.changeId).status).toBe('pending');
    } finally {
      fixture.close();
    }
  });
});
