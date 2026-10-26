import { describe, expect, it } from 'vitest';

import { computeShares, measureContributions, readSeries } from '../../src/history/erosion.ts';
import { readContributors } from '../../src/history/query.ts';
import { historyFixture, ingest, releaseLease, seedChange } from './helpers.ts';

const INTRO = 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.';
const REWRITTEN = 'Тестовый абзац номер один, изменённый. Это служебный текст, он не является текстом книги.';

function twoReaders(): ReturnType<typeof historyFixture> {
  const fixture = historyFixture();
  const ann = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
  ingest(fixture, 'ch01.md', `Первая\n\n${INTRO}`, new Date('2026-10-25T09:00:00Z'));
  releaseLease(fixture.db, ann.leaseId);
  const mark = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Марк' });
  ingest(fixture, 'ch01.md', `Первая\n\n${REWRITTEN}`, new Date('2026-10-25T10:00:00Z'));
  releaseLease(fixture.db, mark.leaseId);
  return fixture;
}

describe('provenance erosion (§6F.4)', () => {
  it('measures whose text survived, not who tried', () => {
    const fixture = twoReaders();
    try {
      const { totalChars, items } = computeShares(fixture.db);
      expect(totalChars).toBe(REWRITTEN.length);
      const mark = items.find((item) => item.identityId === 'idt_2');
      const ann = items.find((item) => item.identityId === 'idt_1');
      expect(mark).toMatchObject({ edits: 1, chars: REWRITTEN.length, share: 1 });
      // Аня's sentence was rewritten: her characters are gone, her edit is not.
      expect(ann).toMatchObject({ edits: 1, chars: 0, share: 0 });
    } finally {
      fixture.close();
    }
  });

  it('keeps one immutable point per identity per day and appends the next day', () => {
    const fixture = twoReaders();
    try {
      measureContributions(fixture.db, Date.parse('2026-10-25T23:00:00Z'));
      const first = readSeries(fixture.db, 'idt_2');
      expect(first).toEqual([
        { day: '2026-10-25', edits: 1, chars: REWRITTEN.length, share: 1 },
      ]);

      // A second measurement on the same day does not rewrite the row.
      measureContributions(fixture.db, Date.parse('2026-10-25T23:30:00Z'));
      expect(readSeries(fixture.db, 'idt_2')).toEqual(first);

      // The next day's measurement is a new point.
      measureContributions(fixture.db, Date.parse('2026-10-26T23:00:00Z'));
      const series = readSeries(fixture.db, 'idt_2');
      expect(series.map((point) => point.day)).toEqual(['2026-10-25', '2026-10-26']);
      const contributions = fixture.db.prepare('SELECT edits, chars, share FROM contributions WHERE identity_id = ?').get(
        'idt_2',
      ) as { edits: number; chars: number; share: number };
      expect(contributions).toMatchObject({ edits: 1, chars: REWRITTEN.length, share: 1 });
    } finally {
      fixture.close();
    }
  });

  it('serves the current share with its curve and honours an opt-out', () => {
    const fixture = twoReaders();
    try {
      measureContributions(fixture.db, Date.parse('2026-10-25T23:00:00Z'));
      const contributors = readContributors(fixture.db);
      expect(contributors.totalChars).toBe(REWRITTEN.length);
      expect(contributors.measuredAt).toBe('2026-10-25T23:00:00Z');
      expect(contributors.items.map((item) => item.label)).toEqual(expect.arrayContaining(['Марк', 'Аня']));
      expect(contributors.items.find((item) => item.label === 'Марк')?.series).toHaveLength(1);

      fixture.db.prepare('UPDATE identities SET hide_from_authors = 1 WHERE id = ?').run('idt_2');
      expect(readContributors(fixture.db).items.some((item) => item.label === 'Марк')).toBe(false);
      // The measurement itself is untouched by the opt-out (§6C.5).
      expect(readSeries(fixture.db, 'idt_2')).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it('an empty book measures nothing rather than dividing by zero', () => {
    const fixture = historyFixture();
    try {
      expect(computeShares(fixture.db)).toEqual({ totalChars: 0, items: [] });
      expect(measureContributions(fixture.db, Date.parse('2026-10-25T09:00:00Z'))).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
