import { describe, expect, it } from 'vitest';

import { databaseFile, openDatabase } from '../../src/db/db.ts';
import { applyChapterFile } from '../../src/ingest/applyChapter.ts';
import { applyFrontFile } from '../../src/ingest/applyFront.ts';

import { historyFixture } from './helpers.ts';

const TEXT = 'Первая\n\nПоловик в тамбуре намок насквозь ещё в четверг.';

describe('one observed write, two processes (§6F.1)', () => {
  it('the loser of a landing race records nothing rather than failing', () => {
    const fixture = historyFixture();
    // The engine holds its own connection in production; a second handle is the same thing.
    const other = openDatabase(databaseFile(fixture.dataDir));
    try {
      applyChapterFile({ db: fixture.db, dataDir: fixture.dataDir, n: 1, raw: TEXT, mtimeMs: 1, nowMs: 1 });
      // `other` still sees rev 1 in its own snapshot, so it would compute rev 2 as well.
      const raced = applyChapterFile({ db: other, dataDir: fixture.dataDir, n: 1, raw: TEXT, mtimeMs: 2, nowMs: 2 });
      expect(raced.status).toBe('unchanged');
      const revisions = fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = 1').get() as { n: number };
      expect(revisions.n).toBe(1);
      const events = fixture.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'chapter.created'`).get() as {
        n: number;
      };
      expect(events.n).toBe(1);
    } finally {
      other.close();
      fixture.close();
    }
  });

  it('the same race on the first sheet is a no-op when the text agrees', () => {
    const fixture = historyFixture();
    const other = openDatabase(databaseFile(fixture.dataDir));
    const front = 'Земля, которая больше не кормит\n\nКнига о том, как вещи научились обходиться без тех, кто их завёл.';
    try {
      applyFrontFile({ db: fixture.db, dataDir: fixture.dataDir, raw: front, mtimeMs: 1, nowMs: 1 });
      const raced = applyFrontFile({ db: other, dataDir: fixture.dataDir, raw: front, mtimeMs: 2, nowMs: 2 });
      expect(raced.status).toBe('unchanged');
      const rows = fixture.db.prepare('SELECT COUNT(*) AS n FROM front_revisions').get() as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      other.close();
      fixture.close();
    }
  });
});
