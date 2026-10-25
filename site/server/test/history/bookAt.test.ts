import { describe, expect, it } from 'vitest';

import { bookAt, chapterAt, resolveMoment } from '../../src/history/book.ts';
import { lastHseq } from '../../src/history/events.ts';
import { listChapterRows } from '../../src/db/repo/chapters.ts';
import { getFrontRow } from '../../src/db/repo/front.ts';
import { insertRevision } from '../../src/db/repo/revisions.ts';
import { appendEvent } from '../../src/history/log.ts';
import { chapterFile, fullBook, historyFixture, ingest } from './helpers.ts';

describe('T-time — the book at any moment (§6F.2)', () => {
  it('bookAt(lastHseq) equals the served state on all 67 chapters and the front matter', () => {
    const fixture = historyFixture(fullBook());
    try {
      ingest(fixture, '00-front.md', fullBook()['00-front.md'] ?? '');
      const hseq = lastHseq(fixture.db);
      const at = bookAt(fixture.db, hseq);
      const chapters = listChapterRows(fixture.db);
      expect(chapters).toHaveLength(67);
      expect(at.chapters).toHaveLength(67);

      for (const row of chapters) {
        const historical = at.chapters.find((entry) => entry.n === row.n);
        expect(historical).toEqual({
          n: row.n,
          rev: row.rev,
          written: true,
          title: row.title,
          chars: row.chars,
        });
      }

      const front = getFrontRow(fixture.db);
      expect(at.front).toEqual({ rev: front?.rev, title: front?.title, about: front?.about });
      expect(at.hseq).toBe(hseq);
      expect(at.lastHseq).toBe(hseq);
      expect(at.at).not.toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('scrubbing to the moment before a second revision shows the earlier text', () => {
    const fixture = historyFixture();
    try {
      const first = 'Глава 9\n\nПервый абзац девятой главы: половик намок ещё в четверг.\n\nВторой абзац: его никто не поднимал.';
      ingest(fixture, 'ch09.md', first);
      const beforeSecond = lastHseq(fixture.db);

      const second = `${first}\n\nТретий абзац появился позже: след от колеса остался с ночи.`;
      ingest(fixture, 'ch09.md', second);

      const then = chapterAt(fixture.db, fixture.dataDir, 9, beforeSecond);
      expect(then?.rev).toBe(1);
      expect(then?.blocks).toHaveLength(2);
      expect(then?.title).toBe('Глава 9');

      const now = chapterAt(fixture.db, fixture.dataDir, 9, null);
      expect(now?.rev).toBe(2);
      expect(now?.blocks).toHaveLength(3);

      // The metadata view agrees: rev 1 at that moment, rev 2 now.
      expect(bookAt(fixture.db, beforeSecond).chapters.find((entry) => entry.n === 9)?.rev).toBe(1);
      expect(bookAt(fixture.db, null).chapters.find((entry) => entry.n === 9)?.rev).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it('shows a chapter that did not exist yet as absent, never as an empty chapter', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch02.md', chapterFile(2));
      const beforeFirst = 0;
      expect(chapterAt(fixture.db, fixture.dataDir, 2, beforeFirst)).toBeNull();
      const at = bookAt(fixture.db, beforeFirst);
      expect(at.chapters.every((entry) => entry.written === false && entry.rev === 0)).toBe(true);
      expect(at.front).toBeNull();
      expect(at.hseq).toBe(0);
      expect(resolveMoment(fixture.db, beforeFirst)).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('resolves an ISO moment to the last event at or before it, never after', () => {
    const fixture = historyFixture();
    try {
      ingest(
        fixture,
        'ch01.md',
        'Глава 1\n\nПервый абзац: половик в тамбуре намок ещё в четверг.',
        new Date('2026-10-25T09:00:00Z'),
      );
      const firstAt = (fixture.db.prepare('SELECT at FROM events ORDER BY hseq LIMIT 1').get() as { at: string }).at;
      const firstHseq = lastHseq(fixture.db);

      ingest(
        fixture,
        'ch02.md',
        'Глава 2\n\nВторой абзац: след от колеса остался с ночи.',
        new Date('2026-10-25T09:30:00Z'),
      );
      expect(resolveMoment(fixture.db, firstAt)).toBe(firstHseq);
      // A shared «книга на 14:20» is resolved by the clock, and `hseq` orders the past.
      expect(resolveMoment(fixture.db, '2026-10-25T09:10:00Z')).toBe(firstHseq);
      expect(resolveMoment(fixture.db, '2026-10-25T09:30:00Z')).toBe(lastHseq(fixture.db));
      expect(resolveMoment(fixture.db, '2020-01-01T00:00:00Z')).toBe(0);
      expect(resolveMoment(fixture.db, 'not a date')).toBe(lastHseq(fixture.db));
      expect(resolveMoment(fixture.db, 999_999)).toBe(lastHseq(fixture.db));
      expect(resolveMoment(fixture.db, String(firstHseq))).toBe(firstHseq);
    } finally {
      fixture.close();
    }
  });

  it('keeps a legacy revision without a log entry out of the past, but shows it as now (files win)', () => {
    const fixture = historyFixture();
    try {
      fixture.db
        .prepare(
          `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
           VALUES (3, 1, 'Старая глава', 'abc', 10, 1, '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z')`,
        )
        .run();
      insertRevision(fixture.db, {
        chapter: 3,
        rev: 1,
        at: '2026-10-01T09:00:00Z',
        kind: 'create',
        causeKind: 'draft',
        changeId: null,
        cascadeId: null,
        stepId: null,
        added: 1,
        changed: 0,
        removed: 0,
        snapshot: 'versions/ch03/missing.md',
        attributed: false,
        logNote: null,
      });
      appendEvent(fixture.db, { kind: 'chapter.created', chapter: 4, rev: 1, authorKind: 'writer' });
      // The row has no clock, so any *past* moment does not contain it…
      expect(bookAt(fixture.db, 0).chapters.find((entry) => entry.n === 3)?.written).toBe(false);
      expect(chapterAt(fixture.db, fixture.dataDir, 3, 0)).toBeNull();
      // …while «now» is the served projection, which still carries the chapter (§6F.1 rule 4).
      expect(bookAt(fixture.db, null).chapters.find((entry) => entry.n === 3)?.written).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
