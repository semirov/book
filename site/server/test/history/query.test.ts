import { describe, expect, it, vi } from 'vitest';

import { startErosionJob } from '../../src/history/erosion.ts';
import { readDiff, readParagraphChain } from '../../src/history/query.ts';
import { lastHseq } from '../../src/history/events.ts';
import { historyFixture, ingest, releaseLease, seedChange } from './helpers.ts';

const A = 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.';
const B = 'Тестовый абзац номер два. Это служебный текст, он не является текстом книги.';
const B2 = 'Тестовый абзац номер два, изменённый. Это служебный текст, он не является текстом книги.';

describe('the paragraph chain of a removed line (§6F.3)', () => {
  it('ends the chain with «убрано», without inventing an heir', () => {
    const fixture = historyFixture();
    try {
      const ann = seedChange(fixture.db, { index: 1, chapter: 4, label: 'Аня' });
      ingest(fixture, 'ch04.md', `Четвёртая\n\n${A}\n\n${B}`, new Date('2026-10-25T09:00:00Z'));
      releaseLease(fixture.db, ann.leaseId);
      const bId = (fixture.db.prepare('SELECT id FROM blocks WHERE chapter = 4 ORDER BY idx DESC LIMIT 1').get() as {
        id: string;
      }).id;

      const mark = seedChange(fixture.db, { index: 2, chapter: 4, label: 'Марк' });
      ingest(fixture, 'ch04.md', `Четвёртая\n\n${A}`, new Date('2026-10-25T10:00:00Z'));
      releaseLease(fixture.db, mark.leaseId);

      const chain = readParagraphChain(fixture.db, bId);
      expect(chain).not.toBeNull();
      expect(chain?.alive).toBe(false);
      expect(chain?.versions.map((version) => version.op)).toEqual(['introduced', 'erased']);
      expect(chain?.line).toMatch(/^убрано в \d{2}:\d{2} правкой 2 \(Марк\) · было: правка 1 \(Аня\)$/u);

      // By uid works as well as by the content-derived id.
      const byUid = readParagraphChain(fixture.db, chain?.blockUid ?? '');
      expect(byUid?.blockUid).toBe(chain?.blockUid);
      expect(readParagraphChain(fixture.db, 'ch99#deadbeef')).toBeNull();
    } finally {
      fixture.close();
    }
  });
});

describe('a paragraph rewritten by the writing process itself (§6F.3)', () => {
  it('names the previous link as «правка N (автор)» when no reader owns it', () => {
    const fixture = historyFixture();
    try {
      // A continuity change: the engine's own pass, with no comment behind it.
      fixture.db
        .prepare(
          `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                                status, enqueued_at)
           VALUES ('chg_c', 'continuity', 7, 'сшить седьмую и восьмую главы', 1, 'sha', '[]', 'phrase',
                   'processing', '2026-10-25T08:00:00Z')`,
        )
        .run();
      fixture.db
        .prepare(
          `INSERT INTO steps (step_id, seq, wave, lane, pass, chapter, boundary, at)
           VALUES ('stp_c1', 1, 1, 'forward', 'change', 7, '7', '2026-10-25T08:50:00Z')`,
        )
        .run();
      fixture.db
        .prepare(
          `INSERT INTO leases (id, step_id, change_id, lane, chapter, is_front, kind, session, expected_rev,
                               acquired_at, heartbeat_at, expires_at)
           VALUES ('lea_c1', 'stp_c1', 'chg_c', 'forward', 7, 0, 'change', 'writer-fwd', 1,
                   '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z', '2026-10-25T23:00:00Z')`,
        )
        .run();
      ingest(fixture, 'ch07.md', 'Седьмая\n\nТестовый абзац номер один. Это служебный текст, он не является текстом книги.', new Date('2026-10-25T09:00:00Z'));
      releaseLease(fixture.db, 'lea_c1');

      fixture.db
        .prepare(
          `INSERT INTO steps (step_id, seq, wave, lane, pass, chapter, boundary, at)
           VALUES ('stp_c2', 1, 1, 'forward', 'change', 7, '7', '2026-10-25T10:00:00Z')`,
        )
        .run();
      fixture.db
        .prepare(
          `INSERT INTO leases (id, step_id, change_id, lane, chapter, is_front, kind, session, expected_rev,
                               acquired_at, heartbeat_at, expires_at)
           VALUES ('lea_c2', 'stp_c2', 'chg_c', 'forward', 7, 0, 'change', 'writer-fwd', 2,
                   '2026-10-25T10:00:00Z', '2026-10-25T10:00:00Z', '2026-10-25T23:00:00Z')`,
        )
        .run();
      ingest(
        fixture,
        'ch07.md',
        'Седьмая\n\nТестовый абзац номер один, изменённый. Это служебный текст, он не является текстом книги.',
        new Date('2026-10-25T10:00:00Z'),
      );

      const blockId = (fixture.db.prepare('SELECT id FROM blocks WHERE chapter = 7').get() as { id: string }).id;
      const chain = readParagraphChain(fixture.db, blockId);
      expect(chain?.line).toMatch(/^переписано в \d{2}:\d{2} правкой 1 \(автор\) · было: правка 1 \(автор\)$/u);
      expect(chain?.versions[1]?.actor).toMatchObject({ kind: 'writer', label: 'автор' });
    } finally {
      fixture.close();
    }
  });
});

describe('the change log of a span (§6F.2)', () => {
  it('lists replacements, additions and removals with their causes', () => {
    const fixture = historyFixture();
    try {
      const ann = seedChange(fixture.db, { index: 1, chapter: 4, label: 'Аня' });
      ingest(fixture, 'ch04.md', `Четвёртая\n\n${A}\n\n${B}`, new Date('2026-10-25T09:00:00Z'));
      releaseLease(fixture.db, ann.leaseId);
      const from = lastHseq(fixture.db);

      const mark = seedChange(fixture.db, { index: 2, chapter: 4, label: 'Марк' });
      ingest(
        fixture,
        'ch04.md',
        `Четвёртая\n\n${A}\n\n${B2}\n\nНовый абзац: служебный текст.`,
        new Date('2026-10-25T10:00:00Z'),
      );
      releaseLease(fixture.db, mark.leaseId);
      const to = lastHseq(fixture.db);

      const diff = readDiff(fixture.db, from, to, 4);
      expect(diff.truncated).toBe(false);
      const reported = diff.ops.map((op) => op.op).sort();
      expect(reported).toContain('added');
      expect(reported).toContain('replaced');
      expect(diff.ops.every((op) => op.chapter === 4)).toBe(true);
      expect(diff.ops.some((op) => op.changeId === 'chg_2')).toBe(true);

      // A span with no events is an empty log, not an error.
      expect(readDiff(fixture.db, to, to, 4).ops).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('reports a plain removal when the paragraph has no heir', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch05.md', `Пятая\n\n${A}\n\n${B}`);
      const from = lastHseq(fixture.db);
      ingest(fixture, 'ch05.md', `Пятая\n\n${A}`);
      const to = lastHseq(fixture.db);
      const diff = readDiff(fixture.db, from, to, 5);
      expect(diff.ops.map((op) => op.op)).toEqual(['removed']);
      expect(diff.ops[0]?.replacedBy).toBeNull();
    } finally {
      fixture.close();
    }
  });
});

describe('the nightly erosion job (§6F.4)', () => {
  it('measures at start, then on its interval, and stops when asked', () => {
    vi.useFakeTimers();
    const fixture = historyFixture();
    try {
      const ann = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `Первая\n\n${A}`, new Date('2026-10-25T09:00:00Z'));
      releaseLease(fixture.db, ann.leaseId);

      const stop = startErosionJob(fixture.db, { now: () => Date.parse('2026-10-25T23:00:00Z'), intervalMs: 1_000 });
      const measured = () =>
        (fixture.db.prepare('SELECT COUNT(*) AS n FROM contribution_history').get() as { n: number }).n;
      expect(measured()).toBe(1);
      vi.advanceTimersByTime(1_000);
      // The same day's row is immutable, so a second run writes nothing new.
      expect(measured()).toBe(1);
      stop();
      vi.advanceTimersByTime(5_000);
      expect(measured()).toBe(1);
    } finally {
      vi.useRealTimers();
      fixture.close();
    }
  });
});
